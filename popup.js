/*
 * popup.js - live progress with the LMS tab closed, the course picker, and settings.
 *
 * API calls prefer to run inside a content script on an open LMS tab, where they
 * are same-origin and the Sakai session cookie is guaranteed to be attached.
 * Fetching from the popup works too (host_permissions), so that is the fallback
 * when no LMS tab is open - with the same login-page detection either way.
 *
 * Every LMS host is asked, and the answers are merged into one course list: the
 * live LMS and the archive are separate installs, and a semester lives on one
 * or the other. Each course therefore carries the origin it came from, and every
 * later call about it goes back to that same host.
 */
(function () {
  'use strict';

  const Sakai = globalThis.LUMS.sakai;
  const Progress = globalThis.LUMS.progress;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const send = (msg) => new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      void chrome.runtime.lastError;
      resolve(r || { ok: false });
    });
  });

  /* Try every open tab on THAT host before falling back to a popup-context
   * fetch. Only a tab on the same origin can answer for it: a live-LMS tab
   * would happily return the live course list for an archive request. */
  async function relay(origin, msg, fallback) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: origin + '/portal/*' }); } catch (e) { /* none */ }
    for (const t of tabs) {
      try {
        const r = await chrome.tabs.sendMessage(t.id, Object.assign({ origin }, msg));
        if (r) return r;
      } catch (e) { /* no content script in that tab */ }
    }
    return fallback();
  }

  /* ---------- jobs ---------- */

  let settings = {};

  async function tick() {
    const st = await send({ type: 'GET_STATE' });
    if (!st.ok) return;
    settings = st.settings || settings;
    renderJobs(st.jobs || [], st.live || {});
  }

  function fatalText(job) {
    if (job.fatal === 'auth') {
      return 'Session expired — sign in to ' + (Sakai.hostLabel(job.origin) || 'the LMS') + ' and retry.';
    }
    if (job.fatal === 'toobig') return 'Hit the 4 GB ZIP limit. Download in smaller parts.';
    return String(job.fatal);
  }

  function statusLine(job, p) {
    if (job.state === 'cancelled') return Progress.summaryLine(job);
    if (job.state === 'done') return Progress.summaryLine(job);
    if (job.phase === 'archiving') return 'Building archive · ' + Progress.summaryLine(job);
    return Progress.progressLine(p) + ' · ' + p.percent + '%' + (job.state === 'paused' ? ' · paused' : '');
  }

  function noteFor(job) {
    if (job.fatal) return fatalText(job);
    if (job.error) return job.error;
    if (job.archive && job.archive.state === 'failed') {
      return 'Could not save the archive: ' + (job.archive.error || 'unknown error');
    }
    if (job.archive && job.archive.state === 'saving') return 'Saving the archive…';
    return null;
  }

  function renderJobs(jobs, live) {
    const shown = jobs.slice(-3).reverse();
    $('jobs').innerHTML = shown.map((job) => {
      const p = Progress.jobProgress(job, live);
      const finished = job.state === 'done' || job.state === 'cancelled';
      const cls = finished ? ((p.failed || job.fatal) ? 'bad' : 'done') : '';
      const note = noteFor(job);
      return '<div class="job" data-job="' + esc(job.id) + '">' +
        '<div class="top"><span class="name">' + esc(job.siteTitle) + '</span>' +
          // Only a stopped job can be dismissed: forgetting a running one would
          // leave its downloads in flight with nothing tracking them. Cancel is
          // the button for stopping one, and it says so.
          (finished ? '<button class="link" data-act="dismiss" title="Dismiss">×</button>' : '') +
        '</div>' +
        '<div class="bar ' + cls + '"><i style="width:' + p.percent + '%"></i></div>' +
        '<div class="line">' + esc(statusLine(job, p)) + '</div>' +
        (note ? '<div class="note' + (job.fatal || job.error ? ' bad' : '') + '">' + esc(note) + '</div>' : '') +
        '<div class="actions">' +
          (finished
            ? (p.failed || p.cancelled ? '<button class="btn" data-act="retry">Retry failed</button>' : '')
            : (job.state === 'paused'
                ? '<button class="btn" data-act="resume">Resume</button>'
                : '<button class="btn" data-act="pause">Pause</button>') +
              '<button class="btn" data-act="cancel">Cancel</button>') +
        '</div></div>';
    }).join('');

    $('jobs').querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const jobId = b.closest('.job').dataset.job;
        const map = { pause: 'PAUSE', resume: 'RESUME', cancel: 'CANCEL', retry: 'RETRY_FAILED', dismiss: 'DISMISS_JOB' };
        await send({ type: map[b.dataset.act], jobId });
        tick();
      };
    });
  }

  /* ---------- course picker ---------- */

  /* Why a host failed, in the words that tell someone what to do about it. */
  function hostProblem(h) {
    const label = Sakai.hostLabel(h.origin);
    return (h.res && h.res.error === 'network' ? 'Could not reach ' : 'Not signed in to ') + label;
  }

  async function loadSites() {
    // Asked in parallel: one host being slow or unreachable should not hold up
    // the courses the other one already has.
    const hosts = await Promise.all(Sakai.ORIGINS.map(async (origin) => ({
      origin,
      res: await relay(origin, { type: 'RELAY_SITES' }, () => Sakai.fetchSites(origin))
    })));

    const ok = hosts.filter((h) => h.res && h.res.sites);
    const bad = hosts.filter((h) => !h.res || !h.res.sites);

    if (!ok.length) {
      $('sites').innerHTML = '<div class="muted">' +
        esc(bad.map(hostProblem).join('. ') + '.') + '</div>';
      return;
    }

    const rows = [];
    for (const h of ok) for (const s of h.res.sites) rows.push({ origin: h.origin, id: s.id, title: s.title });

    if (!rows.length) {
      $('sites').innerHTML = '<div class="muted">No courses found.</div>';
      return;
    }

    // A host tag only earns its space when there is another host to tell it
    // apart from; otherwise it is the same word on every row.
    const showHost = ok.filter((h) => h.res.sites.length).length > 1;

    $('sites').innerHTML = rows.map((s) =>
      '<label class="site"><input type="checkbox" value="' + esc(s.id) +
        '" data-origin="' + esc(s.origin) + '" data-title="' + esc(s.title) + '">' +
      '<span class="stitle" title="' + esc(s.title) + '">' + esc(s.title) + '</span>' +
      (showHost ? '<span class="host" title="' + esc(Sakai.hostLabel(s.origin)) + '">' +
        esc(Sakai.hostLabel(s.origin).split('.')[0]) + '</span>' : '') +
      '</label>').join('') +
      // A host that could not be read is not the same as it having no courses.
      // Saying which one is what stops someone hunting for a semester that is
      // sitting behind a login they have not used yet.
      (bad.length ? '<div class="muted">' + esc(bad.map(hostProblem).join('. ') + '.') + '</div>' : '');

    const boxes = [...$('sites').querySelectorAll('input')];
    const sync = () => { $('queue').disabled = !boxes.some((b) => b.checked); };
    boxes.forEach((b) => { b.onchange = sync; });
    sync();

    $('queue').onclick = async () => {
      const chosen = boxes.filter((b) => b.checked);
      $('queue').disabled = true;
      $('queue').textContent = 'Queueing…';

      for (const b of chosen) {
        const origin = b.dataset.origin;
        const content = await relay(
          origin,
          { type: 'RELAY_CONTENT', siteId: b.value, opts: settings },
          () => Sakai.fetchSiteContent(b.value, settings, origin)
        );
        if (content && content.items && content.items.length) {
          await send({ type: 'START_JOB', origin, siteId: b.value, siteTitle: b.dataset.title, items: content.items });
        }
        b.checked = false;
      }

      $('queue').textContent = 'Download selected';
      sync();
      tick();
    };
  }

  /* ---------- settings ---------- */

  async function initSettings() {
    const st = await send({ type: 'GET_STATE' });
    settings = st.settings || {};
    $('rootPrefix').value = settings.rootPrefix || '';
    $('concurrency').value = settings.concurrency || 3;
    $('includeHidden').checked = !!settings.includeHidden;
    $('webLinks').checked = settings.webLinks === 'save';

    const save = async () => {
      const next = {
        rootPrefix: $('rootPrefix').value,
        concurrency: Number($('concurrency').value),
        includeHidden: $('includeHidden').checked,
        webLinks: $('webLinks').checked ? 'save' : 'skip'
      };
      const r = await send({ type: 'SET_SETTINGS', settings: next });
      if (r.settings) {
        settings = r.settings;
        $('concurrency').value = settings.concurrency;   // reflect clamping
      }
    };
    ['rootPrefix', 'concurrency', 'includeHidden', 'webLinks'].forEach((id) => {
      $(id).addEventListener('change', save);
    });
  }

  $('openFolder').onclick = () => send({ type: 'SHOW_DOWNLOADS' });

  initSettings().then(loadSites);
  tick();
  setInterval(tick, 400);
})();
