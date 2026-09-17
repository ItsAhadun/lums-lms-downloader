/*
 * background.js - service worker. Owns job state for both delivery modes.
 *
 * The worker can be killed at any moment, so job state lives in
 * chrome.storage.session and is re-read on every mutation. Four things wake it
 * back up: chrome.downloads.onChanged (advances the file queue with no UI
 * open), ticks from the offscreen document (ZIP mode), a chrome.alarms fire
 * (the retry-backoff safety net) and GET_STATE polls from the panel or popup.
 *
 * Two delivery modes, one queue and one job model:
 *  - 'files' runs here, through chrome.downloads.
 *  - 'zip'   runs in an offscreen document, which owns the ZipWriter because a
 *            worker has no URL.createObjectURL. Exactly one ZIP job runs at a
 *            time: an extension may hold only one offscreen document.
 *
 * The mode is not a setting. Anything with more than one file is delivered as
 * one archive, so "Download all" is one save prompt instead of N; a lone file
 * would only be unpacked again, so it goes straight through chrome.downloads.
 */
import './lib/paths.js';
import './lib/progress.js';

const P = globalThis.LUMS.paths;
const Progress = globalThis.LUMS.progress;

const STATE_KEY = 'lums:state';
const SETTINGS_KEY = 'lums:settings';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000, 10000];
const KEEP_FINISHED_JOBS = 5;
const RETRY_ALARM = 'lums:retry';

/* chrome.downloads interruption reasons that mean the session is gone. Every
 * remaining file will fail identically, so burning the backoff ladder N times
 * over only delays the one message that helps. */
const AUTH_ERRORS = new Set(['SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN']);

/* Named per job rather than per constant: a job knows which LMS host it came
 * from, and telling someone to sign in to the wrong one is worse than saying
 * nothing. */
function fatalText(job) {
  if (job.fatal === 'auth') {
    const host = String(job.origin || '').replace(/^https?:\/\//, '');
    return 'Your LMS session has expired. Sign in to ' + (host || 'the LMS') + ' and retry.';
  }
  if (job.fatal === 'toobig') return 'The archive hit the 4 GB ZIP limit. Download this course in smaller parts.';
  return String(job.fatal);
}

const DEFAULTS = {
  rootPrefix: 'LUMS LMS/',
  concurrency: 3,
  includeHidden: false,
  webLinks: 'skip',
  openResources: true
};

/* ---------- state ---------- */

async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULTS, o[SETTINGS_KEY] || {});
}

/* Download events, offscreen ticks and UI messages arrive concurrently;
 * without serialising, two handlers read the same state and the second write
 * loses the first. */
let chain = Promise.resolve();
function withState(fn) {
  const next = chain.then(async () => {
    const o = await chrome.storage.session.get(STATE_KEY);
    const st = o[STATE_KEY] || { jobs: [] };
    const result = await fn(st);
    st.jobs.forEach(recompute);
    await chrome.storage.session.set({ [STATE_KEY]: st });
    return result;
  });
  chain = next.then(() => {}, () => {});
  return next;
}

async function readState() {
  const o = await chrome.storage.session.get(STATE_KEY);
  return o[STATE_KEY] || { jobs: [] };
}

/* Totals are derived, never incremented, so they cannot drift out of sync with
 * the item states after a retry, a cancel or a worker restart. */
function recompute(job) {
  // A fatal error applies to the whole job, so nothing is left waiting for a
  // turn that will never come. Settling here means it self-heals wherever the
  // flag gets set, rather than at each of the places that set it.
  if (job.fatal) {
    for (const it of job.items) {
      if (it.state === 'pending') {
        it.state = 'failed';
        it.error = it.error || fatalText(job);
      }
    }
  }

  let bytes = 0, doneBytes = 0, doneFiles = 0, failed = 0, cancelled = 0, active = 0, pending = 0;
  for (const it of job.items) {
    bytes += it.bytes;
    if (it.state === 'done') { doneBytes += it.bytes; doneFiles++; }
    else if (it.state === 'failed') failed++;
    else if (it.state === 'cancelled') cancelled++;
    else if (it.state === 'active') active++;
    else pending++;
  }
  job.totals = { files: job.items.length, bytes, doneFiles, doneBytes, failed, cancelled, active, pending };

  // A ZIP job is not finished when its last file lands - the archive still has
  // to be assembled and saved. The offscreen document says when, via ZIP_DONE.
  if (job.delivery === 'zip') return job.totals;

  if (!active && !pending && (job.state === 'running' || job.state === 'paused')) job.state = 'done';
  return job.totals;
}

