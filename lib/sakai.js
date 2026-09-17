/*
 * lib/sakai.js - Sakai Entity Broker client.
 *
 * These calls must run where the session cookie is attached same-origin, i.e.
 * in a content script on an LMS tab. The popup relays through one.
 *
 * Every call is addressed to an origin, because the live LMS and the archive
 * are separate Sakai installs with separate sessions and separate course lists.
 *
 * No import/export (see lib/paths.js for why).
 */
(function () {
  'use strict';

  /* Every Sakai host this extension serves. The archive runs the same Sakai as
   * the live LMS, so one client covers both; only the host differs. Keep this
   * in step with host_permissions and the content-script matches in
   * manifest.json - a host missing there fails with an opaque fetch error. */
  var ORIGINS = [
    'https://lms.lums.edu.pk',
    'https://lmsarchive-2026.lums.edu.pk'
  ];

  /* A content script already runs on one of these, and that is the only origin
   * whose cookie it can use, so its own is always the right answer. The popup
   * belongs to no host and names the one it wants explicitly. */
  function defaultOrigin() {
    var here = (globalThis.location && globalThis.location.origin) || '';
    return ORIGINS.indexOf(here) >= 0 ? here : ORIGINS[0];
  }

  /* "https://lms.lums.edu.pk" -> "lms.lums.edu.pk", for anything shown to a
   * person: the scheme is noise in a sentence telling them where to sign in. */
  function hostLabel(origin) {
    return String(origin || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  /* Run an API call on an open tab of THAT host, falling back to a fetch from
   * here. Only a tab on the same origin can answer for it: a live-LMS tab would
   * happily return the live course list for an archive request.
   *
   * Extension pages only - a content script has no chrome.tabs, and its own
   * origin is already the right one.
   */
  async function relay(origin, msg, fallback) {
    var tabs = [];
    try { tabs = await chrome.tabs.query({ url: origin + '/portal/*' }); } catch (e) { /* none */ }
    for (var i = 0; i < tabs.length; i++) {
      try {
        var r = await chrome.tabs.sendMessage(tabs[i].id, Object.assign({ origin: origin }, msg));
        if (r) return r;
      } catch (e) { /* no content script in that tab */ }
    }
    return fallback();
  }

  /* Sakai lies with status codes, so the response is classified by shape:
   *  - logged out  -> /direct/* redirects to an HTML login page, still 200
   *  - no access   -> 200 with an empty content_collection (also the 404 path)
   * Never trust res.status; check the content type and the payload. */
  async function getJson(path, origin) {
    var res;
    try {
      res = await fetch((origin || defaultOrigin()) + path, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
    } catch (e) {
      return { error: 'network', message: String((e && e.message) || e) };
    }
    var ct = res.headers.get('content-type') || '';
    if (/\/login/i.test(res.url) || !/json/i.test(ct)) return { error: 'auth' };
    try {
      return { data: await res.json() };
    } catch (e) {
      return { error: 'auth' };
    }
  }

  /* Sakai's own path for an entry, e.g. "/access/content/group/{siteId}/Books/x.pdf".
   * Kept separately from item.url because url is rewritten for web-link items,
   * and because it is what the Resources table's row attributes contain - which
   * is how a row in the DOM is matched back to an entry from the API. */
  function pathOf(u, origin) {
    try { return new URL(u, origin || defaultOrigin()).pathname; } catch (e) { return ''; }
  }

  function shortcutUrl(webLinkUrl) {
    var body = '[InternetShortcut]\r\nURL=' + webLinkUrl + '\r\n';
    return {
      url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(body),
      bytes: body.length
    };
  }

  /* Flatten the recursive-but-flat content_collection into download items.
   * `size` is bytes for files but a child count for collections, so only
   * non-collections are summed. */
  function normalize(json, siteId, opts, origin) {
    opts = opts || {};
    var all = (json && json.content_collection) || [];
    if (!all.length) return { error: 'empty' };

    var items = [];
    var skipped = { hidden: 0, links: 0, empty: 0 };
    var totalBytes = 0;

    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.type === 'collection') continue;
      if (!opts.includeHidden && (e.hidden === true || e.visible === false)) {
        skipped.hidden++;
        continue;
      }

      var item = {
        url: e.url,
        path: pathOf(e.url, origin),
        title: e.title || '',
        rel: globalThis.LUMS.paths.relPath(e, siteId),
        folder: globalThis.LUMS.paths.folderPath(e, siteId).join('/'),
        bytes: Number(e.size) || 0,
        mime: e.type || '',
        modifiedDate: e.modifiedDate || ''
      };

      if (e.webLinkUrl) {
        if (opts.webLinks !== 'save') { skipped.links++; continue; }
        var sc = shortcutUrl(e.webLinkUrl);
        item.url = sc.url;
        item.bytes = sc.bytes;
        // Name it from the title alone - the MIME type of a shortcut describes
        // its target, so deriving an extension from it gives "Link.html.url".
        var base = globalThis.LUMS.paths.sanitizeSegment(item.title || 'link');
        if (!/\.url$/i.test(base)) base += '.url';
        item.rel = item.folder ? item.folder + '/' + base : base;
      }

      if (!item.url) { skipped.empty++; continue; }

      totalBytes += item.bytes;
      items.push(item);
    }

    if (!items.length) return { error: 'empty', skipped: skipped };
    return { items: items, totalBytes: totalBytes, skipped: skipped };
  }

  async function fetchSiteContent(siteId, opts, origin) {
    var r = await getJson('/direct/content/site/' + encodeURIComponent(siteId) + '.json', origin);
    if (r.error) return r;
    return normalize(r.data, siteId, opts, origin);
  }

  /* /direct/site.json is a paged collection. Asked without _start and _limit it
   * serves one short page - 10 on the LUMS hosts - and says nothing about the
   * rest, so the archive shows its oldest semester and drops every one after
   * it. Walk the pages instead.
   *
   * _start advances by the rows that came back, never by SITES_PAGE: a host
   * free to cap the page below what was asked for would otherwise leave a hole
   * the size of the difference on every step.
   *
   * Two guards, because a Sakai build that ignores _start re-serves page one
   * for ever: ids already seen are dropped, and a page that adds nobody new
   * ends the walk. The same test settles the last page, at the cost of one
   * request past the end. */
  var SITES_PAGE = 100;
  var SITES_MAX_REQUESTS = 50;

  async function fetchSites(origin) {
    var sites = [];
    var seen = Object.create(null);
    var start = 0;

    for (var n = 0; n < SITES_MAX_REQUESTS; n++) {
      var r = await getJson(
        '/direct/site.json?_start=' + start + '&_limit=' + SITES_PAGE,
        origin
      );
      // Courses already in hand beat an error page: losing the tail of the
      // list is better than showing none of it.
      if (r.error) return sites.length ? { sites: sites } : r;

      var list = (r.data && r.data.site_collection) || [];
      if (!list.length) break;
      start += list.length;

      var added = 0;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.id || seen[s.id]) continue;
        seen[s.id] = true;
        sites.push({ id: s.id, title: s.title || s.id, type: s.type || '' });
        added++;
      }
      if (!added) break;
    }

    return { sites: sites };
  }

  async function fetchSiteTitle(siteId, origin) {
    var r = await getJson('/direct/site/' + encodeURIComponent(siteId) + '.json', origin);
    if (r.error) return r;
    return { title: (r.data && r.data.title) || siteId };
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    sakai: {
      ORIGINS: ORIGINS,
      defaultOrigin: defaultOrigin,
      hostLabel: hostLabel,
      relay: relay,
      normalize: normalize,
      fetchSiteContent: fetchSiteContent,
      fetchSites: fetchSites,
      fetchSiteTitle: fetchSiteTitle
    }
  });
})();
