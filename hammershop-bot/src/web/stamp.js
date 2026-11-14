'use strict';

/**
 * Stamps for the site's files: every /assets/… address a page or a stylesheet names (pictures, clips, fonts, scripts,
 * styles) gets the stamp of the file's content – /assets/launcher/clips/graj.mp4?v=1a2b3c4d. Files are sent with a long
 * „immutable” cache and Cloudflare keeps them at its edge, so without the stamp a replaced picture or clip with the same
 * name would stay old in browsers for a week; with it, a changed file simply has a new address.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'web', 'public');
const ASSET_REF = /\/assets\/[A-Za-z0-9._/-]+\.(?:css|js|png|jpe?g|webp|gif|svg|ico|mp4|webm|woff2?|ttf|otf)(?![A-Za-z0-9._/?-])/g;

const stamps = new Map(); // url → { mtime, size, stamp }

/** The first 8 hex digits of the file's SHA-1 – '0' when there is no such file. Recomputed only when the file changes. */
function stampOf(url) {
  try {
    const file = path.join(PUBLIC, url);
    if (!file.startsWith(PUBLIC + path.sep)) return '0';
    const { mtimeMs, size } = fs.statSync(file);
    const known = stamps.get(url);
    if (known?.mtime === mtimeMs && known.size === size) return known.stamp;
    const stamp = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
    stamps.set(url, { mtime: mtimeMs, size, stamp });
    return stamp;
  } catch {
    return '0';
  }
}

const stamped = (url) => {
  const stamp = stampOf(url);
  return stamp === '0' ? url : `${url}?v=${stamp}`;
};

/** Every /assets/… address in a page, a stylesheet or a piece of inline CSS, stamped. */
const stampAssets = (text) => String(text).replace(ASSET_REF, stamped);

module.exports = { stampAssets, stampOf, ASSET_REF };