function findByDownloadId(st, id) {
  for (const job of st.jobs) {
    for (const it of job.items) {
      if (it.downloadId === id) return { job, it };
    }
  }
  return null;
}

/* ---------- offscreen document (ZIP mode) ---------- */

let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const c = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return c.length > 0;
  }
  return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble the course archive and hold it until the download starts.'
    }).finally(() => { creating = null; });
  }
  await creating;
}

/* Closing the document invalidates the blob URLs it created, so it is only
 * safe once every archive has finished saving. */
async function maybeCloseOffscreen() {
  const st = await readState();
  const busy = st.jobs.some((j) =>
    (j.delivery === 'zip' && (j.state === 'running' || j.state === 'paused')) ||
    (j.archive && j.archive.state === 'saving'));
  if (busy) return;
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* already gone */ }
  }
}

/* The offscreen listener never answers, so the message port closes without a
 * response. That is expected, not an error. */
function tellOffscreen(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* no document */ }
}

/* Sub-file progress for ZIP items, keyed the same way chrome.downloads keys
 * its own: by item.downloadId. Deliberately not persisted - it changes many
 * times a second, and losing it to a worker restart costs a progress bar, not
 * a download. */
let zipLive = {};

/* ---------- queue ---------- */

async function startItem(job, it, settings) {
  const filename = P.downloadPath(settings.rootPrefix, job.courseFolder, it.rel);
  try {
    it.downloadId = await chrome.downloads.download({
      url: it.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    it.state = 'active';
    it.error = null;
  } catch (e) {
    // A rejected filename fails identically every time, so retrying only wastes
    // the user's time. Fail it immediately with the reason visible.
    it.state = 'failed';
    it.downloadId = null;
    it.error = String((e && e.message) || e);
  }
}

async function pump() {
  const settings = await getSettings();
  const plan = await withState(async (st) => {
    const now = Date.now();
    let active = 0;
    for (const job of st.jobs) for (const it of job.items) if (it.state === 'active') active++;

    let soonest = Infinity;
    let startZip = null;

    // Only one archive at a time; a job already handed over keeps its turn.
    const zipBusy = st.jobs.some((j) => j.delivery === 'zip' && j.started && (j.state === 'running' || j.state === 'paused'));

    for (const job of st.jobs) {
      if (job.state !== 'running' || job.fatal) continue;

      if (job.delivery === 'zip') {
        if (!job.started && !zipBusy && !startZip) {
          job.started = true;
          startZip = {
            id: job.id,
            courseFolder: job.courseFolder,
            scopeLabel: job.scopeLabel || '',
            concurrency: settings.concurrency,
            // Every item goes over so the indices in a tick still line up with
            // job.items, but a retry must not re-fetch what already landed in
            // the archive that saved.
            items: job.items.map((it) => ({
              url: it.url, rel: it.rel, bytes: it.bytes,
              modifiedDate: it.modifiedDate || '', done: it.state === 'done'
            }))
          };
        }
        continue;
      }

      for (const it of job.items) {
        if (it.state !== 'pending') continue;
        if (it.retryAt && it.retryAt > now) { soonest = Math.min(soonest, it.retryAt); continue; }
        if (active >= settings.concurrency) continue;
        await startItem(job, it, settings);
        active++;
      }
    }
    return { soonest, startZip };
  });

  if (plan.startZip) {
    try {
      await ensureOffscreen();
      tellOffscreen({ target: 'offscreen', type: 'START', job: plan.startZip });
    } catch (e) {
      // The job is already flagged as handed over, so without this it would
      // hold the one ZIP slot for ever and never run.
      await withState((st) => {
        const job = st.jobs.find((j) => j.id === plan.startZip.id);
        if (job) { job.started = false; job.fatal = null; job.error = 'Could not start the archive builder: ' + String((e && e.message) || e); }
      });
    }
  }

  scheduleRetry(plan.soonest);
  await refreshBadge();
}

/* Backoff wake-ups, belt and braces.
 *
 * setTimeout dies with the worker, and MV3 kills it after ~30s idle. With
 * nothing in flight there is no downloads event to wake it either, so a job
 * whose remaining items are all mid-backoff would sit pending for ever. The
 * timer keeps the short backoffs honest; the alarm survives the worker. */
let retryTimer = null;

function scheduleRetry(at) {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (at === Infinity) {
    chrome.alarms.clear(RETRY_ALARM);
    return;
  }
  retryTimer = setTimeout(() => { pump().catch(() => {}); }, Math.max(50, Math.min(30000, at - Date.now())));
  // An alarm cannot fire sooner than 30s, so it is the floor, never the timer.
  chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 30000, at) });
}

