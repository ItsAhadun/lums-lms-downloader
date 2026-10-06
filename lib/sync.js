/*
 * lib/sync.js - deciding which of a course's files are already on disk.
 *
 * One rule, chosen because a course folder that has been lived in stops
 * mirroring the LMS almost immediately: a file counts as present when a file
 * with the same name exists ANYWHERE under the folder, at any depth. Moving
 * "Lecture 4.pdf" from the LMS "Class Content" folder into a "Week 3" folder of
 * your own therefore does not make it missing again.
 *
 * The comparison runs one way only. A local file that the LMS has never heard
 * of - notes, scratch folders, a past semester's material - is not looked at
 * and is never reported, because nothing sensible could be done about it.
 *
 * The name compared is the basename of item.rel, which is what the downloader
 * itself writes to disk. So a folder this extension filled round-trips exactly,
 * and a folder filled by hand matches as long as the names were not changed.
 *
 * A name match is not the end of it, though: instructors replace "Module 2.pdf"
 * with a corrected one under the same name. A copy older than the LMS file and
 * of a different size counts as out of date, and is fetched again over itself.
 *
 * No import/export (see lib/paths.js for why).
 */
(function () {
  'use strict';

  function baseName(p) {
    var s = String(p == null ? '' : p);
    var i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
  }

  /* Compared case-insensitively: a course folder lives on a case-insensitive
   * filesystem more often than not, and "Lecture 4.PDF" is not a second file. */
  function nameKey(name) {
    return baseName(name).trim().toLowerCase();
  }

  /* Sakai's modifiedDate is "yyyyMMddHHmmssSSS" in GMT. NaN when absent. */
  function lmsTime(s) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : NaN;
  }

  /* Both tests, because each alone is wrong. Newer alone would refetch every
   * copy that came out of one of this extension's ZIPs, whose entry times are
   * the LMS's own and do not survive extraction exactly, plus anything an
   * instructor re-uploaded unchanged. A different size alone would overwrite a
   * copy you annotated after downloading it. Missing data on either side
   * reads as up to date. */
  function stale(item, local) {
    return local.size != null && item.bytes > 0 && local.size !== item.bytes &&
      lmsTime(item.modifiedDate) > local.mtime;
  }

  /* Index a flat scan of the local folder by filename.
   * `files` are { path, name, size, mtime }, path relative to the chosen
   * folder, mtime in ms. A name can occur more than once - the same PDF kept in
   * two places - so the value is the list, and the first hit is the one
   * reported. */
  function indexLocal(files) {
    var byName = new Map();
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      if (!f) continue;
      var k = nameKey(f.name != null ? f.name : f.path);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push({ path: f.path != null ? f.path : f.name, size: f.size, mtime: f.mtime });
    }
    return byName;
  }

  /* Split a course's items into the ones already on disk and the ones to
   * fetch. Order within each list is the order the LMS listed them. An item
   * whose every local copy is out of date goes in `missing` as a copy carrying
   * `replaces`, the path of the copy to write over. */
  function plan(items, index) {
    var missing = [];
    var present = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      var hits = index.get(nameKey(it.rel));
      if (!hits || !hits.length) missing.push(it);
      else if (hits.every(function (h) { return stale(it, h); })) {
        missing.push(Object.assign({}, it, { replaces: hits[0].path }));
      } else present.push({ item: it, at: hits[0].path });
    }
    return { missing: missing, present: present };
  }

  /* ---------- every course at once ---------- */

  /* The folder a course's archive extracts into: the first segment of the entry
   * names offscreen.js writes, under the same length budget. Matching on this,
   * not the raw title, is what lets a semester folder filled by extracting
   * those archives line up with the course list. */
  function courseFolder(title) {
    var P = globalThis.LUMS.paths;
    return P.downloadPath('', P.sanitizeSegment(title), 'x').split('/')[0];
  }

  /* Split a scan of a semester folder, paths "<course>/...", by course
   * folder. Keyed by lowercased folder name; each entry keeps the name as
   * it is on disk and its files with paths relative to it. Files loose at the
   * top belong to no course and are dropped. */
  function byFolder(files) {
    var out = new Map();
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      var segs = String(f.path).split('/');
      if (segs.length < 2) continue;
      var k = segs[0].toLowerCase();
      if (!out.has(k)) out.set(k, { name: segs[0], files: [] });
      out.get(k).files.push({ path: segs.slice(1).join('/'), name: f.name, size: f.size, mtime: f.mtime });
    }
    return out;
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    sync: {
      courseFolder: courseFolder,
      byFolder: byFolder,
      baseName: baseName,
      nameKey: nameKey,
      lmsTime: lmsTime,
      indexLocal: indexLocal,
      plan: plan
    }
  });
})();
