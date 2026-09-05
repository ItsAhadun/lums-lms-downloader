/*
 * lib/paths.js - filename sanitising and download-path construction.
 *
 * Contains no `import`/`export`, which makes it valid BOTH as a classic script
 * (content script, popup <script>, offscreen document) and as an ES module
 * (background service worker, node --test). It communicates through
 * globalThis.LUMS.
 *
 * Why this file is the one with tests: chrome.downloads.download() rejects a
 * surprising number of filenames, and a rejection stalls the whole job with
 * nothing but "Invalid filename" in a console nobody is watching.
 */
(function () {
  'use strict';

  // Illegal on Windows and/or rejected by chrome.downloads. Forward slash is
  // included because segments are sanitised individually; the separator is
  // re-added by the joiner.
  var ILLEGAL = /[<>:"|?*\\/\x00-\x1f\x7f]/g;

  // Windows reserved device names. Chrome refuses these even with an extension.
  var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  var MAX_PATH = 200;   // full relative path budget (spec 5.3)
  var MAX_DIR_SEGMENT = 60;

  var MIME_EXT = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/x-rar-compressed': '.rar',
    'application/x-7z-compressed': '.7z',
    'application/rtf': '.rtf',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a'
  };

  function extFromMime(mime) {
    var key = String(mime || '').toLowerCase().split(';')[0].trim();
    return MIME_EXT[key] || '';
  }

  /* Split "name.ext" -> ["name", ".ext"]. Returns an empty extension when there
   * is no dot, when the dot leads (".bashrc" is all name), when the name ends in
   * a dot, or when the tail is too long to plausibly be an extension. */
  function splitExt(name) {
    var s = String(name);
    var i = s.lastIndexOf('.');
    if (i <= 0 || i === s.length - 1) return [s, ''];
    var ext = s.slice(i);
    if (ext.length > 11 || /\s/.test(ext)) return [s, ''];
    return [s.slice(0, i), ext];
  }

  /* Make one path segment safe. Never returns '', '.', '..', or a reserved
   * device name, so '..' traversal and empty segments are impossible by
   * construction rather than by a separate check. */
  function sanitizeSegment(seg) {
    var s = String(seg == null ? '' : seg).replace(ILLEGAL, '_');
    s = s.replace(/^[.\s~]+/, '').replace(/[.\s]+$/, '');
    if (!s) return '_';
    var parts = splitExt(s);
    if (RESERVED.test(parts[0])) s = parts[0] + '_' + parts[1];
    return s;
  }

  /* Sanitise a whole relative path, dropping empty segments. Used for the
   * user-configurable root prefix, which may legitimately contain slashes. */
  function sanitizePath(p) {
    return String(p == null ? '' : p)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(sanitizeSegment)
      .join('/');
  }

  /* The display name for an item: item.title is authoritative. Sakai mangles the
   * URL path ('&' -> '_', parens -> '_') but leaves title intact, so the URL is
   * never used for naming. Adds an extension from the MIME type when the title
   * has none.
   *
   * Reads the MIME from either field it travels under: `type` on a raw Sakai
   * entry, `mime` on a normalised item. They used to differ silently, so any
   * caller re-deriving a name from a stored item lost the extension.
   */
  function fileName(item) {
    var title = String((item && item.title) || '').trim();
    if (!title) title = 'untitled';
    if (!splitExt(title)[1]) title += extFromMime(item && (item.mime || item.type));
    return sanitizeSegment(title);
  }

  /* Folder path of an item, relative to the site root.
   * item.container looks like "/content/group/{siteId}/Books/" and is decoded. */
  function folderPath(item, siteId) {
    var prefix = '/content/group/' + siteId + '/';
    var container = String((item && item.container) || '');
    var folder = container.indexOf(prefix) === 0 ? container.slice(prefix.length) : '';
    return folder.split('/').filter(Boolean).map(sanitizeSegment);
  }

  /* Site-relative path for an item: "Books/Clayton_part_1.pdf". Uncapped -
   * downloadPath() applies the length budget once the full path is known. */
  function relPath(item, siteId) {
    return folderPath(item, siteId).concat([fileName(item)]).join('/');
  }

  function truncateSegment(seg, max) {
    if (seg.length <= max) return seg;
    var parts = splitExt(seg);
    var room = max - parts[1].length;
    if (room < 1) return seg.slice(0, max).replace(/[.\s]+$/, '') || '_';
    return (parts[0].slice(0, room).replace(/[.\s]+$/, '') || '_') + parts[1];
  }

  /* Join root prefix + course folder + relative path into the value handed to
   * chrome.downloads.download, enforcing the MAX_PATH budget. Directory
   * segments are clipped first, then the basename, so the extension survives.
   *
   * ZIP mode runs entry names through this too, with an empty root prefix: an
   * archive with a 400-character entry extracts fine on Linux and fails on
   * Windows, so the budget belongs on both paths, not just the downloads one. */
  function downloadPath(rootPrefix, courseFolder, rel) {
    var segs = []
      .concat(sanitizePath(rootPrefix).split('/'))
      .concat(sanitizePath(courseFolder).split('/'))
      .concat(sanitizePath(rel).split('/'))
      .filter(Boolean);

    if (!segs.length) return '_';

    var last = segs.length - 1;
    for (var i = 0; i < last; i++) segs[i] = truncateSegment(segs[i], MAX_DIR_SEGMENT);

    var dirLen = last > 0 ? segs.slice(0, last).join('/').length + 1 : 0;
    segs[last] = truncateSegment(segs[last], Math.max(1, MAX_PATH - dirLen));
    return segs.join('/');
  }

  /* Reserve `path` in the Set `taken`, appending " (1)", " (2)" ... until free.
   *
   * chrome.downloads gives files mode this for free via conflictAction:
   * 'uniquify'. A ZIP archive has no equivalent, and two entries sharing a name
   * is undefined behaviour across extractors. Collisions are rare but real:
   * sanitising maps "A&B.pdf" and "A?B.pdf" onto one name, and so does
   * truncating two long titles that share a prefix.
   *
   * Compared case-insensitively, because the archive is extracted onto a
   * case-insensitive filesystem more often than not. */
  function uniqueName(taken, path) {
    var p = String(path);
    if (!taken.has(p.toLowerCase())) { taken.add(p.toLowerCase()); return p; }

    var cut = p.lastIndexOf('/');
    var dir = cut < 0 ? '' : p.slice(0, cut + 1);
    var parts = splitExt(cut < 0 ? p : p.slice(cut + 1));

    for (var n = 1; n < 100000; n++) {
      var next = dir + parts[0] + ' (' + n + ')' + parts[1];
      if (!taken.has(next.toLowerCase())) { taken.add(next.toLowerCase()); return next; }
    }
    return p;   // unreachable in practice, but never loop forever over a name
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    paths: {
      sanitizeSegment: sanitizeSegment,
      sanitizePath: sanitizePath,
      splitExt: splitExt,
      extFromMime: extFromMime,
      fileName: fileName,
      folderPath: folderPath,
      relPath: relPath,
      downloadPath: downloadPath,
      uniqueName: uniqueName,
      MAX_PATH: MAX_PATH
    }
  });
})();
