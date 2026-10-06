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

/* ---------- a file changed on the LMS under the same name ---------- */

// LMS posted Module 2.pdf at 10:00 GMT on 1 Oct, 2000 bytes.
const lmsItem = { rel: 'Module 2.pdf', title: 'Module 2.pdf', bytes: 2000, modifiedDate: '20261001100000000' };
const at = (path, size, iso) => S.indexLocal([{ path, name: S.baseName(path), size, mtime: Date.parse(iso) }]);

test('modifiedDate is read as GMT', () => {
  assert.equal(S.lmsTime('20261001100000123'), Date.parse('2026-10-01T10:00:00.123Z'));
  assert.ok(Number.isNaN(S.lmsTime('')));
});

test('an older copy of a different size is replaced where it sits', () => {
  const r = S.plan([lmsItem], at('Week 1/Module 2.pdf', 1500, '2026-09-20T00:00:00Z'));
  assert.equal(r.present.length, 0);
  assert.equal(r.missing[0].replaces, 'Week 1/Module 2.pdf');
  assert.equal(lmsItem.replaces, undefined);   // the LMS item itself is untouched
});

test('a copy saved after the LMS change is kept, even at another size', () => {
  // Annotated after downloading: newer than the LMS, different size.
  const r = S.plan([lmsItem], at('Module 2.pdf', 2600, '2026-10-02T00:00:00Z'));
  assert.equal(r.missing.length, 0);
});

test('an older copy of the same size is kept', () => {
  // Out of an archive whose entry time came back early, or re-uploaded unchanged.
  const r = S.plan([lmsItem], at('Module 2.pdf', 2000, '2026-09-20T00:00:00Z'));
  assert.equal(r.missing.length, 0);
});

test('one current copy among stale ones keeps it present', () => {
  const idx = S.indexLocal([
    { path: 'a/Module 2.pdf', name: 'Module 2.pdf', size: 1500, mtime: Date.parse('2026-09-20T00:00:00Z') },
    { path: 'b/Module 2.pdf', name: 'Module 2.pdf', size: 2000, mtime: Date.parse('2026-10-01T11:00:00Z') }
  ]);
  assert.equal(S.plan([lmsItem], idx).missing.length, 0);
});

test('no size or date on either side reads as up to date', () => {
  assert.equal(S.plan([lmsItem], local('Module 2.pdf')).missing.length, 0);
  const undated = { ...lmsItem, modifiedDate: '' };
  assert.equal(S.plan([undated], at('Module 2.pdf', 1500, '2026-09-20T00:00:00Z')).missing.length, 0);
});

/* ---------- every course in a semester folder ---------- */

test('a course matches the folder its archive extracts into', () => {
  assert.equal(S.courseFolder('2601 SSE Engineering Models (EE  203 S1-Lecture)'),
    '2601 SSE Engineering Models (EE  203 S1-Lecture)');
  assert.equal(S.courseFolder('A: B?'), 'A_ B_');
  assert.equal(S.courseFolder('x'.repeat(90)).length, 60);
});

test('a semester listing splits by course folder, loose files dropped', () => {
  const m = S.byFolder([
    { path: 'CLAUDE.md', name: 'CLAUDE.md' },
    { path: 'EE 203/Module 2.pdf', name: 'Module 2.pdf', size: 5, mtime: 1 },
    { path: 'ee 203/Week 1/a.pdf', name: 'a.pdf' }
  ]);
  assert.deepEqual([...m.keys()], ['ee 203']);
  const f = m.get('ee 203');
  assert.equal(f.name, 'EE 203');
  assert.deepEqual(f.files.map((x) => x.path), ['Module 2.pdf', 'Week 1/a.pdf']);
  assert.equal(f.files[0].size, 5);
});
