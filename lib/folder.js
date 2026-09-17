/*
 * lib/folder.js - talking to a folder on disk: picking one, remembering it,
 * reading what is in it, and writing a file into it.
 *
 * Shared by the Resources page (content.js), where syncing actually happens,
 * and by the standalone sync page, which covers the case of no course page
 * being open. Both need the same five things, and two copies of a permission
 * dance this fiddly would drift apart inside a week.
 *
 * Two ways of reading a folder, because Brave turns the File System Access API
 * off by default:
 *   - a directory handle, which can be remembered and written into
 *   - a directory <input>, which lists names and nothing else
 * `supported()` says which one is available. Everything below that works on a
 * handle is a no-op without one, and the caller falls back to `listing()`.
 *
 * A note on where the memory lives: a handle cannot be sent through
 * chrome.runtime messaging, which serialises through JSON, so it has to be
 * stored by whoever picked it. A folder picked on the LMS page is therefore
 * remembered against the LMS origin, and one picked on the sync page against
 * the extension's. Same code, two databases, and neither can see the other.
 *
 * No import/export (see lib/paths.js for why).
 */
(function () {
  'use strict';

  function supported() {
    return typeof showDirectoryPicker === 'function';
  }

  /* ---------- remembering ---------- */

  var DB_NAME = 'lums-sync';
  var STORE = 'folders';

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // A course is only the same course on the host it came from: the live LMS and
  // the archive mint their own ids.
  function key(origin, siteId) { return origin + '|' + siteId; }

  /* Every failure here is answered with null. A folder the browser has
   * forgotten is the same situation as one never picked, and both are handled
   * by asking for it again. */
  function dbDo(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function remember(origin, siteId, handle) {
    return dbDo('readwrite', function (s) { return s.put(handle, key(origin, siteId)); });
  }

  function recall(origin, siteId) {
    return dbDo('readonly', function (s) { return s.get(key(origin, siteId)); });
  }

  function forget(origin, siteId) {
    return dbDo('readwrite', function (s) { return s.delete(key(origin, siteId)); });
  }

  /* ---------- permission ---------- */

  var RW = { mode: 'readwrite' };

  /* 'granted' means it can be used right now. Anything else needs a click,
   * because requestPermission demands one - which is why callers of grant()
   * are all click handlers. */
  async function permissionState(handle) {
    try {
      return await handle.queryPermission(RW);
    } catch (e) {
      return 'denied';
    }
  }

  async function grant(handle) {
    try {
      if (await handle.queryPermission(RW) === 'granted') return true;
      return await handle.requestPermission(RW) === 'granted';
    } catch (e) {
      return false;
    }
  }

  /* Rejects with .aborted set when the picker was dismissed, so a caller can
   * tell "changed their mind" from "this browser will not do this". */
  async function pick() {
    try {
      // `id` makes the picker reopen where it was last used, which for someone
      // syncing four courses is four times out of five the right place.
      return await showDirectoryPicker({ id: 'lums-course-folder', mode: 'readwrite' });
    } catch (e) {
      var err = new Error(String((e && e.message) || e));
      err.aborted = !!e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      throw err;
    }
  }

  /* ---------- reading what is there ---------- */

  var MAX_DEPTH = 24;   // a tree this deep is a loop, not a course folder

  async function walk(handle, prefix, depth, out) {
    if (depth > MAX_DEPTH) return;
    for await (var entry of handle.entries()) {
      var name = entry[0];
      var child = entry[1];
      if (child.kind === 'directory') await walk(child, prefix + name + '/', depth + 1, out);
      else out.push({ path: prefix + name, name: name });
    }
  }

  async function scan(handle) {
    var out = [];
    await walk(handle, '', 0, out);
    return out;
  }

  /* The same shape, out of a directory <input>. Each File carries a
   * webkitRelativePath of "<folder>/Books/x.pdf". */
  function listing(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return files.map(function (f) {
      return { path: f.webkitRelativePath || f.name, name: f.name };
    });
  }

  function listingRoot(fileList) {
    var first = (fileList && fileList[0]) || null;
    return (first && String(first.webkitRelativePath || '').split('/')[0]) || '';
  }

  /* ---------- writing one file into it ---------- */

  function authError() {
    var e = new Error('Your LMS session has expired.');
    e.auth = true;
    return e;
  }

  /* Fetch `item` and write it to `target`, a path relative to `dir`, creating
   * the folders on the way. Throws on anything that stops that happening. */
  async function fetchInto(dir, target, item) {
    var res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw authError();
      throw new Error('HTTP ' + res.status);
    }
    // Sakai answers an expired session with the login page: 200, and HTML. Left
    // unchecked, that page lands on disk named Lecture 4.pdf, and every later
    // comparison then reads the lecture as already downloaded.
    var ct = res.headers.get('content-type') || '';
    if (/text\/html/i.test(ct) && !/^data:/.test(item.url) && !/\.html?$/i.test(target)) throw authError();

    var segs = target.split('/');
    var name = segs.pop();
    var folder = dir;
    for (var i = 0; i < segs.length; i++) {
      folder = await folder.getDirectoryHandle(segs[i], { create: true });
    }

    var file = await folder.getFileHandle(name, { create: true });
    try {
      // pipeTo closes the writable, and closing is what commits the swap file
      // over the real one, so a body that stops mid-stream leaves no fragment.
      await res.body.pipeTo(await file.createWritable());
    } catch (e) {
      // getFileHandle already made an empty file. Left there, it would answer to
      // this name in the next comparison and the real file would never come.
      try { await folder.removeEntry(name); } catch (e2) { /* nothing to undo */ }
      throw e;
    }
  }

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    folder: {
      supported: supported,
      remember: remember,
      recall: recall,
      forget: forget,
      permissionState: permissionState,
      grant: grant,
      pick: pick,
      scan: scan,
      listing: listing,
      listingRoot: listingRoot,
      fetchInto: fetchInto
    }
  });
})();
