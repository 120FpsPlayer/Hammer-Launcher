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

test('the launcher\'s pages: clips, posters, pictures, fonts, scripts and styles all carry their content stamp', async () => {
  const html = await (await fetch(`${base}/funkcje`)).text(); // the page with the clips
  const clip = /src="\/assets\/_v\/([0-9a-f]{8})\/(launcher\/clips\/graj\.mp4)"/.exec(html);
  assert.ok(clip, 'the clip has a stamp in its path');
  assert.equal(clip[1], stampOf(`/assets/${clip[2]}`));
  assert.match(html, /data-poster="\/assets\/_v\/[0-9a-f]{8}\/launcher\/clips\/graj-poster\.webp"/);
  assert.match(html, /href="\/assets\/_v\/[0-9a-f]{8}\/launcher\.css"/);
  assert.doesNotMatch(html, /"\/assets\/(?!_v\/)[^"]+\.(?:png|webp|jpe?g|mp4|webm|css|js)"/, 'no unstamped asset address left in attributes');
  // Every page: its styles, its script and – on the start page – the script for old addresses, all stamped.
  for (const page of ['/', '/hammer-plus', '/polecaj', '/kontakt']) {
    const other = await (await fetch(base + page)).text();
    assert.match(other, /href="\/assets\/_v\/[0-9a-f]{8}\/launcher\.css"/, page);
    assert.match(other, /src="\/assets\/_v\/[0-9a-f]{8}\/launcher\.js"/, page);
    assert.doesNotMatch(other, /"\/assets\/(?!_v\/)[^"]+\.(?:png|webp|jpe?g|mp4|webm|css|js)"/, page);
  }
  assert.match(await (await fetch(`${base}/`)).text(), /<script src="\/assets\/_v\/[0-9a-f]{8}\/launcher-head\.js"><\/script>/);
  assert.match(html, /<script src="\/assets\/_v\/[0-9a-f]{8}\/launcher-head\.js"><\/script>/, 'the Funkcje page loads it too');
  // The stamped address serves the very file – also in parts (Range), as browsers ask for videos.
  const res = await fetch(`${base}/assets/_v/${clip[1]}/${clip[2]}`, { headers: { range: 'bytes=0-15' } });
  assert.ok([200, 206].includes(res.status));
  const whole = fs.readFileSync(path.join(PUBLIC, 'assets', clip[2]));
  const got = Buffer.from(await (await fetch(`${base}/assets/_v/${clip[1]}/${clip[2]}`)).arrayBuffer());
  assert.ok(got.equals(whole), 'the same bytes as the file');
  // A stamp can never reach outside the site.
  assert.equal((await fetch(`${base}/assets/_v/00000000/../../package.json`)).status !== 200 || !(await (await fetch(`${base}/assets/_v/00000000/../../package.json`)).text()).includes('"dependencies"'), true);
});

test('stylesheets: url(/assets/…) carries the stamp – the HammerShop partner H and the logos change as soon as the file does', async () => {
  const css = await (await fetch(`${base}/assets/launcher.css`)).text();
  assert.match(css, /url\(\/assets\/_v\/[0-9a-f]{8}\/launcher\/logo-hammershop\.png\)/);
  assert.match(css, /url\(\/assets\/_v\/[0-9a-f]{8}\/launcher\/logo-mark\.png\)/);
  assert.doesNotMatch(css, /url\(\/assets\/(?!_v\/)[^)]+\)/, 'no unstamped url() left');
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
    assert.equal(stampAssets(`a ${url} b`), `a /assets/_v/${stampOf(url)}/launcher/${path.basename(file)} b`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  assert.equal(stampAssets('/assets/nie-ma-takiego.png'), '/assets/nie-ma-takiego.png');
  assert.equal(stampOf('/assets/../../package.json'), '0');
  assert.equal(stampAssets('/assets/_v/1234abcd/launcher.css'), '/assets/_v/1234abcd/launcher.css', 'never stamped twice');
});
