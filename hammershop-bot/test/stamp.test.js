'use strict';

// Replaced pictures and clips are seen at once: every /assets/… address on the pages and in the stylesheets carries
// the stamp of the file's content, so the week-long „immutable” cache (and Cloudflare's copy) never shows an old file.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWebServer } = require('../src/web/server');
const { stampAssets, stampOf } = require('../src/web/stamp');

const PUBLIC = path.join(__dirname, '..', 'web', 'public');
let site;
let base;
test.before(async () => {
  site = createWebServer({});
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
});
test.after(() => site?.close());

test('the launcher page: clips, posters, pictures, fonts, scripts and styles all carry their content stamp', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const clip = /src="(\/assets\/launcher\/clips\/graj\.mp4)\?v=([0-9a-f]{8})"/.exec(html);
  assert.ok(clip, 'the clip has a stamp');
  assert.equal(clip[2], stampOf(clip[1]));
  assert.match(html, /data-poster="\/assets\/launcher\/clips\/graj-poster\.webp\?v=[0-9a-f]{8}"/);
  assert.match(html, /href="\/assets\/launcher\.css\?v=[0-9a-f]{8}"/);
  assert.doesNotMatch(html, /"\/assets\/[^"?]+\.(?:png|webp|jpe?g|mp4|webm|css|js)"/, 'no unstamped asset address left in attributes');
  // The stamped address serves the file (the stamp is only a query).
  const res = await fetch(`${base}${clip[1]}?v=${clip[2]}`, { headers: { range: 'bytes=0-15' } });
  assert.ok([200, 206].includes(res.status));
});

test('stylesheets: url(/assets/…) carries the stamp – the HammerShop partner H and the logos change as soon as the file does', async () => {
  const css = await (await fetch(`${base}/assets/launcher.css`)).text();
  assert.match(css, /url\(\/assets\/launcher\/logo-hammershop\.png\?v=[0-9a-f]{8}\)/);
  assert.match(css, /url\(\/assets\/launcher\/logo-mark\.png\?v=[0-9a-f]{8}\)/);
  assert.doesNotMatch(css, /url\(\/assets\/[^)?]+\)/, 'no unstamped url() left');
});

test('a changed file gets a new stamp; an unknown file is left as it is; nothing outside the site is read', () => {
  const dir = path.join(PUBLIC, 'assets', 'launcher');
  const file = path.join(dir, `stamp-test-${process.pid}.png`);
  try {
    fs.writeFileSync(file, 'one');
    const url = `/assets/launcher/${path.basename(file)}`;
    const first = stampOf(url);
    fs.writeFileSync(file, 'two!');
    assert.notEqual(stampOf(url), first);
    assert.equal(stampAssets(`a ${url} b`), `a ${url}?v=${stampOf(url)} b`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  assert.equal(stampAssets('/assets/nie-ma-takiego.png'), '/assets/nie-ma-takiego.png');
  assert.equal(stampOf('/assets/../../package.json'), '0');
  assert.equal(stampAssets('/assets/launcher.css?v=1234abcd'), '/assets/launcher.css?v=1234abcd', 'never stamped twice');
});
