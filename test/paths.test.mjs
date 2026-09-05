import test from 'node:test';
import assert from 'node:assert/strict';

// paths.js has no import/export, so importing it just evaluates it and it
// populates globalThis.LUMS - the same thing that happens in the service worker.
import '../lib/paths.js';
const P = globalThis.LUMS.paths;

const SITE = '315c44e6-9ceb-48ca-b6a0-91b30b7bf7f0';
const item = (over) => Object.assign({
  title: 'Clayton_part_1.pdf',
  type: 'application/pdf',
  container: '/content/group/' + SITE + '/Books/'
}, over);

// Non-ASCII fixtures as escapes, so RTL text cannot reorder the source.
const URDU = '\u0645\u062d\u0627\u0636\u0631\u06c1 \u06f1.pdf';
const LATIN = 'R\u00e9sum\u00e9 \u2013 \u00dcbung (v2).docx';

test('replaces filesystem-illegal characters', () => {
  assert.equal(P.sanitizeSegment('a<b>c:d"e|f?g*h\\i/j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('control characters are stripped', () => {
  assert.equal(P.sanitizeSegment('bad\u0000name\u001f.pdf'), 'bad_name_.pdf');
});

test('".." can never survive as a segment', () => {
  assert.equal(P.sanitizeSegment('..'), '_');
  assert.equal(P.sanitizeSegment('.'), '_');
  assert.equal(P.sanitizePath('../../etc/passwd'), '_/_/etc/passwd');
});

test('absolute paths and leading ~ are defused', () => {
  assert.equal(P.sanitizePath('/etc/passwd'), 'etc/passwd');
  assert.equal(P.sanitizePath('C:\\Windows\\System32'), 'C_/Windows/System32');
  assert.equal(P.sanitizeSegment('~backup'), 'backup');
  // A slash inside a single segment is an illegal character, not a separator.
  assert.equal(P.sanitizeSegment('~/.ssh'), '_.ssh');
  assert.equal(P.sanitizePath('~/.ssh'), '_/ssh');
  assert.ok(!P.downloadPath('/LUMS LMS/', 'EE 330', '../../evil.pdf').startsWith('/'));
});

test('leading and trailing dots and spaces are trimmed per segment', () => {
  assert.equal(P.sanitizeSegment('  Lecture 1.  '), 'Lecture 1');
  assert.equal(P.sanitizeSegment('Notes...'), 'Notes');
  assert.equal(P.sanitizeSegment('.hidden'), 'hidden');
});

test('an empty or whitespace-only segment never yields an empty string', () => {
  assert.equal(P.sanitizeSegment(''), '_');
  assert.equal(P.sanitizeSegment('   '), '_');
  assert.equal(P.sanitizeSegment(null), '_');
});

test('Windows reserved device names get a suffix', () => {
  assert.equal(P.sanitizeSegment('CON'), 'CON_');
  assert.equal(P.sanitizeSegment('nul.txt'), 'nul_.txt');
  assert.equal(P.sanitizeSegment('COM1.pdf'), 'COM1_.pdf');
  assert.equal(P.sanitizeSegment('LPT9'), 'LPT9_');
  // Not reserved - only the exact device names are.
  assert.equal(P.sanitizeSegment('console.pdf'), 'console.pdf');
  assert.equal(P.sanitizeSegment('COM10.pdf'), 'COM10.pdf');
});

test('non-ASCII and Urdu filenames are preserved', () => {
  assert.equal(P.sanitizeSegment(URDU), URDU);
  assert.equal(P.sanitizeSegment(LATIN), LATIN);
});

test('ampersands and parentheses survive - only the URL mangles them', () => {
  const rel = P.relPath(item({
    title: 'Course Outline.pdf',
    container: '/content/group/' + SITE + '/Course Outline & Admin/'
  }), SITE);
  assert.equal(rel, 'Course Outline & Admin/Course Outline.pdf');
});

test('relPath maps container to a site-relative folder', () => {
  assert.equal(P.relPath(item(), SITE), 'Books/Clayton_part_1.pdf');
});

test('root-level items get no folder prefix', () => {
  assert.equal(P.relPath(item({ container: '/content/group/' + SITE + '/' }), SITE), 'Clayton_part_1.pdf');
});

test('nested folders are preserved', () => {
  const rel = P.relPath(item({ container: '/content/group/' + SITE + '/Class Content/Week 1/' }), SITE);
  assert.equal(rel, 'Class Content/Week 1/Clayton_part_1.pdf');
});

test('a container from a different site is treated as root, never as an escape', () => {
  const rel = P.relPath(item({ container: '/content/group/some-other-site/Books/' }), SITE);
  assert.equal(rel, 'Clayton_part_1.pdf');
});

test('extension is derived from MIME when the title has none', () => {
  assert.equal(P.fileName({ title: 'Lecture Notes', type: 'application/pdf' }), 'Lecture Notes.pdf');
  assert.equal(P.fileName({ title: 'Slides', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'Slides.pptx');
  assert.equal(P.fileName({ title: 'Syllabus', type: 'text/plain; charset=UTF-8' }), 'Syllabus.txt');
});

test('an unknown MIME type leaves the name extensionless rather than guessing', () => {
  assert.equal(P.fileName({ title: 'Mystery', type: 'application/x-unknown' }), 'Mystery');
});

test('an existing extension is never doubled', () => {
  assert.equal(P.fileName({ title: 'Clayton_part_1.pdf', type: 'application/pdf' }), 'Clayton_part_1.pdf');
});

test('a dotted name that is not an extension is left alone', () => {
  // "Lecture 3.1 Notes" - the tail has a space, so it is not an extension.
  assert.equal(P.fileName({ title: 'Lecture 3.1 Notes', type: 'application/pdf' }), 'Lecture 3.1 Notes.pdf');
});

test('an empty title falls back to a usable name', () => {
  assert.equal(P.fileName({ title: '', type: 'application/pdf' }), 'untitled.pdf');
});

test('downloadPath joins root prefix, course folder and relative path', () => {
  const out = P.downloadPath('LUMS LMS/', '2601 SSE Electromagnetic Fields & Waves (EE 330 S1-Lecture)', 'Books/Clayton_part_1.pdf');
  assert.equal(out, 'LUMS LMS/2601 SSE Electromagnetic Fields & Waves (EE 330 S1-Lecture)/Books/Clayton_part_1.pdf');
});

test('downloadPath tolerates an empty root prefix', () => {
  assert.equal(P.downloadPath('', 'EE 330', 'Books/a.pdf'), 'EE 330/Books/a.pdf');
});

test('long paths are capped with the extension preserved', () => {
  const longTitle = 'A'.repeat(400) + '.pdf';
  const out = P.downloadPath('LUMS LMS/', 'EE 330', 'Books/' + longTitle);
  assert.ok(out.length <= P.MAX_PATH, 'expected <= ' + P.MAX_PATH + ', got ' + out.length);
  assert.ok(out.endsWith('.pdf'), 'extension lost: ' + out.slice(-20));
});

test('an over-long directory segment is clipped before the basename is', () => {
  const out = P.downloadPath('LUMS LMS/', 'C'.repeat(300), 'Books/notes.pdf');
  assert.ok(out.length <= P.MAX_PATH, 'expected <= ' + P.MAX_PATH + ', got ' + out.length);
  assert.ok(out.endsWith('/notes.pdf'), 'basename damaged unnecessarily: ' + out);
});

test('capping never leaves a trailing dot or space before the extension', () => {
  const out = P.downloadPath('', 'EE 330', 'B'.repeat(190) + '   .pdf');
  assert.ok(out.length <= P.MAX_PATH);
  assert.ok(!/[.\s]\.pdf$/.test(out), out);
});

test('the result is always a safe relative path', () => {
  const cases = [
    ['../../..', '..', '../x.pdf'],
    ['/', '/', '/'],
    ['~', '~', '~'],
    ['', '', '']
  ];
  for (const [root, course, rel] of cases) {
    const out = P.downloadPath(root, course, rel);
    assert.ok(out.length > 0, 'must not be empty');
    assert.ok(!out.startsWith('/'), 'absolute: ' + out);
    assert.ok(!out.startsWith('~'), 'tilde: ' + out);
    assert.ok(!out.endsWith('/'), 'trailing slash: ' + out);
    assert.ok(!out.split('/').includes('..'), 'traversal: ' + out);
    assert.ok(!out.split('/').includes(''), 'empty segment: ' + out);
  }
});

test('MIME is read from either field it travels under', () => {
  // Raw Sakai entries carry `type`; normalised items carry `mime`. Reading only
  // one silently dropped the extension for anything renaming a stored item.
  assert.equal(P.fileName({ title: 'Notes', type: 'application/pdf' }), 'Notes.pdf');
  assert.equal(P.fileName({ title: 'Notes', mime: 'application/pdf' }), 'Notes.pdf');
});

test('uniqueName leaves a free name alone', () => {
  const taken = new Set();
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a.pdf');
  assert.equal(taken.size, 1);
});

test('uniqueName suffixes before the extension, not after it', () => {
  const taken = new Set();
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a.pdf');
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a (1).pdf');
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a (2).pdf');
});

test('uniqueName treats the same name in different folders as distinct', () => {
  const taken = new Set();
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a.pdf');
  assert.equal(P.uniqueName(taken, 'Slides/a.pdf'), 'Slides/a.pdf');
});

test('uniqueName collides case-insensitively', () => {
  // The archive is extracted onto a case-insensitive filesystem more often than
  // not, so "A.PDF" and "a.pdf" are the same file where it lands.
  const taken = new Set();
  assert.equal(P.uniqueName(taken, 'Books/A.PDF'), 'Books/A.PDF');
  assert.equal(P.uniqueName(taken, 'Books/a.pdf'), 'Books/a (1).pdf');
});

test('uniqueName resolves the collisions sanitising itself creates', () => {
  // "A&B.pdf" and "A?B.pdf" are different in Sakai and the same on disk.
  const taken = new Set();
  const one = P.sanitizeSegment('A&B.pdf');
  const two = P.sanitizeSegment('A?B.pdf');
  assert.equal(P.uniqueName(taken, one), 'A&B.pdf');
  assert.equal(P.uniqueName(taken, two), 'A_B.pdf');

  const three = P.sanitizeSegment('A|B.pdf');
  assert.equal(P.uniqueName(taken, three), 'A_B (1).pdf');
});

test('uniqueName handles an extensionless name', () => {
  const taken = new Set();
  assert.equal(P.uniqueName(taken, 'README'), 'README');
  assert.equal(P.uniqueName(taken, 'README'), 'README (1)');
});

test('ZIP entry names get the same length budget as download paths', () => {
  // ZIP mode passes an empty root prefix, so the archive extracts on Windows
  // as reliably as a direct download lands there.
  const out = P.downloadPath('', 'EE 330', 'Books/' + 'A'.repeat(400) + '.pdf');
  assert.ok(out.length <= P.MAX_PATH, 'expected <= ' + P.MAX_PATH + ', got ' + out.length);
  assert.ok(out.endsWith('.pdf'));
  assert.ok(out.startsWith('EE 330/Books/'));
});
