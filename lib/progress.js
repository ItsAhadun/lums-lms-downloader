/*
 * lib/progress.js - the progress model shared by the in-page panel, the popup
 * and the toolbar badge, so the three can never disagree about what "63%" means.
 *
 * No import/export (see lib/paths.js for why).
 */
(function () {
  'use strict';

  var UNITS = ['B', 'KB', 'MB', 'GB'];

  function formatBytes(n) {
    var v = Number(n) || 0;
    var i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + UNITS[i];
  }

  function pct(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  /* Bytes for one item. Completed items count their full manifest size; the
   * in-flight ones come from chrome.downloads (`live` is keyed by downloadId).
   * Content-Length is always present on this endpoint, so this is exact. */
  function itemBytes(item, live) {
    if (item.state === 'done') return item.bytes || 0;
    if (item.state === 'active' && live && live[item.downloadId]) {
      return live[item.downloadId].received || 0;
    }
    return 0;
  }

  function itemPercent(item, live) {
    if (item.state === 'done') return 100;
    if (item.state !== 'active') return 0;
    var l = live && live[item.downloadId];
    if (!l) return 0;
    return pct(l.received, l.total > 0 ? l.total : (item.bytes || 0));
  }

  /* Overall figures for a job. The denominator is known upfront from the
   * manifest, so no HEAD requests are needed to show an exact percentage. */
  function jobProgress(job, live) {
    var totals = job.totals || {};
    var received = 0;
    for (var i = 0; i < job.items.length; i++) received += itemBytes(job.items[i], live);
    return {
      receivedBytes: received,
      totalBytes: totals.bytes || 0,
      percent: pct(received, totals.bytes || 0),
      doneFiles: totals.doneFiles || 0,
      totalFiles: totals.files || 0,
      failed: totals.failed || 0,
      cancelled: totals.cancelled || 0
    };
  }

  /* "9 / 14 files - 88.1 MB / 139.5 MB" */
  function progressLine(p) {
    return p.doneFiles + ' / ' + p.totalFiles + ' files · ' +
      formatBytes(p.receivedBytes) + ' / ' + formatBytes(p.totalBytes);
  }

  /* "14 files - 139.5 MB - 2 failed" */
  function summaryLine(job) {
    var t = job.totals || {};
    var parts = [
      (t.doneFiles || 0) + ' of ' + (t.files || 0) + ' files',
      formatBytes(t.doneBytes || 0)
    ];
    if (t.failed) parts.push(t.failed + ' failed');
    if (t.cancelled) parts.push(t.cancelled + ' cancelled');
    return parts.join(' · ');
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    progress: {
      formatBytes: formatBytes,
      pct: pct,
      itemBytes: itemBytes,
      itemPercent: itemPercent,
      jobProgress: jobProgress,
      progressLine: progressLine,
      summaryLine: summaryLine
    }
  });
})();
