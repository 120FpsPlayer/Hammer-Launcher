'use strict';

// The launcher's pages on HammerShop's own site (the default profile): the same pages as on Hammer Launcher's site,
// under /launcher – /launcher/hammer-plus, /launcher/kontakt … – next to the shop, which keeps its front page and its
// own way with addresses it does not know. test/pages-launcher.test.js has the launcher's own site.
const realFetch = global.fetch;
require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { env } = require('../src/env');
const profile = require('../src/lib/profile');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const pages = require('../src/web/pages');
const { createWebServer } = require('../src/web/server');

const GUEST = { id: '200000000000000031', username: 'gosc', global_name: 'Gosc', avatar: null };
const SITE = [
  ['/launcher', 'Hammer Launcher – launcher Minecrafta od HammerShop'],
  ['/launcher/funkcje', 'Funkcje – Hammer Launcher'],
  ['/launcher/hammer-client', 'Hammer Client – Hammer Launcher'],
  ['/launcher/wyglad', 'Wygląd: motywy i peleryny – Hammer Launcher'],
  ['/launcher/hammer-plus', 'Hammer+ – Hammer Launcher'],
  ['/launcher/polecaj', 'Zaproś znajomego – Hammer Launcher'],
  ['/launcher/aktualnosci', 'Aktualności – Hammer Launcher'],
  ['/launcher/pomoc', 'Pomoc i częste pytania – Hammer Launcher'],
  ['/launcher/kontakt', 'Kontakt – Hammer Launcher'],
];

let fakes;
let site;
let base;

test.before(async () => {
  fakes = await startFakes();
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({ info: () => ({ invite: 'https://discord.gg/hammershop' }) });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
});

const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).find((c) => c.startsWith(`${name}=`)) ?? '';
async function get(pathname) {
  const res = await fetch(base + pathname, { redirect: 'manual' });
  return { status: res.status, body: await res.text(), headers: res.headers, location: res.headers.get('location') };
}
async function signIn(next) {
  fakes.state.user = GUEST;
  const first = await fetch(`${base}/api/shop/auth/start${next ? `?next=${encodeURIComponent(next)}` : ''}`, { redirect: 'manual' });
  const state = new URL(first.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: [cookieOf(first, 'hs_oauth'), cookieOf(first, 'hs_next')].filter(Boolean).join('; ') }, redirect: 'manual' });
  return back.headers.get('location');
}

test('on the shop\'s site the launcher\'s pages live under /launcher – each with its own title, links and current link', async () => {
  assert.equal(profile.shop, true);
  assert.deepEqual(pages.PAGES.map((p) => pages.pathOf(p.id)), SITE.map(([address]) => address), 'the test knows every page (no HammerShop page on HammerShop\'s own site)');
  for (const [address, title] of SITE) {
    const res = await get(address);
    assert.equal(res.status, 200, address);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/, address);
    assert.equal(/<title>([^<]*)<\/title>/.exec(res.body)[1], title, address);
    assert.ok(res.body.includes(`<link rel="canonical" href="${base}${address}">`), `${address}: canonical`);
    assert.equal(res.body.match(/<h1[ >]/g).length, 1, address);
    assert.doesNotMatch(res.body, /\{\{|<!--|data-nav=/, address);
    // The shop's name and mark, a way back to the shop – and none of what only Hammer Launcher's own site has.
    assert.match(res.body, /<a class="logo" href="\/" aria-label="HammerShop – strona główna">/, address);
    assert.match(res.body, /<nav class="nav"[^>]*>\s*<a href="\/">Sklep<\/a>\s*<a href="\/launcher"[^>]*>Launcher<\/a>/, address);
    assert.doesNotMatch(res.body, /class="collab"|class="logo h"|\/hammershop"|foot-mail|współtwórca/, address);
    // Every link to a page stays inside /launcher; the page tells its script where it sits.
    assert.ok(res.body.includes('data-base="/launcher"'), address);
    for (const [, href] of res.body.matchAll(/<a [^>]*href="(\/[^"]*)"/g)) {
      assert.ok(href === '/' || href === '/download' || href.startsWith('/launcher') || href.startsWith('/api/shop/auth/start?next='), `${address}: ${href}`);
    }
    const current = [...res.body.matchAll(/<a [^>]*href="([^"]*)"[^>]* aria-current="page"/g)].map((m) => m[1]);
    assert.ok(current.length >= 2 && current.every((href) => href === address), `${address}: aria-current on ${current}`);
    assert.equal((await get(`${address}/`)).status, 200, `${address}/`);
  }
  // The contact address is the launcher site's own: here there is none, so the footer shows only the way to the form.
  assert.match((await get('/launcher')).body, /<a href="\/launcher\/kontakt"[^>]*>Kontakt<\/a>/);
});

test('the shop keeps its front page and its own unknown addresses; under /launcher nothing is a real 404', async () => {
  for (const shop of ['/', '/index.html', '/cokolwiek', '/funkcje', '/hammer-plus', '/kontakt', '/robots.txt', '/sitemap.xml']) {
    const res = await get(shop);
    assert.equal(res.status, 200, shop);
    assert.match(res.body, /<title>HammerShop/, `${shop}: the store's single page, as before`);
  }
  for (const nothing of ['/launcher/cokolwiek', '/launcher/hammershop', '/launcher/funkcje/cos', '/launcher/layout.html']) {
    const res = await get(nothing);
    assert.equal(res.status, 404, nothing);
    assert.match(res.body, /<title>Nie ma takiej strony – Hammer Launcher<\/title>/, nothing);
    assert.match(res.body, /<a class="btn primary big" href="\/launcher">Strona główna<\/a>/, nothing);
  }
  // The sources are not files of the site; the old file name leads to the start page.
  for (const raw of ['/layout.html', '/start.html', '/pages/start.html', '/web/pages/start.html']) assert.doesNotMatch((await get(raw)).body, /\{\{main\}\}|\{\{base\}\}|<!--shop-->/, raw);
  assert.deepEqual([(await get('/launcher.html')).status, (await get('/launcher.html')).location], [302, '/launcher']);
  assert.equal((await get('/assets/nie-ma.png')).status, 404);
});

test('sign-in, the download, a friend\'s link and an old payment address use the pages under /launcher', async () => {
  for (const page of pages.PAGES) assert.equal(await signIn(page.id), `${pages.pathOf(page.id)}?connected=1`, page.id);
  assert.equal(await signIn('launcher'), '/launcher?connected=1');
  assert.equal(await signIn('download'), '/launcher?download=1&connected=1');
  assert.equal(await signIn('hammershop'), '/?connected=1', 'not a page of this site');
  assert.equal(await signIn('https://evil.example/launcher'), '/?connected=1');
  assert.equal(await signIn(null), '/?connected=1', 'the shop\'s own sign-in comes back to the shop');
  assert.equal((await get('/download')).location, '/launcher?download=none');
  assert.equal((await get('/r/nieznany')).location, '/launcher');
  // Back from Stripe to the address Hammer+ payments used before the pages were split.
  assert.equal((await get('/launcher?payment=return&session_id=cs_test_9')).location, '/launcher/hammer-plus?payment=return&session_id=cs_test_9');
  assert.equal((await get('/launcher?payment=cancelled')).location, '/launcher/hammer-plus?payment=cancelled');
  // …while the shop's own payments still come back to the shop.
  assert.match((await get('/?payment=return&session_id=cs_test_9')).body, /<title>HammerShop/);
});
