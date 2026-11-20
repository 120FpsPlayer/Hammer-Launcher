'use strict';

/**
 * A partner's logo uploaded in the admin panel („Partnerstwa” → „Logo”). It is checked by what the file really is –
 * its first bytes and the picture's own size in its header – never by its name or the type the browser says, then kept
 * in data/partners/<partner id>-<content hash>.<type>. The website serves it at /partnerzy/logo/<that name> with a long
 * „immutable” cache (Cloudflare keeps it): a new picture has a new hash, so a new address. The Discord card and the
 * announcement upload the file itself (attachment://), so they work without the website too.
 *
 *   check(buffer) → { type, width, height, size } | throws a UserError (a Polish sentence for the panel)
 *   save(partnerId, { buffer, type }) → the file name        remove(name)        file(name) → its path | null
 *   url(name) → '/partnerzy/logo/<name>'                       contentType(name)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { UserError } = require('./utils');

const MAX_BYTES = 2 * 1024 * 1024;
const MIN_SIDE = 32;
const MAX_SIDE = 4096;
const MAX_RATIO = 3; // a long banner is no logo – it would be a thin strip on a square spot
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const NAME = /^([a-z0-9][a-z0-9-]{0,47})-([0-9a-f]{10})\.(png|jpg|gif|webp)$/;
const PREFIX = '/partnerzy/logo/';

const dir = () => path.join(db.dataDir, 'partners');

/** What the picture is and how big, from its own header → { type, width, height } | null (not a PNG, JPG, GIF or WebP). */
function info(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const sized = (type, width, height) => (width > 0 && height > 0 ? { type, width, height } : null);
  // PNG: the signature, then the IHDR chunk with the width and height.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('ascii', 12, 16) === 'IHDR') return sized('png', buf.readUInt32BE(16), buf.readUInt32BE(20));
  // GIF: GIF87a / GIF89a, then the logical screen's width and height.
  if (/^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return sized('gif', buf.readUInt16LE(6), buf.readUInt16LE(8));
  // WebP: a RIFF file of the WEBP kind – lossy (VP8 ), lossless (VP8L) or extended (VP8X).
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return sized('webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return sized('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') return sized('webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
    return null;
  }
  // JPEG: walk the segments to the frame header (SOF0–SOF15, not DHT / JPG / DAC), which has the height and width.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // a marker without a length
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return sized('jpg', buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      if (marker === 0xd9 || marker === 0xda) return null; // the picture's data or its end before any frame header
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  return null;
}

const mb = (bytes) => `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toFixed(1).replace('.', ',')} MB`; // rounded up: never "2,0 MB" when too big

/** Is this a logo we can use? → { type, width, height, size }; otherwise a UserError that says why. */
function check(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new UserError('Plik jest pusty – wybierz obrazek z logo.');
  if (buf.length > MAX_BYTES) throw new UserError(`Ten plik ma ${mb(buf.length)} – logo może mieć najwyżej 2 MB. Zmniejsz je (np. na squoosh.app) i spróbuj ponownie.`);
  const found = info(buf);
  if (!found) throw new UserError('To nie jest obrazek PNG, JPG, WebP ani GIF – sama zmiana rozszerzenia pliku nie wystarczy. Zapisz logo w jednym z tych formatów.');
  const { width, height } = found;
  if (width < MIN_SIDE || height < MIN_SIDE) throw new UserError(`Logo jest za małe (${width}×${height} px) – wybierz obrazek co najmniej ${MIN_SIDE}×${MIN_SIDE} px, najlepiej 256×256 albo większy.`);
  if (width > MAX_SIDE || height > MAX_SIDE) throw new UserError(`Logo jest za duże (${width}×${height} px) – najwyżej ${MAX_SIDE}×${MAX_SIDE} px. Zmniejsz je, np. do 512×512.`);
  if (Math.max(width, height) / Math.min(width, height) > MAX_RATIO) throw new UserError(`Logo jest bardzo wydłużone (${width}×${height} px) – na karcie byłoby cienkim paskiem. Wybierz kwadratowy obrazek, np. 512×512.`);
  return { ...found, size: buf.length };
}

/** A file name this module made (a partner id, a hash, a type) – nothing else is ever read or deleted. */
const valid = (name) => typeof name === 'string' && NAME.test(name);

/** Keeps the picture for a partner → its file name (the hash in it changes with the picture). */
function save(partnerId, { buffer, type }) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(String(partnerId)) || !TYPES[type]) throw new Error(`Nieprawidłowe logo partnera ${partnerId}.${type}`);
  const name = `${partnerId}-${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10)}.${type}`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), name), buffer);
  return name;
}

function remove(name) {
  if (valid(name)) fs.rmSync(path.join(dir(), name), { force: true });
}

/** The path of a stored logo – null for a name this module would never make, or a file that is gone. */
function file(name) {
  if (!valid(name)) return null;
  const p = path.join(dir(), name);
  return fs.existsSync(p) ? p : null;
}

const url = (name) => `${PREFIX}${name}`;
const contentType = (name) => TYPES[String(name).split('.').pop()] ?? 'application/octet-stream';

module.exports = { MAX_BYTES, MIN_SIDE, MAX_SIDE, TYPES, PREFIX, info, check, save, remove, file, url, contentType, valid };