/* Sakai's manifest size is the exact Content-Length for the file, so a
 * completed download that does not match it is not the file we asked for. The
 * usual cause is an expired session, where a ~20 KB login page lands on disk
 * named Lecture 4.pdf - the "downloaded files are tiny" report in the README. */
function checkSize(job, it, fileSize) {
  if (fileSize == null || !it.bytes) return true;
  if (Math.abs(fileSize - it.bytes) <= Math.max(4096, it.bytes * 0.05)) return true;

  it.state = 'failed';
  it.error = 'wrong size on disk (' + fileSize + ' of ' + it.bytes + ' bytes)';
  if (it.bytes > 262144 && fileSize < 65536) job.fatal = 'auth';
  return false;
}

function markInterrupted(job, it, error) {
  it.downloadId = null;
  if (job.state === 'cancelled' || error === 'USER_CANCELED') {
    it.state = 'cancelled';
    return;
  }
  it.error = error || 'interrupted';
  if (AUTH_ERRORS.has(error)) {
    it.state = 'failed';
    job.fatal = 'auth';
    return;
  }
  it.attempts = (it.attempts || 0) + 1;
  if (it.attempts >= MAX_ATTEMPTS) {
    it.state = 'failed';
  } else {
    // No range support on this endpoint, so a retry restarts the whole file.
    it.state = 'pending';
    it.retryAt = Date.now() + BACKOFF_MS[Math.min(it.attempts - 1, BACKOFF_MS.length - 1)];
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  let fileSize = null;
  if (state === 'complete') {
    try {
      const [d] = await chrome.downloads.search({ id: delta.id });
      if (d) fileSize = d.fileSize;
    } catch (e) { /* gone from history */ }
  }

  const touched = await withState((st) => {
    // The finished archive of a ZIP job, rather than one of its files.
    const arch = st.jobs.find((j) => j.archive && j.archive.downloadId === delta.id);
    if (arch) {
      arch.archive.state = state === 'complete' ? 'saved' : 'failed';
      if (state === 'interrupted') arch.archive.error = (delta.error && delta.error.current) || 'interrupted';
      return 'archive';
    }

    const found = findByDownloadId(st, delta.id);
    if (!found) return false;
    if (state === 'complete') {
      if (checkSize(found.job, found.it, fileSize)) {
        found.it.state = 'done';
        found.it.error = null;
      }
    } else {
      markInterrupted(found.job, found.it, delta.error && delta.error.current);
    }
    return true;
  });

  if (touched === 'archive') { await maybeCloseOffscreen(); await refreshBadge(); return; }
  if (touched) await pump();
});

/* After a worker restart, work may have finished while nothing was listening.
 * Re-read the real state from the browser before scheduling more. */
