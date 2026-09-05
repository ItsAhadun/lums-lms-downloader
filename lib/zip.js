/*
 * lib/zip.js - a minimal STORE-method ZIP writer.
 *
 * Why STORE (no compression): course resources are overwhelmingly PDFs, which
 * are already deflate-compressed internally. Re-deflating them costs real CPU
 * on 100+ MB of data to save well under 1%.
 *
 * Why hand-rolled: the alternative is bundling a zip library, and the writer we
 * need is one header layout plus a CRC table. No dependencies, no build step.
 *
 * Memory: each file's bytes are handed straight to a Blob, which Chrome backs
 * with disk storage rather than the JS heap. add() also accepts a chunk list
 * with a pre-computed CRC, so a streamed download never has to be concatenated
 * into one contiguous array first - peak heap per file is one copy, not two.
 *
 * No import/export (see lib/paths.js for why).
 */
(function () {
  'use strict';

  var MAX32 = 0xFFFFFFFF;
  var MAX_ENTRIES = 0xFFFF;
  var LOCAL_HEADER = 30;

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  /* CRC-32 of `buf`, optionally continuing from the result of a previous call.
   *
   * A seed of 0 and no seed are the same thing (~0 >>> 0 === 0xFFFFFFFF, the
   * standard initial value), so a streaming caller can start at 0 and chain
   * every chunk through the same call without a special case for the first. */
  function crc32(buf, seed) {
    var c = (~(seed || 0)) >>> 0;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ZIP stores timestamps in the 1980-epoch MS-DOS format. */
  function dosDateTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime()) || d.getFullYear() < 1980) {
      d = new Date(1980, 0, 1);
    }
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function nameLength(name) {
    return new TextEncoder().encode(name).length;
  }

  function ZipWriter() {
    this.parts = [];      // BlobParts in archive order
    this.entries = [];    // central-directory records
    this.offset = 0;      // running offset, i.e. each local header's position
  }

  /* Would adding this entry break ZIP32? Lets a caller stop cleanly with one
   * clear message instead of catching a throw per remaining file and ending up
   * with N confusing per-file failures plus a truncated archive. */
  ZipWriter.prototype.wouldOverflow = function (name, size) {
    if (this.entries.length >= MAX_ENTRIES) return true;
    return this.offset + LOCAL_HEADER + nameLength(name) + size > MAX32;
  };

  /* name must already be a safe, forward-slash-separated relative path.
   *
   * body is either a Uint8Array, or { chunks, size, crc } for a streamed file
   * whose CRC was computed chunk by chunk as it arrived. */
  ZipWriter.prototype.add = function (name, body, modified) {
    var size, crc, chunks;
    if (body && body.chunks) {
      chunks = body.chunks;
      size = body.size;
      crc = body.crc;
    } else {
      chunks = [body];
      size = body.length;
      crc = crc32(body);
    }

    var nameBytes = new TextEncoder().encode(name);
    var dt = dosDateTime(modified);

    if (size > MAX32) throw new Error('"' + name + '" is too large for a ZIP32 archive.');
    if (this.entries.length >= MAX_ENTRIES) throw new Error('More than 65535 files; ZIP32 cannot index them.');

    var h = new DataView(new ArrayBuffer(LOCAL_HEADER));
    h.setUint32(0, 0x04034b50, true);   // local file header signature
    h.setUint16(4, 20, true);           // version needed to extract (2.0)
    h.setUint16(6, 0x0800, true);       // flags: filename is UTF-8
    h.setUint16(8, 0, true);            // method 0 = stored
    h.setUint16(10, dt.time, true);
    h.setUint16(12, dt.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);        // compressed size == uncompressed
    h.setUint32(22, size, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);           // extra field length

    this.entries.push({ nameBytes: nameBytes, crc: crc, size: size, dt: dt, offset: this.offset });
    // One Blob per file, not the raw arrays: keeps the archive body off the JS
    // heap, and lets the caller drop its chunk references immediately.
    this.parts.push(h.buffer, nameBytes, new Blob(chunks));
    this.offset += LOCAL_HEADER + nameBytes.length + size;

    if (this.offset > MAX32) throw new Error('Archive exceeds the 4 GB ZIP32 limit. Download in smaller parts.');
  };

  ZipWriter.prototype.size = function () { return this.offset; };
  ZipWriter.prototype.count = function () { return this.entries.length; };

  /* The central directory and end record, appended to the bodies already
   * queued. Returns raw BlobParts so a non-browser caller (the tests) can
   * assemble them without a Blob implementation. */
  ZipWriter.prototype.tailParts = function () {
    var cd = [];
    var cdSize = 0;

    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); // central directory header signature
      c.setUint16(4, 20, true);         // version made by
      c.setUint16(6, 20, true);         // version needed
      c.setUint16(8, 0x0800, true);     // flags: UTF-8
      c.setUint16(10, 0, true);         // stored
      c.setUint16(12, e.dt.time, true);
      c.setUint16(14, e.dt.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint16(30, 0, true);         // extra length
      c.setUint16(32, 0, true);         // comment length
      c.setUint16(34, 0, true);         // disk number start
      c.setUint16(36, 0, true);         // internal attributes
      c.setUint32(38, 0, true);         // external attributes
      c.setUint32(42, e.offset, true);  // offset of local header
      cd.push(c.buffer, e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }

    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory
    end.setUint16(4, 0, true);          // this disk number
    end.setUint16(6, 0, true);          // disk with central directory
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, this.offset, true);
    end.setUint16(20, 0, true);         // comment length

    return cd.concat([end.buffer]);
  };

  ZipWriter.prototype.blob = function () {
    return new Blob(this.parts.concat(this.tailParts()), { type: 'application/zip' });
  };

  globalThis.LUMS = Object.assign(globalThis.LUMS || {}, {
    zip: {
      ZipWriter: ZipWriter,
      crc32: crc32,
      MAX32: MAX32,
      MAX_ENTRIES: MAX_ENTRIES
    }
  });
})();
