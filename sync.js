/*
 * sync.js - compare one course against a folder on disk and fetch what is
 * missing, writing it into that folder.
 *
 * Why this does not go through chrome.downloads like everything else: a course
 * folder lives wherever its owner keeps it, and chrome.downloads can only write
 * inside the browser's download directory. The File System Access API is the
 * only way to put a file into a folder someone chose, so this page owns its own
 * fetching and writing rather than handing work to the service worker.
 *
 * The folder handle is kept in IndexedDB, keyed by host and course, because
 * chrome.storage serialises through JSON and a handle does not survive that.
 * Chrome still re-asks for write access after a browser restart, which is a
 * click rather than a re-pick.
 *
 * A run makes one attempt per file. Nothing is lost by that: comparing again
 * finds exactly the files that did not land, so re-running IS the retry, and
 * the alternative is a second copy of the backoff ladder in offscreen.js.
 */
(function () {
  'use strict';

  const P = globalThis.LUMS.paths;
  const Sakai = globalThis.LUMS.sakai;
  const Sync = globalThis.LUMS.sync;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const send = (msg) => new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      void chrome.runtime.lastError;
      resolve(r || { ok: false });
    });
  });

  function formatBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }

  /* Brave blocks the File System Access API by default, so the whole
   * write-into-your-folder path is missing there. Rather than dead-end, the
   * page falls back to a directory <input>, which every Chromium browser has:
   * it reads the folder the same way, and the missing files then go through the
   * ordinary download queue as one ZIP. See FALLBACK notes further down. */
  const FSA = globalThis.LUMS.folder.supported();

  let settings = {};
  let course = null;      // { origin, id, title }
  let dir = null;         // FileSystemDirectoryHandle, when the browser has one
  let localFiles = null;  // the folder listing, when it came from an <input>
  let dirLabel = '';
  let missing = [];       // items to fetch, in LMS order
  let running = false;
  let stopped = false;

  const haveFolder = () => !!(dir || localFiles);

  /* A folder just became usable, whichever way it arrived. Comparing is the
   * only reason anyone picks one, so it happens here rather than waiting for a
   * click on a button that would have exactly one sensible thing to do. */
  function folderReady() {
    renderFolder(null);
    syncButtons();
    compare().catch(() => { running = false; syncButtons(); });
  }

  /* Picking, remembering and writing all live in lib/folder.js, which the
   * Resources page uses too. Everything below is this page's own wiring. */
  const F = globalThis.LUMS.folder;

  /* ---------- the folder step ---------- */

  function renderFolder(note) {
    if (!course) {
      $('folder').innerHTML = '<div class="muted">Pick a course first.</div>';
      return;
    }
    const has = haveFolder();
    const chosen = has ? '<div class="box"><div class="path">' + esc(dirLabel) + '</div></div>' : '';
    const label = (has ? 'Choose a different folder' : 'Choose folder');

    // FALLBACK: a directory <input> reads the listing and nothing else, so it
    // needs no remembering - there is no handle to keep - and the browser
    // re-asks for the folder each visit.
    const picker = FSA
      ? '<button class="btn' + (has ? '' : ' primary') + '" id="pick">' + label + '</button>'
      : '<label class="btn' + (has ? '' : ' primary') + '" id="pick">' + label +
        '<input type="file" id="pickinput" webkitdirectory directory multiple hidden></label>';

    $('folder').innerHTML = chosen +
      '<div class="row">' + picker +
        (FSA && has ? '<button class="btn" id="unpick">Forget this folder</button>' : '') +
      '</div>' +
      (FSA ? '' : '<p class="hint">Your browser asks whether to upload the folder. ' +
        'Nothing leaves your machine: the page reads the list of filenames to work out ' +
        'what is missing, and never opens the files.</p>') +
      (note ? '<div class="muted' + (note.bad ? ' bad' : '') + '">' + esc(note.text) + '</div>' : '');

    if (FSA) $('pick').onclick = pickFolder;
    else $('pickinput').onchange = (e) => takeListing(e.target.files);

    if ($('unpick')) {
      $('unpick').onclick = async () => {
        await F.forget(course.origin, course.id);
        dir = null;
        dirLabel = '';
        resetResult();
        renderFolder(null);
      };
    }
  }

  /* FALLBACK: what a directory <input> hands back. Each File carries a
   * webkitRelativePath of "<folder>/Books/x.pdf", so the first segment names
   * the folder and the rest is what the comparison works on. */
  function takeListing(fileList) {
    if (!fileList || !fileList.length) return;
    localFiles = F.listing(fileList);
    dirLabel = F.listingRoot(fileList) || 'the folder';
    resetResult();
    folderReady();
  }

  async function pickFolder() {
    let handle;
    try {
      handle = await F.pick();
    } catch (e) {
      if (e && e.aborted) return;   // changed their mind; nothing to report
      renderFolder({ bad: true, text: 'This browser would not open a folder: ' + e.message });
      return;
    }
    if (!(await F.grant(handle))) {
      renderFolder({ bad: true, text: 'Without write access to that folder there is nowhere to put the missing files.' });
      return;
    }
    dir = handle;
    dirLabel = handle.name;
    await F.remember(course.origin, course.id, handle);
    resetResult();
    folderReady();
  }

  /* Reconnect a remembered folder with no click when the permission is still
   * live, and offer the click when it is not. */
  async function loadRememberedFolder() {
    dir = null;
    localFiles = null;
    dirLabel = '';
    // FALLBACK: an <input> listing leaves no handle to remember, so there is
    // nothing to look up and the folder gets picked again.
    if (!FSA) { renderFolder(null); syncButtons(); return; }

    const handle = await F.recall(course.origin, course.id);
    if (!handle) { renderFolder(null); syncButtons(); return; }

    if (await F.permissionState(handle) === 'granted') {
      dir = handle;
      dirLabel = handle.name;
      folderReady();
      return;
    }

    $('folder').innerHTML =
      '<div class="box"><div class="path">' + esc(handle.name) + '</div>' +
      '<div class="muted">Remembered from last time. Chrome drops write access when it restarts.</div></div>' +
      '<div class="row"><button class="btn primary" id="reconnect">Use this folder</button>' +
      '<button class="btn" id="pick">Choose a different folder</button></div>';

    $('pick').onclick = pickFolder;
    $('reconnect').onclick = async () => {
      if (!(await F.grant(handle))) {
        renderFolder({ bad: true, text: 'Write access to that folder was refused.' });
        return;
      }
      dir = handle;
      dirLabel = handle.name;
      folderReady();
    };
    syncButtons();
  }

  /* ---------- the course step ---------- */

  function hostProblem(h) {
    const label = Sakai.hostLabel(h.origin);
    return (h.res && h.res.error === 'network' ? 'Could not reach ' : 'Not signed in to ') + label;
  }

  async function loadSites() {
    const hosts = await Promise.all(Sakai.ORIGINS.map(async (origin) => ({
      origin,
      res: await Sakai.relay(origin, { type: 'RELAY_SITES' }, () => Sakai.fetchSites(origin))
    })));

    const ok = hosts.filter((h) => h.res && h.res.sites);
    const bad = hosts.filter((h) => !h.res || !h.res.sites);

    if (!ok.length) {
      $('sites').innerHTML = '<div class="muted">' + esc(bad.map(hostProblem).join('. ') + '.') + '</div>';
      return;
    }

    const rows = [];
    for (const h of ok) for (const s of h.res.sites) rows.push({ origin: h.origin, id: s.id, title: s.title });
    // Newest semester first, as in the popup: a LUMS title opens with its
    // semester code, so descending title order is descending semester.
    rows.sort((a, b) => b.title.localeCompare(a.title, undefined, { numeric: true }));

    if (!rows.length) { $('sites').innerHTML = '<div class="muted">No courses found.</div>'; return; }

    const showHost = ok.filter((h) => h.res.sites.length).length > 1;

    $('sites').innerHTML = rows.map((s, i) =>
      '<label class="site"><input type="radio" name="site" value="' + i + '">' +
      '<span class="stitle" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
      (showHost ? '<span class="host">' + esc(Sakai.hostLabel(s.origin).split('.')[0]) + '</span>' : '') +
      '</label>').join('') +
      (bad.length ? '<div class="muted">' + esc(bad.map(hostProblem).join('. ') + '.') + '</div>' : '');

    const boxes = [...$('sites').querySelectorAll('input')];
    boxes.forEach((b) => {
      b.onchange = async () => {
        course = rows[Number(b.value)];
        resetResult();
        // Each course remembers its own folder, so switching course switches
        // folder rather than carrying the last one over to the wrong place.
        await loadRememberedFolder();
      };
    });

    /* Arriving from a course's Resources page, the course is already settled.
     * Tick it and bring it into view rather than leaving someone to find it in
     * a list that runs to every course they have ever taken. The list is also
     * where its title comes from, which saves asking the LMS a second time. */
    if (course) {
      const i = rows.findIndex((r) => r.origin === course.origin && r.id === course.id);
      if (i >= 0) {
        course = rows[i];
        boxes[i].checked = true;
        boxes[i].closest('.site').scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /* ---------- comparing ---------- */

  function resetResult() {
    missing = [];
    $('result').innerHTML = '';
    $('sync').hidden = true;
    $('stop').hidden = true;
    syncButtons();
  }

  function syncButtons() {
    $('compare').disabled = running || !course || !haveFolder();
  }

  function describeContentError(content) {
    if (!content) return 'The LMS did not answer.';
    if (content.error === 'auth') return 'Your session has expired. Sign in to ' + Sakai.hostLabel(course.origin) + ' and compare again.';
    if (content.error === 'network') return 'Could not reach ' + Sakai.hostLabel(course.origin) + '.';
    if (content.error === 'empty') return 'No resources visible in this course.';
    return String(content.error);
  }

  async function compare() {
    running = true;
    syncButtons();
    $('result').innerHTML = '<div class="muted">Reading the course and the folder…</div>';

    const content = await Sakai.relay(
      course.origin,
      { type: 'RELAY_CONTENT', siteId: course.id, opts: settings },
      () => Sakai.fetchSiteContent(course.id, settings, course.origin)
    );

    if (!content || !content.items) {
      $('result').innerHTML = '<div class="muted bad">' + esc(describeContentError(content)) + '</div>';
      running = false;
      syncButtons();
      return;
    }

    let local = localFiles;
    if (!local) {
      try {
        local = await F.scan(dir);
      } catch (e) {
        $('result').innerHTML = '<div class="muted bad">Could not read the folder: ' +
          esc(String((e && e.message) || e)) + '</div>';
        running = false;
        syncButtons();
        return;
      }
    }

    const result = Sync.plan(content.items, Sync.indexLocal(local));
    missing = result.missing;
    running = false;
    renderPlan(content.items.length, result.present.length, local.length);
    syncButtons();
  }

  function renderPlan(onLms, present, localCount) {
    const bytes = missing.reduce((n, it) => n + (it.bytes || 0), 0);
    $('result').innerHTML =
      '<div class="counts">' +
        '<div><b>' + onLms + '</b><span>on the LMS</span></div>' +
        '<div><b>' + present + '</b><span>already here</span></div>' +
        '<div><b>' + missing.length + '</b><span>missing</span></div>' +
      '</div>' +
      (missing.length
        ? '<div class="files" id="files">' + missing.map((it, i) =>
            '<div class="file" data-i="' + i + '"><span class="mark">·</span>' +
            '<span class="rel">' + esc(it.rel) + '</span>' +
            '<span class="size">' + esc(formatBytes(it.bytes)) + '</span>' +
            '<span class="why"></span></div>').join('') + '</div>'
        : '<div class="ok">This folder already has every file the LMS is showing.</div>') +
      '<p class="hint">' + localCount + ' file(s) scanned in the folder. A file counts as ' +
      'already here when its name turns up anywhere inside, at any depth, so anything you ' +
      'moved or filed away yourself is left alone.' +
      (FSA ? '' : ' This browser will not let an extension write into your folder, so the ' +
        'missing files arrive as one ZIP in your downloads for you to extract over it.') +
      '</p>';

    $('sync').hidden = !missing.length;
    $('sync').textContent = 'Download ' + missing.length + ' missing file' +
      (missing.length === 1 ? '' : 's') + (FSA ? '' : ' as a ZIP') +
      (bytes ? ' · ' + formatBytes(bytes) : '');
  }

  /* FALLBACK: with no way to write into the folder, the missing items go
   * through the same queue as everything else in the extension. They arrive as
   * one archive named after the course, with " - missing files" on the end so
   * it does not read as a full download of the course. */
  async function queueZip() {
    $('sync').hidden = true;

    // The course list normally supplies the title, but a course missing from it
    // would otherwise name the archive after a UUID. Ask the host directly.
    if (course.title === course.id) {
      const t = await Sakai.relay(
        course.origin,
        { type: 'RELAY_TITLE', siteId: course.id },
        () => Sakai.fetchSiteTitle(course.id, course.origin)
      );
      if (t && t.title) course.title = t.title;
    }

    const r = await send({
      type: 'START_JOB',
      origin: course.origin,
      siteId: course.id,
      siteTitle: course.title,
      scopeLabel: 'missing files',
      items: missing
    });

    const note = document.createElement('div');
    note.className = r && r.ok ? 'muted ok' : 'muted bad';
    note.textContent = r && r.ok
      ? 'Queued ' + missing.length + ' file(s). Watch the extension popup for progress. The ' +
        'ZIP holds the course folder, so extract it over the folder you picked to merge them.'
      : 'Could not queue the download: ' + String((r && r.error) || 'unknown error');
    $('result').insertBefore(note, $('result').firstChild);
  }

  /* ---------- fetching the missing files ---------- */

  function markFile(i, cls, why) {
    const list = $('files');
    const el = list && list.querySelector('[data-i="' + i + '"]');
    if (!el) return;
    el.className = 'file' + (cls ? ' ' + cls : '');
    el.querySelector('.mark').textContent = cls === 'done' ? '✓' : (cls === 'failed' ? '✕' : '·');
    el.querySelector('.why').textContent = why || '';
  }

  async function runSync() {
    running = true;
    stopped = false;
    $('sync').hidden = true;
    $('stop').hidden = false;
    syncButtons();

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = '<i style="width:0%"></i>';
    $('result').insertBefore(bar, $('result').firstChild);

    // Same names the archive builder gives, so a folder filled by one mode and
    // topped up by the other holds one copy of each file rather than two.
    const taken = new Set();
    const targets = missing.map((it) => P.uniqueName(taken, P.downloadPath('', '', it.rel)));

    let next = 0;
    let done = 0;
    let failed = 0;
    let fatal = null;

    const paint = () => {
      const pct = Math.round(((done + failed) / missing.length) * 100);
      bar.firstChild.style.width = pct + '%';
      bar.className = 'bar' + (failed ? ' bad' : (done + failed === missing.length ? ' done' : ''));
    };

    async function worker() {
      for (;;) {
        // One expired session fails every remaining file identically, so the
        // first one to say so stops the rest.
        if (stopped || fatal) return;
        const i = next++;
        if (i >= missing.length) return;
        markFile(i, '', 'downloading…');
        try {
          await F.fetchInto(dir, targets[i], missing[i]);
          done++;
          markFile(i, 'done', '');
        } catch (e) {
          failed++;
          if (e && e.auth) fatal = e.message;
          markFile(i, 'failed', String((e && e.message) || e));
        }
        paint();
      }
    }

    const conc = Math.max(1, Math.min(5, Number(settings.concurrency) || 3));
    await Promise.all(Array.from({ length: Math.min(conc, missing.length) }, worker));

    running = false;
    $('stop').hidden = true;
    syncButtons();

    const note = document.createElement('div');
    note.className = failed ? 'muted bad' : 'muted ok';
    note.textContent = fatal
      ? fatal + ' Sign in to ' + Sakai.hostLabel(course.origin) + ' and compare again.'
      : (stopped ? 'Stopped. ' : '') + done + ' file(s) written to ' + dirLabel +
        (failed ? ', ' + failed + ' failed. Compare again to try those once more.' : '.');
    $('result').insertBefore(note, bar.nextSibling);

    /* A clean run leaves a list of ticks that says nothing the counts do not,
     * so it is worth replacing with the folder's new state. A run with failures
     * keeps its list: which files failed and why is the only place that lives. */
    if (!failed && !stopped) await compare().catch(() => {});
  }

  /* ---------- wiring ---------- */

  if (!FSA) $('unsupported').hidden = false;

  $('compare').onclick = () => { compare().catch(() => { running = false; syncButtons(); }); };
  $('sync').onclick = () => {
    const go = FSA ? runSync() : queueZip();
    go.catch(() => { running = false; syncButtons(); });
  };
  $('stop').onclick = () => { stopped = true; };

  /* The Resources page opens this with the course in the query string. Taking
   * it here rather than waiting for the course list means the folder step, and
   * the comparison behind it, start without a round trip first.
   *
   * The origin is checked against the host list rather than trusted: a URL is
   * the one input here that does not come from the extension's own UI, and it
   * decides which host gets asked for the course's files. */
  function courseFromUrl() {
    const q = new URLSearchParams(location.search);
    const origin = q.get('origin');
    const id = q.get('site');
    if (!origin || !id || Sakai.ORIGINS.indexOf(origin) < 0) return null;
    return { origin: origin, id: id, title: id };
  }

  async function start() {
    const st = await send({ type: 'GET_STATE' });
    settings = st.settings || {};

    course = courseFromUrl();
    // Kicked off before the folder step so the course list, and with it the
    // real course title, lands while the folder is being sorted out.
    const sites = loadSites();
    if (course) await loadRememberedFolder();
    await sites;
  }

  start().catch(() => {});
})();
