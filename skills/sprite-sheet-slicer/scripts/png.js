'use strict';
// PNG codec on top of Node's zlib. decode reads any non-interlaced PNG (colour
// types 0, 2, 3, 4 and 6, bit depths 1 to 16) into RGBA8; encode writes RGBA8.
const zlib = require('zlib');
const fs = require('fs');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0; // Node 20.15 and later
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decode(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > buf.length)
      throw new Error('PNG is truncated inside a ' + type + ' chunk');
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) {
      // critical chunks have an uppercase first letter; a damaged ancillary chunk (text, EXIF) is skipped
      if (type[0] === type[0].toUpperCase())
        throw new Error('PNG is corrupt: bad checksum in ' + type + ' chunk');
      pos += 12 + len;
      continue;
    }
    if (type === 'acTL')
      throw new Error(
        'animated PNG (APNG) is not supported; export the frames as separate PNG files',
      );
    pos += 12 + len;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.interlace !== 0)
    throw new Error('interlaced (Adam7) PNG is not supported; re-save without interlacing');
  const { width: w, height: h, bitDepth, colorType } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[
    colorType
  ];
  if (!depths.includes(bitDepth))
    throw new Error(
      'PNG is corrupt: bit depth ' + bitDepth + ' is not valid for color type ' + colorType,
    );
  if (!w || !h) throw new Error('PNG is corrupt: zero width or height');
  if (colorType === 3 && !plte) throw new Error('PNG is corrupt: palette image without a palette');
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((w * bitsPerPixel) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error('PNG data is truncated');

  // undo the per-row filters
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error('bad PNG filter type ' + f);
      px[dst + x] = v & 0xff;
    }
  }

  const out = Buffer.alloc(w * h * 4);
  const maxv = (1 << bitDepth) - 1;
  // Sample i of row y. A 16-bit sample is reduced to its high byte; samples under
  // 8 bits (palette indices among them) are returned unscaled.
  function sample(y, i) {
    if (bitDepth === 8) return px[y * stride + i];
    if (bitDepth === 16) return px[y * stride + i * 2];
    const bit = i * bitDepth;
    const byte = px[y * stride + (bit >> 3)];
    return (byte >> (8 - bitDepth - (bit & 7))) & maxv;
  }
  const scale = (v) => (bitDepth < 8 ? Math.round((v * 255) / maxv) : v);
  // tRNS names the transparent colour at full sample precision
  const fullSample = (y, i) =>
    bitDepth === 16 ? px.readUInt16BE(y * stride + i * 2) : sample(y, i);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 3) {
        const idx = sample(y, x);
        if (idx * 3 + 2 >= plte.length)
          throw new Error('PNG is corrupt: palette index ' + idx + ' is out of range');
        out[o] = plte[idx * 3];
        out[o + 1] = plte[idx * 3 + 1];
        out[o + 2] = plte[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const g = scale(sample(y, x));
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = trns && fullSample(y, x) === trns.readUInt16BE(0) ? 0 : 255;
      } else if (colorType === 2) {
        out[o] = sample(y, x * 3);
        out[o + 1] = sample(y, x * 3 + 1);
        out[o + 2] = sample(y, x * 3 + 2);
        out[o + 3] =
          trns &&
          fullSample(y, x * 3) === trns.readUInt16BE(0) &&
          fullSample(y, x * 3 + 1) === trns.readUInt16BE(2) &&
          fullSample(y, x * 3 + 2) === trns.readUInt16BE(4)
            ? 0
            : 255;
      } else if (colorType === 4) {
        const g = sample(y, x * 2);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = sample(y, x * 2 + 1);
      } else {
        out[o] = sample(y, x * 4);
        out[o + 1] = sample(y, x * 4 + 1);
        out[o + 2] = sample(y, x * 4 + 2);
        out[o + 3] = sample(y, x * 4 + 3);
      }
    }
  }
  return { width: w, height: h, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encode(img) {
  const { width: w, height: h, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const read = (file) => decode(fs.readFileSync(file));
const write = (file, img) => fs.writeFileSync(file, encode(img));
const create = (w, h) => ({ width: w, height: h, data: Buffer.alloc(w * h * 4) });

module.exports = { decode, encode, read, write, create };
