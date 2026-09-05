/*
 * offscreen.js - fetches a course's files and builds the archive.
 *
 * Why an offscreen document rather than the service worker: a worker has no
 * URL.createObjectURL, and chrome.downloads needs a URL for the finished blob.
 * Why not the LMS page, where this used to live: the page dies when the tab
 * closes, and with it the archive. This document outlives both the tab and a
 * napping worker, which is what makes ZIP mode survive closing the tab.
 *
 * Offscreen documents may only use chrome.runtime, so everything else - the
 * job state of record, the download itself - is the worker's business. This
 * file fetches, zips, and reports.
 *
 * Exactly one archive is built at a time: an extension may hold only one
 * offscreen document, and two ZipWriters would double peak memory for nothing.
 * Each run still owns its state in a closure rather than reading a shared
 * variable, so a cancelled run winding down can never touch the next one.
 */
(function () {
  'use strict';

  const P = globalThis.LUMS.paths;
  const Zip = globalThis.LUMS.zip;

  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1000, 4000, 10000];
  const STALL_MS = 60000;    // no bytes for this long: the connection is dead
  const TICK_MS = 400;

  let current = null;        // the run the CONTROL messages address

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const post = (msg) => {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});   // worker asleep mid-restart
    } catch (e) { /* extension unloading */ }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return false;

    if (msg.type === 'START') {
      run(msg.job).catch((e) => {
        post({ type: 'ZIP_DONE', jobId: msg.job.id, error: String((e && e.message) || e) });
      });
    } else if (msg.type === 'CONTROL' && current && current.id === msg.jobId) {
      if (msg.action === 'pause' && current.state === 'running') current.state = 'paused';
      else if (msg.action === 'resume' && current.state === 'paused') current.state = 'running';
      else if (msg.action === 'cancel') current.state = 'cancelled';
    }
    return false;   // never answers synchronously; the worker does not wait
  });

  // Sakai's modifiedDate is "yyyyMMddHHmmssSSS"; kept so the zip carries real times.
  function sakaiDate(s) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date();
  }

  function authError() {
    const e = new Error('Your LMS session has expired.');
    e.auth = true;
    return e;
  }

  async function run(spec) {
    // One archive at a time. A run that has stopped no longer holds the slot.
    if (current && current.state === 'running') return;

    const j = {
      id: spec.id,
      state: 'running',
      phase: 'fetching',
      fatal: null,
      dirty: new Set(),
      // A retry re-sends every item so tick indices still line up, but the ones
      // already inside the archive that saved start done and are not fetched
      // again.
      items: spec.items.map((it, i) => Object.assign({}, it, {
        index: i, state: it.done ? 'done' : 'pending',
        attempts: 0, retryAt: 0, received: it.done ? it.bytes : 0, total: 0, error: null
      }))
    };
    current = j;

    const zip = new Zip.ZipWriter();
    const taken = new Set();
    const todo = j.items.filter((it) => it.state === 'pending').length;
    // Wrapping one PDF in an archive just makes the reader unpack it again.
    const single = todo === 1;
    let singleChunks = null;
    let singleName = '';
    let produced = 0;
    const conc = Math.max(1, Math.min(5, Number(spec.concurrency) || 3));

    /* Item states and byte counts go back in one batched tick rather than a
     * message per event. The worker persists every item state it is told about,
     * so an unbatched stream would mean a full state write per chunk. */
    function flush(phase) {
      const items = [];
      j.dirty.forEach((i) => {
        const it = j.items[i];
        items.push({ index: i, state: it.state, error: it.error || null });
      });
      j.dirty.clear();

      const live = {};
      for (const it of j.items) {
        if (it.state === 'active') live[it.index] = { received: it.received, total: it.total || it.bytes || 0 };
      }
      post({ type: 'ZIP_TICK', jobId: j.id, items, live, phase: phase || j.phase });
    }

    function mark(it, state, error) {
      it.state = state;
      it.error = error || null;
      j.dirty.add(it.index);
    }

    function stopping() {
      return current !== j || j.state === 'cancelled' || j.fatal;
    }

    /* Streams one file, computing its CRC as chunks arrive so the bytes never
     * have to be concatenated into one contiguous array. Returns the chunk list
     * for ZipWriter.add, which turns it into a single disk-backed Blob. */
    async function fetchBody(it) {
      const ctrl = new AbortController();
      let lastByteAt = Date.now();

      // A connection that stops sending holds a worker slot for ever, and three
      // of them deadlock the job behind a frozen progress bar.
      const watchdog = setInterval(() => {
        if (stopping() || Date.now() - lastByteAt > STALL_MS) ctrl.abort();
      }, 1000);

      try {
        const res = await fetch(it.url, { credentials: 'include', signal: ctrl.signal });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) throw authError();
          throw new Error('HTTP ' + res.status);
        }

        // Sakai answers an expired session with the login page - 200, and HTML.
        // Without this check the login page gets zipped up as someone's lecture
        // slides, which is the "downloaded files are tiny" report in the README.
        const ct = res.headers.get('content-type') || '';
        if (/text\/html/i.test(ct) && !/^data:/.test(it.url) && !/\.html?$/i.test(it.rel)) throw authError();

        it.total = Number(res.headers.get('content-length')) || it.bytes || 0;

        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        let crc = 0;   // a 0 seed is the standard initial value; see zip.js

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (stopping()) {
            reader.cancel().catch(() => {});
            throw new Error('cancelled');
          }
          lastByteAt = Date.now();
          chunks.push(value);
          crc = Zip.crc32(value, crc);
          size += value.length;
          it.received = size;
        }
        return { chunks, size, crc };
      } finally {
        clearInterval(watchdog);
      }
    }

    function nextItem() {
      const now = Date.now();
      let waiting = false;
      for (const it of j.items) {
        if (it.state !== 'pending') continue;
        if (it.retryAt && it.retryAt > now) { waiting = true; continue; }
        return it;
      }
      return waiting ? 'wait' : null;
    }

    function onFailure(it, e) {
      if (j.state === 'cancelled') { mark(it, 'cancelled'); return; }

      // One expired session fails every remaining file identically. Retrying
      // all of them through the backoff ladder only delays the message that
      // actually helps.
      if (e && e.auth) {
        j.fatal = 'auth';
        mark(it, 'failed', 'session expired');
        return;
      }

      it.attempts++;
      const why = String((e && e.message) || e);
      if (it.attempts >= MAX_ATTEMPTS) {
        mark(it, 'failed', why);
      } else {
        // No range support on this endpoint, so a retry restarts the whole file.
        it.retryAt = Date.now() + BACKOFF_MS[Math.min(it.attempts - 1, BACKOFF_MS.length - 1)];
        it.received = 0;
        mark(it, 'pending', why);
      }
    }

    async function worker() {
      for (;;) {
        while (j.state === 'paused' && current === j) await sleep(200);
        if (stopping()) return;

        const it = nextItem();
        if (it === null) return;
        if (it === 'wait') { await sleep(200); continue; }

        it.received = 0;
        mark(it, 'active');

        try {
          const body = await fetchBody(it);
          if (stopping()) return;

          if (single) {
            singleChunks = body.chunks;
            singleName = it.rel;
          } else {
            // Same length budget as files mode, so an archive built here
            // extracts on Windows as reliably as a direct download lands there,
            // and the same uniquifying chrome.downloads gives the other mode.
            const name = P.uniqueName(taken, P.downloadPath('', spec.courseFolder, it.rel));
            if (zip.wouldOverflow(name, body.size)) {
              j.fatal = 'toobig';
              mark(it, 'failed', 'archive full');
              return;
            }
            zip.add(name, body, sakaiDate(it.modifiedDate));
          }
          produced++;
          it.received = it.bytes;
          mark(it, 'done');
        } catch (e) {
          onFailure(it, e);
        }
      }
    }

    const heartbeat = setInterval(() => { if (current === j) flush(); }, TICK_MS);
    try {
      await Promise.all(Array.from({ length: Math.min(conc, j.items.length) }, worker));
    } finally {
      clearInterval(heartbeat);
    }

    // A newer run took the slot while this one was winding down; it owns the
    // reporting from here.
    if (current !== j) return;

    // Stop holding the one-archive-at-a-time slot: the fetching is over, and
    // the next queued archive may start while this one is being assembled.
    const cancelled = j.state === 'cancelled';
    j.state = cancelled ? 'cancelled' : 'finishing';

    for (const it of j.items) {
      if (it.state === 'active' || it.state === 'pending') {
        mark(it, j.fatal ? 'failed' : 'cancelled', j.fatal === 'auth' ? 'session expired' : null);
      }
    }

    if (cancelled) {
      flush('done');
      post({ type: 'ZIP_DONE', jobId: j.id, cancelled: true });
      return;
    }

    // Nothing new landed, so there is nothing to hand over. Counting what this
    // run produced, not what is marked done, keeps a retry that failed outright
    // from shipping an empty archive.
    if (!produced) {
      flush('done');
      post({ type: 'ZIP_DONE', jobId: j.id, fatal: j.fatal });
      return;
    }

    j.phase = 'archiving';
    flush('archiving');

    let archive = null;
    try {
      const blob = single && singleChunks ? new Blob(singleChunks) : zip.blob();
      const filename = single
        ? P.sanitizeSegment(String(singleName).split('/').pop())
        : spec.courseFolder + (spec.scopeLabel ? ' - ' + P.sanitizeSegment(spec.scopeLabel) : '') + '.zip';
      // The URL is freed when the worker closes this document, which it does
      // once the download has landed - only the worker sees that happen.
      archive = { url: URL.createObjectURL(blob), filename: filename, bytes: blob.size };
    } catch (e) {
      post({ type: 'ZIP_DONE', jobId: j.id, error: String((e && e.message) || e) });
      return;
    }

    post({ type: 'ZIP_DONE', jobId: j.id, fatal: j.fatal, archive: archive });
  }
})();
