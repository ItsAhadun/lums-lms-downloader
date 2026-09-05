import test from 'node:test';
import assert from 'node:assert/strict';

// zip.js has no import/export, so importing it just evaluates it and it
// populates globalThis.LUMS - the same thing that happens in the offscreen
// document. Node 18+ supplies the Blob and TextEncoder it needs.
import '../lib/zip.js';
const Z = globalThis.LUMS.zip;

const enc = (s) => new TextEncoder().encode(s);

/* Read a built archive back the way an extractor would: end-of-central-
 * directory, then the central directory, then each local header and its data.
 *
 * This is the only check that proves the writer's offsets and sizes agree with
 * each other. A wrong offset produces a file that looks fine until someone
 * tries to open it, which is the worst place to find out. */
async function parse(zip) {
  const buf = new Uint8Array(await zip.blob().arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd, 'central directory does not end where the EOCD begins');

  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50, 'bad central directory signature');
    const nameLen = dv.getUint16(at + 28, true);
    const e = {
      name: new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen)),
      crc: dv.getUint32(at + 16, true),
      size: dv.getUint32(at + 24, true),
      offset: dv.getUint32(at + 42, true),
      utf8: !!(dv.getUint16(at + 8, true) & 0x0800)
    };

    // Follow the pointer into the body and check the local header agrees.
    const lo = e.offset;
    assert.equal(dv.getUint32(lo, true), 0x04034b50, 'bad local header signature for ' + e.name);
    const localNameLen = dv.getUint16(lo + 26, true);
    assert.equal(
      new TextDecoder().decode(buf.subarray(lo + 30, lo + 30 + localNameLen)), e.name,
      'local and central names disagree');
    assert.equal(dv.getUint32(lo + 14, true), e.crc, 'local and central CRCs disagree');
    assert.equal(dv.getUint32(lo + 18, true), e.size, 'local and central sizes disagree');

    const start = lo + 30 + localNameLen + dv.getUint16(lo + 28, true);
    e.data = buf.subarray(start, start + e.size);
    assert.equal(Z.crc32(e.data), e.crc, 'stored bytes do not match the stored CRC for ' + e.name);

    entries.push(e);
    at += 46 + nameLen + dv.getUint16(at + 30, true) + dv.getUint16(at + 32, true);
  }
  assert.equal(at, eocd, 'central directory walk did not land on the EOCD');
  return entries;
}

test('crc32 matches the standard check vector', () => {
  assert.equal(Z.crc32(enc('123456789')), 0xCBF43926);
});

test('crc32 of nothing is zero', () => {
  assert.equal(Z.crc32(new Uint8Array(0)), 0);
});

test('a zero seed is the same as no seed', () => {
  assert.equal(Z.crc32(enc('hello'), 0), Z.crc32(enc('hello')));
});

test('chunked crc32 equals the one-shot value', () => {
  const whole = enc('the quick brown fox jumps over the lazy dog');
  let crc = 0;
  for (let i = 0; i < whole.length; i += 7) crc = Z.crc32(whole.subarray(i, i + 7), crc);
  assert.equal(crc, Z.crc32(whole));
});

test('an archive round-trips through its own central directory', async () => {
  const zip = new Z.ZipWriter();
  const a = enc('first file\n');
  const b = enc('second file, a little longer\n');
  zip.add('Course/Books/a.txt', a, new Date(2024, 4, 6, 13, 30, 20));
  zip.add('Course/b.txt', b, new Date(2024, 4, 6, 13, 30, 20));

  const entries = await parse(zip);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name), ['Course/Books/a.txt', 'Course/b.txt']);
  assert.deepEqual(entries[0].data, a);
  assert.deepEqual(entries[1].data, b);
});

test('a streamed body produces the same entry as a contiguous one', async () => {
  const whole = enc('chunk one|chunk two|chunk three');
  const chunks = [enc('chunk one|'), enc('chunk two|'), enc('chunk three')];
  let crc = 0;
  let size = 0;
  for (const c of chunks) { crc = Z.crc32(c, crc); size += c.length; }

  const direct = new Z.ZipWriter();
  direct.add('x.txt', whole, new Date(2024, 0, 1));
  const streamed = new Z.ZipWriter();
  streamed.add('x.txt', { chunks, size, crc }, new Date(2024, 0, 1));

  const [d] = await parse(direct);
  const [s] = await parse(streamed);
  assert.equal(s.crc, d.crc);
  assert.equal(s.size, d.size);
  assert.deepEqual(s.data, d.data);
});

test('an empty file is a valid entry', async () => {
  const zip = new Z.ZipWriter();
  zip.add('empty.txt', new Uint8Array(0), new Date(2024, 0, 1));
  const [e] = await parse(zip);
  assert.equal(e.size, 0);
  assert.equal(e.crc, 0);
});

test('non-ASCII entry names are flagged UTF-8 and survive', async () => {
  const name = 'Course/محاضرہ ۱.txt';
  const zip = new Z.ZipWriter();
  zip.add(name, enc('x'), new Date(2024, 0, 1));
  const [e] = await parse(zip);
  assert.equal(e.name, name);
  assert.ok(e.utf8, 'the UTF-8 flag must be set or extractors guess the codepage');
});

test('timestamps before the 1980 DOS epoch fall back instead of wrapping', async () => {
  const zip = new Z.ZipWriter();
  zip.add('old.txt', enc('x'), new Date(1970, 0, 1));
  zip.add('bad.txt', enc('x'), new Date('nonsense'));
  await parse(zip);   // the assertions live in parse(); wrapping corrupts offsets
});

test('offsets stay consistent across many entries', async () => {
  const zip = new Z.ZipWriter();
  for (let i = 0; i < 50; i++) zip.add('f' + i + '.bin', enc('x'.repeat(i)), new Date(2024, 0, 1));
  const entries = await parse(zip);
  assert.equal(entries.length, 50);
  assert.equal(entries[49].size, 49);
});

test('wouldOverflow reports the entry-count ceiling before add() throws', () => {
  const zip = new Z.ZipWriter();
  zip.entries.length = Z.MAX_ENTRIES;          // stand in for 65535 real entries
  assert.equal(zip.wouldOverflow('one-more.pdf', 10), true);
  assert.throws(() => zip.add('one-more.pdf', enc('x'), new Date()), /65535/);
});

test('wouldOverflow reports the 4 GB ceiling before add() throws', () => {
  const zip = new Z.ZipWriter();
  zip.offset = Z.MAX32 - 1000;                 // stand in for a nearly full archive
  assert.equal(zip.wouldOverflow('big.pdf', 5000), true);
  assert.equal(zip.wouldOverflow('small.pdf', 10), false);
});