async function reconcile() {
  const st = await readState();

  // ZIP first: if the document is gone, so is the half-built archive in it.
  const liveZip = st.jobs.some((j) => j.delivery === 'zip' && j.started && (j.state === 'running' || j.state === 'paused'));
  if (liveZip && !(await hasOffscreen())) {
    await withState((s) => {
      for (const job of s.jobs) {
        if (job.delivery !== 'zip' || job.state !== 'running') continue;
        job.started = false;
        job.phase = 'fetching';
        // The bytes lived in the document that died, so every file is due again.
        for (const it of job.items) {
          if (it.state === 'cancelled') continue;
          it.state = 'pending';
          it.attempts = 0;
          it.retryAt = 0;
          it.error = null;
        }
      }
    });
  }

  const activeIds = [];
  for (const job of st.jobs) for (const it of job.items) {
    if (it.state === 'active' && typeof it.downloadId === 'number') activeIds.push(it.downloadId);
  }
  if (!activeIds.length) return;

  const found = new Map();
  for (const id of activeIds) {
    const [d] = await chrome.downloads.search({ id });
    if (d) found.set(id, d);
  }

  await withState((s) => {
    for (const job of s.jobs) for (const it of job.items) {
      if (it.state !== 'active' || typeof it.downloadId !== 'number') continue;
      const d = found.get(it.downloadId);
      if (!d) { it.state = 'pending'; it.downloadId = null; continue; }
      if (d.state === 'complete') {
        if (checkSize(job, it, d.fileSize)) { it.state = 'done'; it.error = null; }
      } else if (d.state === 'interrupted') {
        markInterrupted(job, it, d.error);
      }
    }
  });
}

/* ---------- live bytes + badge ---------- */

let liveCache = { at: 0, map: {} };

async function liveBytes() {
  const now = Date.now();
  if (now - liveCache.at < 200) return Object.assign({}, liveCache.map, zipLive);
  const list = await chrome.downloads.search({ state: 'in_progress' });
  const map = {};
  for (const d of list) map[d.id] = { received: d.bytesReceived, total: d.totalBytes };
  liveCache = { at: now, map };
  return Object.assign({}, map, zipLive);
}

function applyBadge(st, live) {
  const running = st.jobs.find((j) => j.state === 'running' || j.state === 'paused');
  if (running) {
    const p = Progress.jobProgress(running, live);
    chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
    chrome.action.setBadgeText({ text: p.percent + '%' });
    return;
  }
  const failed = st.jobs.some((j) => j.totals && j.totals.failed);
  chrome.action.setBadgeBackgroundColor({ color: failed ? '#b42318' : '#1a7f37' });
  chrome.action.setBadgeText({ text: failed ? '!' : '' });
}

async function refreshBadge() {
  applyBadge(await readState(), await liveBytes());
}

/* ---------- messages ---------- */

function makeJob(payload) {
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Decided by the size of the selection, never by a setting: a multi-file
  // download is always one archive, a single file is always the file itself.
  const delivery = payload.items.length > 1 ? 'zip' : 'files';
  return {
    id,
    // Which LMS host this course came from. Only used to address a person
    // correctly; the item URLs are absolute, so downloading needs nothing here.
    origin: payload.origin || '',
    siteId: payload.siteId,
    siteTitle: payload.siteTitle || payload.siteId,
    courseFolder: P.sanitizeSegment(payload.siteTitle || payload.siteId),
    scopeLabel: payload.scopeLabel || '',
    delivery,
    createdAt: Date.now(),
    state: 'running',
    phase: 'fetching',
    started: false,
    fatal: null,
    archive: null,
    items: payload.items.map((x, i) => ({
      url: x.url,
      title: x.title || '',
      rel: x.rel,
      bytes: Number(x.bytes) || 0,
      mime: x.mime || '',
      modifiedDate: x.modifiedDate || '',
      state: 'pending',
      // ZIP items are not chrome.downloads, but they still need a stable key
      // for the shared progress model to look their live bytes up under.
      downloadId: delivery === 'zip' ? id + ':' + i : null,
      attempts: 0,
      retryAt: 0,
      error: null
    }))
  };
}

/* Only pump on a poll when there is something a pump would actually start.
 * Otherwise two open UIs at 400ms would each force a full state write while a
 * healthy job is already saturating its concurrency. */
