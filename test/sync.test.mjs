import test from 'node:test';
import assert from 'node:assert/strict';

// Neither file has import/export; importing evaluates them and populates
// globalThis.LUMS, exactly as the <script> tags in sync.html do.
import '../lib/paths.js';
import '../lib/sync.js';
const S = globalThis.LUMS.sync;

const item = (rel) => ({ rel, title: S.baseName(rel), bytes: 1024 });
const local = (...paths) => S.indexLocal(paths.map((p) => ({ path: p, name: S.baseName(p) })));

test('a file sitting at its LMS path is present', () => {
  const r = S.plan([item('Books/Clayton_part_1.pdf')], local('Books/Clayton_part_1.pdf'));
  assert.equal(r.missing.length, 0);
  assert.equal(r.present[0].at, 'Books/Clayton_part_1.pdf');
});

test('a file moved into a folder of your own is still present', () => {
  const r = S.plan([item('Class Content/Lecture 4.pdf')], local('Week 3/notes/Lecture 4.pdf'));
  assert.equal(r.missing.length, 0);
  assert.equal(r.present[0].at, 'Week 3/notes/Lecture 4.pdf');
});

test('a file sitting loose at the top of the folder is present', () => {
  const r = S.plan([item('Books/Clayton_part_1.pdf')], local('Clayton_part_1.pdf'));
  assert.equal(r.missing.length, 0);
});

test('a file the folder does not have is missing', () => {
  const r = S.plan([item('Books/Clayton_part_2.pdf')], local('Books/Clayton_part_1.pdf'));
  assert.equal(r.present.length, 0);
  assert.equal(r.missing[0].rel, 'Books/Clayton_part_2.pdf');
});

test('local files the LMS has never heard of are ignored entirely', () => {
  const r = S.plan(
    [item('Books/Clayton_part_1.pdf')],
    local('Books/Clayton_part_1.pdf', '_scratch/todo.md', 'Claude outputs/revision-sheet.html', 'CLAUDE.md')
  );
  assert.equal(r.missing.length, 0);
  assert.equal(r.present.length, 1);
});

test('case differs, file is the same file', () => {
  const r = S.plan([item('Books/Lecture 4.pdf')], local('books/LECTURE 4.PDF'));
  assert.equal(r.missing.length, 0);
});

test('surrounding whitespace does not make a second file', () => {
  const r = S.plan([item('Books/Lecture 4.pdf')], local('Books/Lecture 4.pdf '));
  assert.equal(r.missing.length, 0);
});

test('a name kept in two places reports the first', () => {
  const r = S.plan([item('Lecture 4.pdf')], local('a/Lecture 4.pdf', 'b/Lecture 4.pdf'));
  assert.equal(r.present.length, 1);
  assert.equal(r.present[0].at, 'a/Lecture 4.pdf');
});

test('order within each list follows the LMS listing', () => {
  const r = S.plan(
    [item('a.pdf'), item('b.pdf'), item('c.pdf'), item('d.pdf')],
    local('b.pdf')
  );
  assert.deepEqual(r.missing.map((i) => i.rel), ['a.pdf', 'c.pdf', 'd.pdf']);
  assert.deepEqual(r.present.map((p) => p.item.rel), ['b.pdf']);
});

test('an empty folder makes everything missing', () => {
  const r = S.plan([item('a.pdf'), item('b.pdf')], local());
  assert.equal(r.missing.length, 2);
});

test('a course with no items plans nothing', () => {
  const r = S.plan([], local('a.pdf'));
  assert.equal(r.missing.length, 0);
  assert.equal(r.present.length, 0);
});

test('a URL shortcut is matched by its .url name', () => {
  const r = S.plan([item('Links/Course site.url')], local('Links/Course site.url'));
  assert.equal(r.missing.length, 0);
});

test('a directory sharing a file name does not count, only scanned files do', () => {
  // Only files are put in the index by the scanner, so a folder called
  // "Lecture 4.pdf" never lands here to be confused with the file.
  const r = S.plan([item('Lecture 4.pdf')], S.indexLocal([]));
  assert.equal(r.missing.length, 1);
});
