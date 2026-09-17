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

  /* Index a flat scan of the local folder by filename.
   * `files` are { path, name }, path relative to the chosen folder.
   * A name can occur more than once - the same PDF kept in two places - so the
   * value is the list, and the first hit is the one reported. */
  function indexLocal(files) {
    var byName = new Map();
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      if (!f) continue;
      var k = nameKey(f.name != null ? f.name : f.path);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(f.path != null ? f.path : f.name);
    }
    return byName;
  }

  /* Split a course's items into the ones already on disk and the ones to
   * fetch. Order within each list is the order the LMS listed them. */
  function plan(items, index) {
    var missing = [];
    var present = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i];
      var hits = index.get(nameKey(it.rel));
      if (hits && hits.length) present.push({ item: it, at: hits[0] });
      else missing.push(it);
    }
    return { missing: missing, present: present };
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    sync: {
      baseName: baseName,
      nameKey: nameKey,
      indexLocal: indexLocal,
      plan: plan
    }
  });
})();