function needsPump(st, concurrency) {
  const now = Date.now();
  let active = 0;
  for (const j of st.jobs) for (const it of j.items) if (it.state === 'active') active++;

  // A second archive waiting its turn is not something a pump can start, so
  // saying yes here would mean a full state write every poll while the first
  // one builds.
  const zipBusy = st.jobs.some((j) => j.delivery === 'zip' && j.started && (j.state === 'running' || j.state === 'paused'));

  for (const j of st.jobs) {
    if (j.state !== 'running' || j.fatal) continue;
    if (j.delivery === 'zip') { if (!j.started && !zipBusy) return true; continue; }
    if (active >= concurrency) continue;
    for (const it of j.items) {
      if (it.state === 'pending' && (!it.retryAt || it.retryAt <= now)) return true;
    }
  }
  return false;
}

const handlers = {
  async START_JOB(msg) {
    if (!msg.items || !msg.items.length) return { ok: false, error: 'no items' };
    const id = await withState((st) => {
      const job = makeJob(msg);
      st.jobs.push(job);
      // A job whose archive is still being written is not done with, whatever
      // its state says: forgetting it would close the document holding the blob.
      const finished = st.jobs.filter((j) =>
        (j.state === 'done' || j.state === 'cancelled') &&
        !(j.archive && j.archive.state === 'saving'));
      const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_JOBS)));
      st.jobs = st.jobs.filter((j) => !drop.has(j));
      return job.id;
    });
    await pump();
    return { ok: true, jobId: id };
  },

  async GET_STATE() {
    const settings = await getSettings();
    let st = await readState();
    if (needsPump(st, settings.concurrency)) {
      await pump();
      st = await readState();
    }
    const live = await liveBytes();
    applyBadge(st, live);
    return { ok: true, jobs: st.jobs, live, settings };
  },

  async PAUSE(msg) {
    // In-flight files are left to finish: the endpoint sends Accept-Ranges:none,
    // so a paused transfer cannot resume and would restart from zero.
    await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      if (job && job.state === 'running') job.state = 'paused';
    });
    tellOffscreen({ target: 'offscreen', type: 'CONTROL', jobId: msg.jobId, action: 'pause' });
    await refreshBadge();
    return { ok: true };
  },

  async RESUME(msg) {
    await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      if (job && job.state === 'paused') job.state = 'running';
    });
    tellOffscreen({ target: 'offscreen', type: 'CONTROL', jobId: msg.jobId, action: 'resume' });
    await pump();
    return { ok: true };
  },

  async CANCEL(msg) {
    const ids = await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      if (!job) return [];
      job.state = 'cancelled';
      const active = [];
      for (const it of job.items) {
        if (it.state === 'active' && typeof it.downloadId === 'number') active.push(it.downloadId);
        else if (it.state === 'pending' || it.state === 'active') it.state = 'cancelled';
      }
      return active;
    });
    tellOffscreen({ target: 'offscreen', type: 'CONTROL', jobId: msg.jobId, action: 'cancel' });
    for (const id of ids) {
      try { await chrome.downloads.cancel(id); } catch (e) { /* already gone */ }
    }
    await maybeCloseOffscreen();
    // Cancelling frees a concurrency slot, and the ZIP slot: let whatever was
    // queued behind this job take its turn.
    await pump();
    return { ok: true };
  },

  async RETRY_FAILED(msg) {
    await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      if (!job) return;
      for (const it of job.items) {
        if (it.state === 'failed' || it.state === 'cancelled') {
          it.state = 'pending';
          it.attempts = 0;
          it.retryAt = 0;
          it.error = null;
        }
      }
      job.fatal = null;
      job.error = null;
      // An archive still being written to disk is not ours to forget - the
      // document holding its blob stays open until that download lands.
      if (!(job.archive && job.archive.state === 'saving')) job.archive = null;
      job.phase = 'fetching';
      job.started = false;
      job.state = 'running';
    });
    await pump();
    return { ok: true };
  },

  async DISMISS_JOB(msg) {
    // Forgetting a running job would leave its downloads in flight with nothing
    // tracking them, so stop it first. Callers that want it to keep running
    // should hide their own card instead of sending this.
    const running = await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      return !!job && (job.state === 'running' || job.state === 'paused');
    });
    if (running) await handlers.CANCEL(msg);

    await withState((st) => {
      st.jobs = st.jobs.filter((j) => j.id !== msg.jobId);
    });
    for (const k of Object.keys(zipLive)) if (k.startsWith(msg.jobId + ':')) delete zipLive[k];
    await maybeCloseOffscreen();
    await pump();
    return { ok: true };
  },

  async SHOW_DOWNLOADS() {
    chrome.downloads.showDefaultFolder();
    return { ok: true };
  },

  async SET_SETTINGS(msg) {
    const merged = Object.assign(await getSettings(), msg.settings || {});
    merged.concurrency = Math.max(1, Math.min(5, Number(merged.concurrency) || 3));
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    await pump();   // a raised concurrency should take effect immediately
    return { ok: true, settings: merged };
  },

  /* ---- from the offscreen document ---- */

  async ZIP_TICK(msg) {
    for (const [index, v] of Object.entries(msg.live || {})) {
      zipLive[msg.jobId + ':' + index] = v;
    }
    if (msg.items && msg.items.length) {
      await withState((st) => {
        const job = st.jobs.find((j) => j.id === msg.jobId);
        if (!job) return;
        if (msg.phase) job.phase = msg.phase;
        // Ticks already in flight when the user cancelled must not undo it.
        if (job.state === 'cancelled') return;
        for (const u of msg.items) {
          const it = job.items[u.index];
          if (!it) continue;
          it.state = u.state;
          it.error = u.error;
        }
      });
    } else if (msg.phase) {
      await withState((st) => {
        const job = st.jobs.find((j) => j.id === msg.jobId);
        if (job) job.phase = msg.phase;
      });
    }
    await refreshBadge();
    return { ok: true };
  },

  async ZIP_DONE(msg) {
    const settings = await getSettings();
    const started = await withState((st) => {
      const job = st.jobs.find((j) => j.id === msg.jobId);
      if (!job) return null;
      job.started = false;
      job.phase = 'done';
      if (msg.fatal) job.fatal = msg.fatal;
      if (msg.error) job.error = msg.error;
      // A job the user cancelled stays cancelled even if the builder finished
      // first and reported otherwise.
      const wasCancelled = job.state === 'cancelled' || msg.cancelled;
      job.state = wasCancelled ? 'cancelled' : 'done';
      if (msg.archive && !wasCancelled) {
        job.archive = {
          filename: P.downloadPath(settings.rootPrefix, '', msg.archive.filename),
          url: msg.archive.url,
          bytes: msg.archive.bytes,
          downloadId: null,
          state: 'saving'
        };
        return job.archive;
      }
      return null;
    });

    if (started) {
      let downloadId = null;
      let error = null;
      try {
        downloadId = await chrome.downloads.download({
          url: started.url,
          filename: started.filename,
          conflictAction: 'uniquify',
          saveAs: false
        });
      } catch (e) {
        error = String((e && e.message) || e);
      }

      /* A small archive can finish before this handler gets to write its id,
       * in which case onChanged already fired and matched nothing - leaving the
       * job stuck on "Saving the archive..." for ever. Settle it here instead
       * of relying on an event that has already been and gone. */
      let already = null;
      if (downloadId != null) {
        try {
          const [d] = await chrome.downloads.search({ id: downloadId });
          if (d && (d.state === 'complete' || d.state === 'interrupted')) already = d;
        } catch (e) { /* not in history yet; onChanged will do it */ }
      }

      await withState((st) => {
        const job = st.jobs.find((j) => j.id === msg.jobId);
        if (!job || !job.archive) return;
        job.archive.downloadId = downloadId;
        if (error) { job.archive.state = 'failed'; job.archive.error = error; }
        else if (already) {
          job.archive.state = already.state === 'complete' ? 'saved' : 'failed';
          if (already.state === 'interrupted') job.archive.error = already.error || 'interrupted';
        }
      });
    }

    for (const k of Object.keys(zipLive)) if (k.startsWith(msg.jobId + ':')) delete zipLive[k];
    await maybeCloseOffscreen();
    await pump();   // let the next queued archive take its turn
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  fn(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;   // response is async
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === RETRY_ALARM) reconcile().then(pump).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => reconcile().then(pump));
chrome.runtime.onInstalled.addListener(() => reconcile().then(pump));

// Cold start of the worker mid-job.
reconcile().then(pump).catch(() => {});
