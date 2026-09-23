/*
 * links.js - course links open Resources, on every /portal/ page.
 *
 * Runs at document_start, apart from content.js, so the click listener is in
 * place before the sidebar can be clicked. At document_idle it was not: on a
 * cold cache (a fresh browser, straight after signing in) Sakai's module
 * scripts hold DOMContentLoaded back while the sidebar is already on screen,
 * and the first course clicked in that window opened Overview.
 *
 * A course link in the sidebar points at the site root, which Sakai renders
 * as Overview. With the setting on, a click on one goes to that course's
 * Resources tool instead. Links to a specific tool or page inside a course
 * are left alone, so Overview stays one click away.
 *
 * Matched by URL, never by sidebar markup, so a Sakai upgrade that restyles
 * the sidebar does not break it. Any failure falls back to the original link.
 */
(function courseLinksOpenResources() {
  'use strict';

  const Sakai = globalThis.LUMS.sakai;
  const SETTINGS_KEY = 'lums:settings';
  const SITE_ROOT = /^\/portal\/site\/([0-9a-f-]{36})\/?$/i;

  let enabled = true;   // default on, until storage says otherwise
  chrome.storage.local.get(SETTINGS_KEY).then((o) => {
    enabled = ((o && o[SETTINGS_KEY]) || {}).openResources !== false;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      enabled = ((changes[SETTINGS_KEY].newValue) || {}).openResources !== false;
    }
  });

  // siteId -> resources URL, or null for a course without Resources.
  // Errors are not cached: an expired session should not stick for the tab.
  const known = new Map();
  const pending = new Map();

  function resolve(siteId) {
    if (known.has(siteId)) return Promise.resolve(known.get(siteId));
    if (!pending.has(siteId)) {
      pending.set(siteId, Sakai.fetchResourcesUrl(siteId, location.origin).then((r) => {
        pending.delete(siteId);
        if (r.error) return null;
        known.set(siteId, r.url);
        return r.url;
      }));
    }
    return pending.get(siteId);
  }

  function courseOf(target) {
    const a = target && target.closest && target.closest('a[href]');
    if (!a) return null;
    let u;
    try { u = new URL(a.href, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin) return null;
    const m = u.pathname.match(SITE_ROOT);
    return m ? { a: a, siteId: m[1] } : null;
  }

  // Look it up while the pointer is still on its way, so the click itself
  // rarely waits on the network.
  const warm = (e) => {
    if (!enabled) return;
    const c = courseOf(e.target);
    if (c) resolve(c.siteId);
  };
  window.addEventListener('pointerover', warm, true);
  window.addEventListener('focusin', warm, true);

  function onClick(e) {
    if (!enabled || e.defaultPrevented) return;
    if (e.button !== 0 && e.button !== 1) return;
    const c = courseOf(e.target);
    if (!c) return;
    const newTab = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey ||
      (c.a.target && c.a.target !== '_self');

    if (known.has(c.siteId)) {
      const url = known.get(c.siteId);
      if (!url) return;   // no Resources tool: let the link do its job
      e.preventDefault();
      e.stopImmediatePropagation();
      if (newTab) window.open(url, '_blank'); else location.assign(url);
      return;
    }

    // Not looked up yet. A new tab has to open inside the click, before any
    // await, or the browser blocks it - so that case keeps the plain link.
    if (newTab) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const fallback = c.a.href;
    resolve(c.siteId).then((url) => location.assign(url || fallback));
  }
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);
})();
