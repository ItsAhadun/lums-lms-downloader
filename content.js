/*
 * content.js - runs on the /portal/* pages of every LMS host in the manifest
 * (the live lms.lums.edu.pk and the lmsarchive-* hosts).
 *
 * Nothing here names a host. The tab's own origin is the only one whose session
 * cookie this script can use, so every API call and every message about signing
 * in is addressed to location.origin.
 *
 * Two jobs:
 *  1. Relay /direct/* API calls for the popup. These must happen here, where
 *     they are same-origin and the Sakai session cookie is attached.
 *  2. On the Resources tool, inject the "Download all" button, the pre-flight
 *     picker and the progress panel.
 *
 * Downloading itself no longer happens here in either mode. ZIP mode used to
 * build the archive in this page, which meant closing the tab threw it away;
 * it now runs in an offscreen document owned by the service worker, so this
 * file only ever picks files and renders progress.
 *
 * All UI lives in a shadow root: Sakai loads Bootstrap globally and would
 * otherwise restyle the card out from under us.
 */
(function () {
  'use strict';

  const Sakai = globalThis.LUMS.sakai;
  const Progress = globalThis.LUMS.progress;
  const P = globalThis.LUMS.paths;

  // ZIP32 has no 64-bit offsets, so an archive cannot pass 4 GB. Checked here
  // rather than 3 GB into the download, where the only options left are bad.
  const ZIP_LIMIT = 4 * 1024 * 1024 * 1024;
  const ZIP_WARN = 3.5 * 1024 * 1024 * 1024;

  let currentSettings = {};

  /* ---------- 1. popup relay (registered on every /portal/ page) ---------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // The popup only sends to tabs on the origin it wants, but a tab can
    // navigate between the query and the message, and answering for the wrong
    // host would hand back another install's course list.
    if (msg.origin && msg.origin !== location.origin) return false;
    if (msg.type === 'RELAY_SITES') { Sakai.fetchSites(location.origin).then(sendResponse); return true; }
    if (msg.type === 'RELAY_TITLE') { Sakai.fetchSiteTitle(msg.siteId, location.origin).then(sendResponse); return true; }
    if (msg.type === 'RELAY_CONTENT') {
      Sakai.fetchSiteContent(msg.siteId, msg.opts, location.origin).then(sendResponse);
      return true;
    }
    return false;
  });

  /* ---------- 2. Resources tool UI ---------- */

  const siteId = (location.pathname.match(/\/site\/([0-9a-f-]{36})/i) || [])[1];
  if (!siteId) return;

  const isResources = !!document.querySelector('table.resourcesList') ||
    !!document.querySelector('a[href^="#/group/"]');

  if (!isResources) {
    // Only complain when the tool body itself failed to render - otherwise this
    // would nag on every other Sakai tool (Announcements, Gradebook, ...).
    const brokenPage = /\/tool\//.test(location.pathname) &&
      !document.querySelector('.portletBody') && !document.querySelector('.navIntraTool');
    if (brokenPage) console.warn('[LUMS Downloader] Sakai tool body did not render. If you are on Brave, try lowering Shields for ' + location.host + '.');
    return;
  }

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;   // extension reloaded mid-session
        resolve(r || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------- shadow root ---------- */

  const host = document.createElement('div');
  host.id = 'lums-dl-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' + STYLES() + '</style><div id="modal"></div><div id="panel"></div>';
  const $modal = root.getElementById('modal');
  const $panel = root.getElementById('panel');

  /* ---------- toolbar button ---------- */

  const nav = document.querySelector('.navIntraTool');
  const STALE = 'The extension was updated since this page loaded. Reload the page and try again.';

  function toolbarButton(text, title, onClick) {
    const li = document.createElement('li');
    li.className = 'lums-dl-item';
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'lums-dl-btn';
    a.textContent = text;
    a.title = title;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      // Updating or reloading the extension orphans this script: every chrome.*
      // call then throws, and the dialog would sit on its spinner for good.
      if (!(chrome.runtime && chrome.runtime.id)) return showModalText(STALE);
      Promise.resolve().then(onClick).catch((err) => {
        showModalText(chrome.runtime && chrome.runtime.id
          ? 'Something went wrong: ' + String((err && err.message) || err)
          : STALE);
      });
    });
    li.appendChild(a);
    if (nav) nav.appendChild(li); else document.body.appendChild(li);
  }

  toolbarButton('⤓ Download all', 'Download this course’s Resources', openPreflight);

  /* Everything sync does happens in this page's own modal; see below. */
  toolbarButton(
    '⇅ Sync folder',
    'Fetch only the files missing from a folder you keep this course in',
    openSync
  );

  toolbarButton(
    '⇅ Sync all',
    'Fetch what every course folder in your semester folder is missing',
    openSyncAll
  );

  /* ---------- pre-flight picker ---------- */

  let courseTitle = '';

  function describeError(content) {
    if (content.error === 'auth') return 'Your LMS session has expired. Sign in to ' + esc(location.host) + ' and try again.';
    if (content.error === 'network') return 'Could not reach the LMS: ' + esc(content.message || 'network error');
    if (content.error === 'empty') {
      const sk = content.skipped;
      return 'No resources visible in this course.' +
        (sk && sk.hidden ? ' (' + sk.hidden + ' hidden item(s) were skipped — you can include them in the extension settings.)' : '');
    }
    return null;
  }

  /* One manifest load shared by the toolbar button and the per-row actions.
   * Deliberately not cached: the response is small, and a stale tree is worse
   * than a second request. Returns null after showing the reason. */
  async function loadContent() {
    showModalText('Reading course contents…', true);
    const st = await send({ type: 'GET_STATE' });
    currentSettings = st.settings || {};
    const [content, title] = await Promise.all([
      Sakai.fetchSiteContent(siteId, currentSettings, location.origin),
      Sakai.fetchSiteTitle(siteId, location.origin)
    ]);
    const problem = describeError(content);
    if (problem) { showModalMessage(problem); return null; }
    courseTitle = (title && title.title) || siteId;
    return content;
  }

  async function openPreflight() {
    const content = await loadContent();
    if (content) renderPicker(content);
  }

  /* showModalMessage takes HTML because two callers assemble it. Everything
   * that just shows a string should use showModalText, so a filename can never
   * become markup by accident. */
  function showModalMessage(html, busy) {
    $modal.innerHTML =
      '<div class="overlay"><div class="card msg">' +
      '<div class="msgtext">' + (busy ? '<span class="spin"></span>' : '') + html + '</div>' +
      '<div class="row end"><button class="btn" data-act="close">Close</button></div>' +
      '</div></div>';
    $modal.querySelector('[data-act="close"]').onclick = closeModal;
  }

  function showModalText(text, busy) { showModalMessage(esc(text), busy); }

  function closeModal() { $modal.innerHTML = ''; }

  function renderPicker(content) {
    const items = content.items;
    const selected = new Set(items.map((_, i) => i));

    // Group by folder. Sakai courses are shallow, so a sorted flat list of
    // folders reads better than a nested tree and needs far less code.
    const folders = new Map();
    items.forEach((it, i) => {
      const f = it.folder || '';
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f).push(i);
    });
    const folderList = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    const types = [...new Set(items.map(typeLabel))].sort();

    $modal.innerHTML =
      '<div class="overlay"><div class="card">' +
        '<div class="head">' +
          '<div><div class="title">Download resources</div>' +
          '<div class="sub">' + esc(courseTitle) + '</div></div>' +
          '<button class="x" data-act="close" title="Close">×</button>' +
        '</div>' +
        (types.length > 1 ? '<div class="chips">' + types.map((t) =>
          '<label class="chip"><input type="checkbox" data-type="' + esc(t) + '" checked> ' + esc(t) + '</label>').join('') + '</div>' : '') +
        '<div class="tree">' + folderList.map(([name, idxs]) =>
          '<div class="folder">' +
            '<label class="frow"><input type="checkbox" class="fchk" data-folder="' + esc(name) + '" checked>' +
            '<span class="fname">' + esc(name || '(course root)') + '</span>' +
            '<span class="fcount">' + idxs.length + '</span></label>' +
            idxs.map((i) =>
              '<label class="irow" data-idx="' + i + '"><input type="checkbox" class="ichk" data-idx="' + i + '" checked>' +
              '<span class="iname">' + esc(items[i].title || items[i].rel) + '</span>' +
              '<span class="isize">' + Progress.formatBytes(items[i].bytes) + '</span></label>'
            ).join('') +
          '</div>').join('') +
        '</div>' +
        '<div class="foot">' +
          '<div class="tally" id="tally"></div>' +
          '<div class="row">' +
            '<button class="btn" data-act="close">Cancel</button>' +
            '<button class="btn primary" data-act="go">Download</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    const tally = $modal.querySelector('#tally');
    const refresh = () => {
      let bytes = 0;
      selected.forEach((i) => { bytes += items[i].bytes; });

      // Everything past a single file ships as one archive, so the 4 GB ceiling
      // applies to exactly the selections that will become one.
      const zipMode = selected.size > 1;
      const tooBig = zipMode && bytes >= ZIP_LIMIT;
      tally.textContent = selected.size + ' of ' + items.length + ' files · ' + Progress.formatBytes(bytes) +
        (tooBig ? ' · over the 4 GB ZIP limit'
                : (zipMode && bytes >= ZIP_WARN) ? ' · close to the 4 GB ZIP limit' : '');
      tally.className = 'tally' + (zipMode && bytes >= ZIP_WARN ? ' warn' : '');

      $modal.querySelector('[data-act="go"]').disabled = selected.size === 0 || tooBig;
      $modal.querySelectorAll('.fchk').forEach((c) => {
        const idxs = folders.get(c.dataset.folder);
        const on = idxs.filter((i) => selected.has(i)).length;
        c.checked = on === idxs.length;
        c.indeterminate = on > 0 && on < idxs.length;
      });
    };

    const setItem = (i, on) => {
      if (on) selected.add(i); else selected.delete(i);
      const box = $modal.querySelector('.ichk[data-idx="' + i + '"]');
      if (box) box.checked = on;
    };

    $modal.querySelectorAll('.ichk').forEach((c) => {
      c.onchange = () => { setItem(Number(c.dataset.idx), c.checked); refresh(); };
    });
    $modal.querySelectorAll('.fchk').forEach((c) => {
      c.onchange = () => {
        folders.get(c.dataset.folder).forEach((i) => setItem(i, c.checked));
        refresh();
      };
    });
    $modal.querySelectorAll('[data-type]').forEach((c) => {
      c.onchange = () => {
        items.forEach((it, i) => { if (typeLabel(it) === c.dataset.type) setItem(i, c.checked); });
        refresh();
      };
    });

    $modal.querySelectorAll('[data-act="close"]').forEach((b) => { b.onclick = closeModal; });
    $modal.querySelector('[data-act="go"]').onclick = () => {
      deliver(items.filter((_, i) => selected.has(i)), '');
    };

    refresh();
  }

  function typeLabel(item) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(item.rel || '');
    return m ? m[1].toLowerCase() : 'other';
  }

  /* ---------- progress panel ---------- */

  let timer = null;
  let hidden = false;   // card dismissed while its job is still running
  let syncJob = null;   // a folder sync owns the panel while this one runs

  function startPolling() {
    hidden = false;
    if (timer) return;
    tick();
    timer = setInterval(tick, 400);
  }

  function stopPolling() {
    clearInterval(timer);
    timer = null;
  }

  async function tick() {
    if (syncJob && syncJob.state === 'running') return;
    if (hidden) { $panel.innerHTML = ''; stopPolling(); return; }
    const st = await send({ type: 'GET_STATE' });
    if (!st.ok) return;
    currentSettings = st.settings || currentSettings;
    // A course archived from a past semester can carry the same site id on both
    // hosts, so the origin is part of matching a job to this page.
    const job = [...(st.jobs || [])].reverse()
      .find((j) => j.siteId === siteId && (!j.origin || j.origin === location.origin));
    if (!job) { $panel.innerHTML = ''; stopPolling(); return; }
    renderPanel(job, st.live || {});
    // Keep polling while the archive is still being written to disk.
    const saving = job.archive && job.archive.state === 'saving';
    if ((job.state === 'done' || job.state === 'cancelled') && !saving) stopPolling();
  }

  function headline(job) {
    if (job.state === 'cancelled') return 'Cancelled';
    if (job.state === 'done') return job.fatal ? 'Stopped' : 'Finished';
    if (job.state === 'paused') return 'Paused';
    if (job.phase === 'archiving') return 'Building archive';
    if (job.phase === 'syncing') return 'Syncing';
    return 'Downloading';
  }

  function noteFor(job) {
    if (job.fatal) return { cls: 'bad', text: fatalText(job.fatal) };
    if (job.error) return { cls: 'bad', text: job.error };
    if (job.archive && job.archive.state === 'failed') {
      return { cls: 'bad', text: 'Could not save the archive: ' + (job.archive.error || 'unknown error') };
    }
    if (job.archive && job.archive.state === 'saving') return { cls: '', text: 'Saving the archive…' };
    return null;
  }

  function fatalText(f) {
    if (f === 'auth') return 'Your LMS session has expired. Sign in to ' + location.host + ' and retry.';
    if (f === 'toobig') return 'The archive hit the 4 GB ZIP limit. Download this course in smaller parts.';
    return String(f);
  }

  /* `own` replaces the worker-backed actions for a run this page drives itself
   * (a folder sync). Only the buttons it supplies are drawn. */
  function renderPanel(job, live, own) {
    const p = Progress.jobProgress(job, live);
    const finished = job.state === 'done' || job.state === 'cancelled';
    const note = noteFor(job);

    const rows = job.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.state !== 'pending')
      .slice(-6)
      .map(({ it }) => {
        const pctv = Progress.itemPercent(it, live);
        const cls = it.state === 'failed' ? 'bad' : (it.state === 'done' ? 'ok' : '');
        const tail = it.state === 'done' ? 'done'
          : it.state === 'failed' ? 'failed'
          : it.state === 'cancelled' ? 'cancelled'
          : pctv + '%';
        // The reason a file failed is the whole value of knowing it failed.
        const hint = it.error ? it.rel + ' — ' + it.error : it.rel;
        return '<div class="frow2 ' + cls + '">' +
          '<span class="fn" title="' + esc(hint) + '">' + esc(it.title || it.rel) + '</span>' +
          '<span class="fb"><i style="width:' + pctv + '%"></i></span>' +
          '<span class="ft">' + tail + '</span></div>';
      }).join('');

    const act = own || {
      pause: () => send({ type: 'PAUSE', jobId: job.id }),
      resume: () => send({ type: 'RESUME', jobId: job.id }).then(startPolling),
      cancel: () => send({ type: 'CANCEL', jobId: job.id }),
      retry: () => send({ type: 'RETRY_FAILED', jobId: job.id }).then(startPolling),
      folder: () => send({ type: 'SHOW_DOWNLOADS' }),
      // Only forget a job that has stopped. Dismissing a running one just hides
      // the card - the download keeps going and the popup still tracks it.
      dismiss: async () => {
        if (finished) await send({ type: 'DISMISS_JOB', jobId: job.id });
        else hidden = true;
        $panel.innerHTML = '';
        stopPolling();
      }
    };
    const btn = (name, label) => act[name] ? '<button class="btn" data-act="' + name + '">' + label + '</button>' : '';

    $panel.innerHTML =
      '<div class="card panel">' +
        '<div class="phead">' +
          '<span class="ptitle">' + esc(headline(job)) + ' — ' + esc(job.siteTitle) + '</span>' +
          '<button class="x" data-act="dismiss" title="Dismiss">×</button>' +
        '</div>' +
        '<div class="bar"><i style="width:' + p.percent + '%"></i></div>' +
        '<div class="line">' + (finished ? esc(Progress.summaryLine(job)) : esc(Progress.progressLine(p)) + ' · ' + p.percent + '%') + '</div>' +
        (note ? '<div class="note ' + note.cls + '">' + esc(note.text) + '</div>' : '') +
        (rows ? '<div class="rows">' + rows + '</div>' : '') +
        '<div class="row end">' +
          (finished
            ? (p.failed || p.cancelled ? btn('retry', 'Retry failed') : '') + btn('folder', 'Open folder')
            : (job.state === 'paused' ? btn('resume', 'Resume') : btn('pause', 'Pause')) + btn('cancel', 'Cancel')) +
        '</div>' +
      '</div>';

    $panel.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => { act[b.dataset.act](); tick(); };
    });
  }

  /* Hand a selection to the service worker. The worker picks the mode from the
   * item count - more than one file is always one archive. */
  /* `extra` overrides fields of the job request (Sync all names its archive). */
  async function deliver(items, scopeLabel, extra) {
    if (items.length > 1) {
      let bytes = 0;
      for (const it of items) bytes += it.bytes;
      if (bytes >= ZIP_LIMIT) {
        return showModalText(
          'That selection is ' + Progress.formatBytes(bytes) + ', past the 4 GB limit a ZIP archive can address. ' +
          'Download it as a few smaller selections instead - one folder at a time, or a subset of the files here.');
      }
    }
    closeModal();
    syncJob = null;
    const r = await send(Object.assign(
      { type: 'START_JOB', origin: location.origin, siteId, siteTitle: courseTitle, scopeLabel, items }, extra));
    if (!r.ok) return showModalText('Could not start the download: ' + (r.error || 'unknown error'));
    startPolling();
  }

  // A job may already be running for this course (page reloaded mid-download).
  tick();

  /* ---------- sync a folder ---------- */

  /* Syncing happens here rather than in a tab of its own. This page already
   * knows which course it is and already has a modal; opening a second tab to
   * answer "what am I missing" was the slowest part of asking.
   *
   * The folder is remembered against this course, so the first sync explains
   * itself and asks for a folder, and every one after it goes straight to the
   * answer. The handle lives in this origin's IndexedDB, which is the LMS
   * host's: a handle cannot travel through chrome.runtime messaging, so the
   * extension's own sync page keeps a separate one.
   */
  const F = globalThis.LUMS.folder;
  const SyncPlan = globalThis.LUMS.sync;

  let syncDir = null;      // granted directory handle, on browsers that have one
  let syncLocal = null;    // folder listing from an <input>, on browsers that do not
  let syncLabel = '';
  let syncMissing = [];
  let syncStop = false;
  let syncAll = false;     // which dialog the shared steps below belong to

  const haveSyncFolder = () => !!(syncDir || syncLocal);

  async function ensureCourseTitle() {
    if (courseTitle) return;
    const t = await Sakai.fetchSiteTitle(siteId, location.origin);
    if (t && t.title) courseTitle = t.title;
  }

  /* One card shape for every step, so the dialog does not jump around as it
   * moves from explaining to comparing to listing what it found. */
  function syncCard(body, foot, closable) {
    $modal.innerHTML =
      '<div class="overlay"><div class="card">' +
        '<div class="head">' +
          '<div><div class="title">' + (syncAll ? 'Sync all' : 'Sync folder') + '</div>' +
          '<div class="sub">' + esc(syncAll ? syncLabel || 'every course' : courseTitle || 'this course') + '</div></div>' +
          (closable ? '<button class="x" data-act="close" title="Close">×</button>' : '') +
        '</div>' + body +
        '<div class="row end">' + foot + '</div>' +
      '</div></div>';

    const on = (act, fn) => {
      const el = $modal.querySelector('[data-act="' + act + '"]');
      if (el) el.onclick = fn;
      return el;
    };
    on('close', closeModal);
    on('pick', choosePick);
    on('change', () => (syncAll ? askSemester(null) : showExplainer(null)));
    on('compare', () => (syncAll ? runCompareAll() : runCompare()));
    on('pickall', pickSemester);
    on('download', runSyncDownload);

    const input = $modal.querySelector('[data-act="pickinput"]');
    if (input) input.onchange = (e) => takeSyncListing(e.target.files);
    const allInput = $modal.querySelector('[data-act="pickallinput"]');
    if (allInput) allInput.onchange = (e) => takeSemesterListing(e.target.files);
  }

  // A directory <input> is the only folder picker left when the File System
  // Access API is off, so the control differs even though the step does not.
  function pickerButton(label) {
    return F.supported()
      ? '<button class="btn primary" data-act="pick">' + esc(label) + '</button>'
      : '<label class="btn primary">' + esc(label) +
        '<input type="file" data-act="pickinput" webkitdirectory directory multiple hidden></label>';
  }

  /* Why a folder cannot be written into or remembered here. Brave turns the
   * API off behind a flag; Chrome, Edge, Opera and Vivaldi ship it on, so any
   * other browser without it has no switch worth naming. */
  function noFolderAccess() {
    return navigator.brave
      ? '<b>Brave turns off the File System Access API</b>, so the extension cannot write ' +
        'into your folder or remember which one it is. To fix that, enable the <b>File System ' +
        'Access API</b> flag in brave://flags and restart Brave.'
      : '<b>This browser does not offer the File System Access API</b>, so the extension cannot ' +
        'write into your folder or remember which one it is. Chrome and Edge have it.';
  }

  function showExplainer(note) {
    const body = F.supported()
      ? '<div class="note">Point this at the folder where you keep this course. Every file ' +
        'the LMS has and that folder does not comes down into it. Files already there stay ' +
        'untouched, and anything of your own the LMS never had is ignored.' +
        '<br><br>The folder is remembered, so every sync after this one goes straight to the ' +
        'answer.</div>'
      : '<div class="note">' + noFolderAccess() + '<br><br>Picking the folder still works out ' +
        'what is missing, and those files arrive as one ZIP to extract over the folder. The ' +
        'folder never leaves your machine: only its list of filenames is read.</div>';

    syncCard(
      body + (note ? '<div class="note bad">' + esc(note) + '</div>' : ''),
      '<button class="btn" data-act="close">Cancel</button>' + pickerButton('Choose folder'),
      true
    );
  }

  async function choosePick() {
    let handle;
    try {
      handle = await F.pick();
    } catch (e) {
      if (e && e.aborted) return;   // changed their mind; nothing to say
      return showExplainer('This browser would not open a folder: ' + e.message);
    }
    if (!(await F.grant(handle))) {
      return showExplainer('Without write access to that folder there is nowhere to put the missing files.');
    }
    syncDir = handle;
    syncLocal = null;
    syncLabel = handle.name;
    await F.remember(location.origin, siteId, handle);
    runCompare();
  }

  function takeSyncListing(fileList) {
    if (!fileList || !fileList.length) return;
    syncLocal = F.listing(fileList);
    syncDir = null;
    syncLabel = F.listingRoot(fileList) || 'that folder';
    runCompare();
  }

  async function openSync() {
    syncAll = false;
    syncStop = false;
    showModalText('Opening…', true);
    await ensureCourseTitle();

    if (!F.supported()) return showExplainer(null);

    const handle = await F.recall(location.origin, siteId);
    if (!handle) return showExplainer(null);

    if (await F.permissionState(handle) === 'granted') {
      syncDir = handle;
      syncLabel = handle.name;
      return runCompare();
    }

    // Remembered, but the browser dropped write access when it restarted. One
    // click gets it back, which beats hunting for the folder again.
    syncCard(
      '<div class="note">Last time you synced this course to <b>' + esc(handle.name) + '</b>. ' +
      'Chrome drops write access to a folder when it restarts, so it needs confirming again.</div>',
      '<button class="btn" data-act="change">Choose a different folder</button>' +
      '<button class="btn primary" data-act="reconnect">Use ' + esc(handle.name) + '</button>',
      true
    );
    const btn = $modal.querySelector('[data-act="reconnect"]');
    if (btn) {
      btn.onclick = async () => {
        if (!(await F.grant(handle))) return showExplainer('Write access to that folder was refused.');
        syncDir = handle;
        syncLabel = handle.name;
        runCompare();
      };
    }
  }

  async function runCompare() {
    if (!haveSyncFolder()) return showExplainer(null);
    showModalText('Comparing this course against ' + (syncLabel || 'your folder') + '…', true);

    const content = await loadContent();   // reports its own problems
    if (!content) return;

    let local;
    try {
      local = syncLocal || await F.scan(syncDir);
    } catch (e) {
      return showExplainer('Could not read that folder: ' + String((e && e.message) || e));
    }

    const plan = SyncPlan.plan(content.items, SyncPlan.indexLocal(local));
    syncMissing = plan.missing;
    renderSyncResult(content.items.length, plan.present.length, local.length);
  }

  function renderSyncResult(onLms, present, scanned) {
    let bytes = 0;
    for (const it of syncMissing) bytes += it.bytes;

    const updated = syncMissing.filter((it) => it.replaces).length;
    const counts = '<div class="note"><b>' + onLms + '</b> on the LMS · <b>' + present +
      '</b> already in ' + esc(syncLabel) + ' · <b>' + (syncMissing.length - updated) + '</b> missing' +
      (updated ? ' · <b>' + updated + '</b> changed on the LMS' : '') + '</div>';

    const list = syncMissing.length
      ? '<div class="tree">' + syncMissing.map((it, i) =>
          '<div class="irow" data-i="' + i + '"><span class="iname">' + esc(it.replaces || it.rel) + '</span>' +
          '<span class="isize">' + (it.replaces ? 'newer on LMS · ' : '') +
          esc(Progress.formatBytes(it.bytes)) + '</span></div>').join('') + '</div>'
      : '<div class="note ok">Nothing to do. That folder already has every file the LMS is showing.</div>';

    const download = syncMissing.length
      ? '<button class="btn primary" data-act="download">Download ' + syncMissing.length +
        (updated ? ' file' : ' missing file') + (syncMissing.length === 1 ? '' : 's') +
        (F.supported() ? '' : ' as a ZIP') + (bytes ? ' · ' + esc(Progress.formatBytes(bytes)) : '') +
        '</button>'
      : '';

    syncCard(
      counts + list +
      '<div class="note">' + scanned + ' file(s) scanned. A file counts as already there when ' +
      'its name turns up anywhere inside the folder, at any depth, so anything you moved or ' +
      'filed away yourself is left alone. A copy older than the LMS file and a different ' +
      'size gets replaced where it sits.</div>',
      '<button class="btn" data-act="change">Change folder</button>' +
      '<button class="btn" data-act="compare">Check again</button>' + download,
      true
    );
  }

  /* Without a directory handle there is nowhere to write, so the missing items
   * go through the ordinary download queue instead and arrive as one archive.
   * deliver() already owns the size check, the job and the progress panel.
   *
   * With one, the files are fetched and written right here, but shown in the
   * same bottom-right panel as a queued download: the run is shaped like a
   * worker job, with byte counts in a `live` map keyed the same way. */
  async function runSyncDownload() {
    if (!F.supported() || !syncDir) {
      if (!syncAll) return deliver(syncMissing, 'missing files');
      // A changed file takes the path of the copy it replaces, so extracting
      // overwrites that copy wherever it was filed.
      return deliver(syncMissing.map((it) => (it.replaces ? Object.assign({}, it, { rel: it.replaces }) : it)), '',
        { siteTitle: syncLabel, archiveName: syncLabel + ' - sync' });
    }
    if (syncJob && syncJob.state === 'running') return showModalText('A sync is still running. Let it finish first.');

    const items = syncMissing;
    const dir = syncDir;
    const again = syncAll ? runCompareAll : runCompare;
    syncStop = false;
    closeModal();

    const taken = new Set();
    // The same names the archive builder gives, so a folder filled by one route
    // and topped up by the other holds one copy of each file rather than two.
    const targets = items.map((it) => it.replaces || P.uniqueName(taken, P.downloadPath('', '', it.rel)));

    const job = {
      siteTitle: syncLabel,
      state: 'running',
      phase: 'syncing',
      fatal: null,
      items: items.map((it, i) => ({
        title: it.title, rel: it.rel, bytes: it.bytes, state: 'pending', error: null, downloadId: 'sync:' + i
      }))
    };
    const live = {};
    syncJob = job;

    const paint = () => {
      if (syncJob !== job) return;   // dismissed
      const t = { files: job.items.length, bytes: 0, doneFiles: 0, doneBytes: 0, failed: 0, cancelled: 0 };
      for (const it of job.items) {
        t.bytes += it.bytes;
        if (it.state === 'done') { t.doneFiles++; t.doneBytes += it.bytes; }
        if (it.state === 'failed') t.failed++;
        if (it.state === 'cancelled') t.cancelled++;
      }
      job.totals = t;
      renderPanel(job, live, {
        cancel: () => { syncStop = true; },
        retry: again,
        dismiss: () => { syncJob = null; $panel.innerHTML = ''; }
      });
    };
    const timer = setInterval(paint, 400);
    paint();

    let next = 0;
    async function worker() {
      for (;;) {
        // One expired session fails every remaining file identically, so the
        // first to say so stops the rest.
        if (syncStop || job.fatal) return;
        const i = next++;
        if (i >= items.length) return;
        const it = job.items[i];
        it.state = 'active';
        try {
          await F.fetchInto(dir, targets[i], items[i], (n) => { live[it.downloadId] = { received: n, total: it.bytes }; });
          it.state = 'done';
        } catch (e) {
          it.state = 'failed';
          it.error = String((e && e.message) || e);
          if (e && e.auth) job.fatal = 'auth';
        }
      }
    }

    const conc = Math.max(1, Math.min(5, Number(currentSettings.concurrency) || 3));
    await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));

    for (const it of job.items) if (it.state === 'pending') it.state = job.fatal ? 'failed' : 'cancelled';
    job.state = syncStop ? 'cancelled' : 'done';
    clearInterval(timer);
    paint();
  }

  /* ---------- sync all ---------- */

  /* Every course at once, against one semester folder that holds a folder per
   * course, named the way the course archives name them (lib/sync.js
   * courseFolder). Picked once, then remembered; the popup's settings forget
   * it, which is how it gets changed. The handle sits in this origin's
   * IndexedDB like a course's, and its name in chrome.storage so the popup can
   * show it. Files go straight into the course folders, so this needs the
   * File System Access API: without it there is no folder to remember. */
  const SEMESTER_KEY = 'lums:semesterFolder';
  const SEMESTER_ID = '*semester';   // IndexedDB slot; no site id starts with *

  async function openSyncAll() {
    syncAll = true;
    syncStop = false;
    syncDir = null;
    syncLocal = null;
    syncLabel = '';
    showModalText('Opening…', true);

    if (!F.supported()) return askSemester(null);

    const stored = await chrome.storage.local.get(SEMESTER_KEY);
    const handle = stored[SEMESTER_KEY] ? await F.recall(location.origin, SEMESTER_ID) : null;
    if (!handle) return askSemester(null);

    syncLabel = handle.name;
    if (await F.permissionState(handle) === 'granted') {
      syncDir = handle;
      return runCompareAll();
    }

    // Chrome drops write access on restart; one click gets it back.
    syncCard(
      '<div class="note">Chrome drops write access to a folder when it restarts, so ' +
      '<b>' + esc(handle.name) + '</b> needs confirming again.</div>',
      '<button class="btn" data-act="change">Choose a different folder</button>' +
      '<button class="btn primary" data-act="reconnect">Use ' + esc(handle.name) + '</button>',
      true
    );
    const btn = $modal.querySelector('[data-act="reconnect"]');
    if (btn) {
      btn.onclick = async () => {
        if (!(await F.grant(handle))) return askSemester('Write access to that folder was refused.');
        syncDir = handle;
        runCompareAll();
      };
    }
  }

  /* Without the File System Access API this still works, one step longer: the
   * folder is read through a directory <input> each time, and the files arrive
   * as one ZIP whose entries start with their course folder, to extract inside
   * the semester folder. */
  function askSemester(note) {
    const fsa = F.supported();
    syncCard(
      '<div class="note">Point this at your semester folder, the one that holds a folder per ' +
      'course (extracting each course\'s ZIP there sets that up). Every course with a folder ' +
      'there gets compared against the LMS. Folders that match no course are left alone.' +
      (fsa
        ? ' Whatever is missing or changed goes straight into its course folder.<br><br>The ' +
          'folder is remembered. Change it later under Settings in the extension popup.'
        : '<br><br>' + noFolderAccess() + ' So the folder gets picked each time, and the files ' +
          'arrive as one ZIP: extract it inside the semester folder and each file lands in its ' +
          'course folder. Only file names, sizes and dates are read.') +
      '</div>' +
      (note ? '<div class="note bad">' + esc(note) + '</div>' : ''),
      '<button class="btn" data-act="close">Cancel</button>' +
      (fsa
        ? '<button class="btn primary" data-act="pickall">Choose folder</button>'
        : '<label class="btn primary">Choose folder' +
          '<input type="file" data-act="pickallinput" webkitdirectory directory multiple hidden></label>'),
      true
    );
  }

  // A listing's paths start with the picked folder's own name; scan() paths do not.
  function takeSemesterListing(fileList) {
    if (!fileList || !fileList.length) return;
    syncLabel = F.listingRoot(fileList) || 'that folder';
    syncLocal = F.listing(fileList).map((f) =>
      Object.assign({}, f, { path: f.path.split('/').slice(1).join('/') }));
    runCompareAll();
  }

  async function pickSemester() {
    let handle;
    try {
      handle = await F.pick();
    } catch (e) {
      if (e && e.aborted) return;
      return askSemester('This browser would not open a folder: ' + e.message);
    }
    if (!(await F.grant(handle))) return askSemester('Without write access to that folder there is nowhere to put the files.');
    await F.remember(location.origin, SEMESTER_ID, handle);
    await chrome.storage.local.set({ [SEMESTER_KEY]: { name: handle.name } });
    syncDir = handle;
    syncLabel = handle.name;
    runCompareAll();
  }

  async function runCompareAll() {
    showModalText('Comparing every course against ' + syncLabel + '…', true);

    const st = await send({ type: 'GET_STATE' });
    currentSettings = st.settings || currentSettings;

    let files;
    try {
      files = syncLocal || await F.scan(syncDir);
    } catch (e) {
      return askSemester('Could not read ' + syncLabel + ': ' + String((e && e.message) || e));
    }
    const folders = SyncPlan.byFolder(files);

    const sites = await Sakai.fetchSites(location.origin);
    if (!sites || !sites.sites) {
      return syncCard(
        '<div class="note bad">' + (describeError(sites || {}) || 'Could not load your courses.') + '</div>',
        '<button class="btn" data-act="close">Close</button>' +
        '<button class="btn primary" data-act="compare">Check again</button>',
        true
      );
    }

    // Past semesters share no folder names with this one, so they drop out here.
    const matched = [];
    for (const s of sites.sites) {
      const f = folders.get(SyncPlan.courseFolder(s.title).toLowerCase());
      if (f && !f.site) { f.site = s; matched.push(f); }
    }
    const strays = [...folders.values()].filter((f) => !f.site).map((f) => f.name);

    const results = await Promise.all(matched.map(async (f) => {
      const content = await Sakai.fetchSiteContent(f.site.id, currentSettings, location.origin);
      if (content && content.error === 'empty') return { f, items: [] };
      if (!content || !content.items) return { f, error: (content && describeError(content)) || 'The LMS did not answer.' };
      // Paths become relative to the semester folder, which is what gets written into.
      const plan = SyncPlan.plan(content.items, SyncPlan.indexLocal(f.files));
      return {
        f,
        items: plan.missing.map((it) => Object.assign({}, it, {
          rel: f.name + '/' + it.rel,
          replaces: it.replaces ? f.name + '/' + it.replaces : undefined
        }))
      };
    }));

    syncMissing = [];
    for (const r of results) if (r.items) syncMissing.push(...r.items);
    renderSyncAll(results, strays);
  }

  function renderSyncAll(results, strays) {
    let bytes = 0;
    for (const it of syncMissing) bytes += it.bytes;
    const changed = syncMissing.filter((it) => it.replaces).length;

    // describeError hands back markup that is already escaped.
    const rows = results.map((r) => {
      const n = r.items ? r.items.length : 0;
      const ch = r.items ? r.items.filter((it) => it.replaces).length : 0;
      const what = r.error ? r.error
        : !n ? 'up to date'
        : esc([n - ch ? (n - ch) + ' missing' : '', ch ? ch + ' changed' : ''].filter(Boolean).join(' · '));
      return '<div class="irow"><span class="iname">' + esc(r.f.name) + '</span>' +
        '<span class="isize">' + what + '</span></div>';
    }).join('');

    syncCard(
      '<div class="note"><b>' + results.length + '</b> course folder(s) · <b>' + (syncMissing.length - changed) +
      '</b> missing · <b>' + changed + '</b> changed on the LMS</div>' +
      (results.length
        ? '<div class="tree">' + rows + '</div>'
        : '<div class="note bad">No folder in ' + esc(syncLabel) + ' matches a course on ' + esc(location.host) + '.</div>') +
      (results.length && !syncMissing.length
        ? '<div class="note ok">Every course folder has every file the LMS is showing.</div>' : '') +
      (strays.length ? '<div class="note">Not a course, left alone: ' + esc(strays.join(', ')) + '.</div>' : ''),
      '<button class="btn" data-act="compare">Check again</button>' +
      (syncMissing.length
        ? '<button class="btn primary" data-act="download">Download ' + syncMissing.length + ' file' +
          (syncMissing.length === 1 ? '' : 's') + (bytes ? ' · ' + esc(Progress.formatBytes(bytes)) : '') + '</button>'
        : ''),
      true
    );
  }

  /* ---------- per-row "Actions → Download" ---------- */

  const REF_RE = new RegExp('/(?:access/content/)?group/' + siteId + '/[^"\'?\\s>]*');

  /* Each row carries its own resource path inside an attribute (href, name or
   * onclick), in either the /group/... or /access/content/group/... form.
   * A collapsed folder has it ONLY there - its visible link is just "#" - which
   * is why the attributes are scanned rather than the rendered markup. */
  function resourceRef(row) {
    for (const el of [row, ...row.querySelectorAll('*')]) {
      for (const attr of el.attributes) {
        const m = REF_RE.exec(attr.value);
        if (m) return m[0].replace(/^\/access\/content/, '');
      }
    }
    return null;
  }

  /* A trailing slash means a collection. Because the API returns the whole tree
   * flat, every descendant of a folder is just a path-prefix match - so a folder
   * download picks up nested subfolders without any extra requests. */
  async function downloadRef(ref) {
    const isFolder = ref.endsWith('/');
    const target = '/access/content' + ref;

    const content = await loadContent();
    if (!content) return;

    const picked = content.items.filter((it) =>
      isFolder ? it.path.indexOf(target) === 0 : it.path === target);

    if (!picked.length) {
      return showModalText(isFolder
        ? 'That folder has no downloadable files. It may be empty, or its contents may be hidden.'
        : 'That item could not be matched to a downloadable file.');
    }

    const scope = ref.replace('/group/' + siteId + '/', '').replace(/\/$/, '');
    await deliver(picked, scope ? decodeURIComponent(scope.split('/').pop()) : '');
  }

  function injectRowActions() {
    document.querySelectorAll('table.resourcesList ul.dropdown-menu').forEach((menu) => {
      if (menu.querySelector('.lums-row-dl')) return;
      const row = menu.closest('tr');
      if (!row) return;
      const ref = resourceRef(row);
      if (!ref) return;

      const a = document.createElement('a');
      a.className = 'dropdown-item lums-row-dl';
      a.href = '#';
      a.textContent = ref.endsWith('/') ? '⤓ Download folder' : '⤓ Download';
      a.addEventListener('click', (e) => { e.preventDefault(); downloadRef(ref); });

      const li = document.createElement('li');
      li.appendChild(a);
      menu.appendChild(li);
    });
  }

  // Expanding or collapsing a folder re-renders rows, so re-inject on change.
  // injectRowActions is idempotent, so its own insertions settle after one pass.
  let injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    setTimeout(() => { injectPending = false; injectRowActions(); }, 50);
  }

  injectRowActions();
  const table = document.querySelector('table.resourcesList');
  if (table) new MutationObserver(scheduleInject).observe(table, { childList: true, subtree: true });

  /* ---------- styles (scoped to the shadow root) ---------- */

  function STYLES() {
    return `
:host, * { box-sizing: border-box; }
.overlay { position: fixed; inset: 0; background: rgba(15,23,42,.45);
  display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
.card { background: #fff; color: #0f172a; border-radius: 10px; width: 620px; max-width: 92vw;
  max-height: 84vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 18px 48px rgba(2,6,23,.34);
  font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.card.msg { width: 440px; }
.msgtext { padding: 22px 20px 8px; }
.head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid #e2e8f0; }
.title { font-size: 15px; font-weight: 650; }
.sub { color: #64748b; font-size: 12px; margin-top: 2px; }
.x { margin-left: auto; border: 0; background: none; font-size: 20px; line-height: 1;
  color: #94a3b8; cursor: pointer; padding: 0 2px; }
.x:hover { color: #0f172a; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 18px; border-bottom: 1px solid #f1f5f9; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 9px;
  border: 1px solid #cbd5e1; border-radius: 999px; cursor: pointer; }
.tree { overflow: auto; padding: 6px 8px; flex: 1; }
.folder { margin-bottom: 6px; }
.frow, .irow { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.frow { font-weight: 600; background: #f8fafc; }
.irow { padding-left: 30px; }
.irow:hover, .frow:hover { background: #eef2f7; }
.fname, .iname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fcount, .isize { color: #64748b; font-size: 11px; font-variant-numeric: tabular-nums; }
.foot { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-top: 1px solid #e2e8f0; }
.tally { color: #475569; font-size: 12px; }
.tally.warn { color: #b42318; font-weight: 600; }
.row { display: flex; gap: 8px; margin-left: auto; }
.row.end { justify-content: flex-end; padding: 10px 14px 12px; }
.btn { font: inherit; padding: 6px 13px; border-radius: 6px; border: 1px solid #cbd5e1;
  background: #fff; color: #0f172a; cursor: pointer; }
.btn:hover { background: #f1f5f9; }
.btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.btn.primary:hover { background: #1a5fd0; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.spin { display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -1px;
  border: 2px solid #cbd5e1; border-top-color: #1f6feb; border-radius: 50%; animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }

.panel { position: fixed; right: 18px; bottom: 18px; width: 380px; z-index: 2147483000; }
.phead { display: flex; align-items: center; padding: 11px 12px 8px; }
.ptitle { font-weight: 650; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { height: 8px; background: #e2e8f0; border-radius: 999px; margin: 0 12px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: #1f6feb; transition: width .25s; }
.line { padding: 7px 12px 2px; color: #475569; font-size: 12px; font-variant-numeric: tabular-nums; }
.note { padding: 4px 12px 2px; font-size: 12px; color: #475569; }
.note.bad { color: #b42318; }
.rows { padding: 4px 12px 0; max-height: 168px; overflow: auto; }
.frow2 { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.frow2 .fn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow2 .fb { width: 62px; height: 5px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
.frow2 .fb > i { display: block; height: 100%; background: #94a3b8; }
.frow2 .ft { width: 58px; text-align: right; color: #64748b; font-variant-numeric: tabular-nums; }
.frow2.ok .fb > i { background: #1a7f37; }
.frow2.bad { color: #b42318; }
.frow2.bad .fb > i { background: #b42318; }

@media (prefers-color-scheme: dark) {
  .card { background: #0f172a; color: #e2e8f0; }
  .head, .foot { border-color: #1e293b; }
  .chips { border-color: #1e293b; }
  .frow { background: #111c33; }
  .irow:hover, .frow:hover { background: #1e293b; }
  .btn { background: #1e293b; border-color: #334155; color: #e2e8f0; }
  .btn:hover { background: #273449; }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .bar, .frow2 .fb { background: #1e293b; }
  .sub, .tally, .line, .note, .fcount, .isize, .frow2 .ft { color: #94a3b8; }
  .tally.warn, .note.bad { color: #f87171; }
}
`;
  }
})();
