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

  async function fetchSites(origin) {
    var r = await getJson('/direct/site.json', origin);
    if (r.error) return r;
    var list = (r.data && r.data.site_collection) || [];
    return {
      sites: list
        .filter(function (s) { return s && s.id; })
        .map(function (s) { return { id: s.id, title: s.title || s.id, type: s.type || '' }; })
    };
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
      normalize: normalize,
      fetchSiteContent: fetchSiteContent,
      fetchSites: fetchSites,
      fetchSiteTitle: fetchSiteTitle
    }
  });
})();
