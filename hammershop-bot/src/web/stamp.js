'use strict';

/**
 * Stamps for the site's files: every /assets/… address a page or a stylesheet names (pictures, clips, fonts, scripts,
 * styles) gets the stamp of the file's content IN ITS PATH – /assets/_v/1a2b3c4d/launcher/clips/graj.mp4 (the server
 * strips the /_v/<stamp> part again, see `unstamp`). Files are sent with a long „immutable” cache and Cloudflare keeps
 * them at its edge, so without the stamp a replaced picture or clip with the same name would stay old for a week; with
 * it, a changed file simply has a new address. In the path, not in a ?query: a cache set to ignore query strings
 * (a Cloudflare option) would otherwise still hand out the old file.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'web', 'public');
const ASSET_REF = /\/assets\/(?!_v\/)[A-Za-z0-9._/-]+\.(?:css|js|png|jpe?g|webp|gif|svg|ico|mp4|webm|woff2?|ttf|otf)(?![A-Za-z0-9._/?-])/g;
const STAMPED = /^\/assets\/_v\/[0-9a-f]{8}\//;

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
  return stamp === '0' ? url : `/assets/_v/${stamp}/${url.slice('/assets/'.length)}`;
};

/** /assets/_v/1a2b3c4d/launcher/logo-app.png → /assets/launcher/logo-app.png (any other path as it is). */
const unstamp = (pathname) => String(pathname).replace(STAMPED, '/assets/');

/** Every /assets/… address in a page, a stylesheet or a piece of inline CSS, stamped. */
const stampAssets = (text) => String(text).replace(ASSET_REF, stamped);

module.exports = { stampAssets, stampOf, unstamp, ASSET_REF };
