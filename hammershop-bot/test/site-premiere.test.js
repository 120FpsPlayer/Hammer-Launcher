'use strict';

// Premiere day on Hammer Launcher's own site (BOT_PROFILE=launcher): what hundreds of visitors at once and a busy
// mailbox do to the site, and the admin panel on the owner's phone. Over real HTTP against a local copy of the website
// with fake Discord and Stripe, a local fake mail server, and – for the panel – a real browser.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { startSmtp } = require('./helpers/fakeSmtp');
const { env } = require('../src/env');
const mail = require('../src/lib/mail');
const hammerplus = require('../src/features/hammerplus');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const releases = require('../src/web/releases');
const { createWebServer, recheckPending, clientIp } = require('../src/web/server');
const admin = require('../src/web/admin');

const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const BUYER = { id: '200000000000000031', username: 'kupujacy', global_name: 'Kupujący', avatar: null };
const ADDRESS = 'hammerlauncherclient@gmail.com';
const PASS = 'abcdabcdabcdabcd';
const FILE = 'Hammer-Launcher-Setup-2.11.3.exe';

let fakes;
let site;
let base;
let ownerSid;

test.before(async () => {
  fakes = await startFakes();
  const guild = new FakeGuild({ ownerId: OWNER.id });
  db.guild(guild.id);
  guild.addMember(BUYER.id);
  env.plusPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  hammerplus.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: '8667ba71b85a4004af54457a9734eed7', name: 'Steve' }) }));
  website._setClient(guild.client);
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onPaid: website.onPaid, onLogin: website.onLogin, isMember: website.isMember, currency: () => 'pln',
    level: website.panelLevel, log: website.panelLog, plus: website.panelPlus, featuredAdmin: website.panelFeatured, referrals: website.panelReferrals,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  webStore.setPlusPlans([{ id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1499 }]);
  ownerSid = await signIn(OWNER);
});

async function signIn(user) {
  fakes.state.user = user;
  const start = await fetch(`${base}/api/shop/auth/start?next=admin`, { redirect: 'manual' });
  const cookies = (start.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: cookies.join('; ') }, redirect: 'manual' });
  return (back.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('hs_sid='));
}
test.after(() => {
  site?.close();
  fakes?.server.close();
});

const get = (pathname, headers = {}) => fetch(`${base}${pathname}`, { headers: { cookie: ownerSid, ...headers }, redirect: 'manual' });
async function publishBuild(bytes) {
  fs.mkdirSync(releases.DIR(), { recursive: true });
  fs.writeFileSync(releases.fileOf(FILE), bytes);
  return releases.publish({ version: '2.11.3', file: FILE, notes: 'Premiera!' });
}

test('„Pobierz”: the installer comes from an address that names its bytes – Cloudflare may keep it, a new build gets a new one', async () => {
  const first = crypto.randomBytes(64 * 1024);
  await publishBuild(first);
  const dl = await get('/download');
  assert.equal(dl.status, 302);
  const pinned = dl.headers.get('location');
  assert.match(pinned, new RegExp(`^/updates/_v/[0-9a-f]{16}/${FILE}$`));
  assert.equal(dl.headers.get('cache-control'), 'no-store', 'the button itself is answered (and counted) by this server every time');
  assert.equal(webStore.currentRelease().downloads, 1);

  const file = await get(pinned);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(file.headers.get('content-disposition'), `attachment; filename="${FILE}"`);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(first));
  const etag = file.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  assert.ok(file.headers.get('last-modified'));

  // The launcher's own updater keeps its address, still checked with the server every time – now with a validator.
  const plain = await get(`/updates/${FILE}`);
  assert.deepEqual([plain.status, plain.headers.get('cache-control'), plain.headers.get('etag')], [200, 'no-cache', etag]);
  assert.ok((await get('/updates/latest.yml')).ok);

  // A broken download resumes: the rest of the same file (If-Range matches) – the whole file when it changed meanwhile.
  const rest = await get(pinned, { range: 'bytes=60000-', 'if-range': etag });
  assert.deepEqual([rest.status, rest.headers.get('content-range')], [206, `bytes 60000-${first.length - 1}/${first.length}`]);
  assert.ok(Buffer.from(await rest.arrayBuffer()).equals(first.subarray(60000)));
  const byDate = await get(pinned, { range: 'bytes=60000-', 'if-range': file.headers.get('last-modified') });
  assert.equal(byDate.status, 206);
  await byDate.arrayBuffer();
  const other = await get(pinned, { range: 'bytes=60000-', 'if-range': '"0123456789abcdef"' });
  assert.deepEqual([other.status, other.headers.get('content-length')], [200, String(first.length)]);
  await other.arrayBuffer();
  const same = await get(`/updates/${FILE}`, { 'if-none-match': etag });
  assert.deepEqual([same.status, (await same.text()).length], [304, 0]);

  // The same name, other bytes (a build uploaded again): the old pinned address is gone, the button leads to the new one.
  const second = crypto.randomBytes(64 * 1024);
  await publishBuild(second);
  assert.equal((await get(pinned)).status, 404);
  const next = (await get('/download')).headers.get('location');
  assert.notEqual(next, pinned);
  const fresh = await get(next);
  assert.ok(Buffer.from(await fresh.arrayBuffer()).equals(second));
  assert.notEqual(fresh.headers.get('etag'), etag);
  // Only the release's own installer, only under its own stamp.
  for (const bad of [`/updates/_v/${'0'.repeat(16)}/${FILE}`, '/updates/_v/zz/x.exe', `/updates/_v/${next.split('/')[3]}/..%2Fweb.json`]) assert.equal((await get(bad)).status, 404, bad);
});

test('paid, but neither the webhook nor the buyer came back (tab closed, webhook secret from test mode): the site asks Stripe itself', async () => {
  const sid = await signIn(BUYER);
  let ip = 0;
  const buy = async () => {
    const res = await fetch(`${base}/api/shop/checkout`, { method: 'POST', headers: { cookie: sid, origin: base, 'content-type': 'application/json', 'cf-connecting-ip': `10.7.0.${++ip}` }, body: JSON.stringify({ kind: 'plus', plan: 'p30', nick: 'Steve', requestId: crypto.randomUUID() }) });
    const body = await res.json();
    assert.ok(body.url, JSON.stringify(body));
    return { order: body.order, session: body.url.split('/').pop() };
  };
  const paid = await buy();
  const gone = await buy();
  const old = await buy();
  fakes.pay(paid.session, { customer_details: { email: 'kupujacy@example.com' } });
  fakes.state.sessions.get(gone.session).status = 'expired';
  fakes.pay(old.session);
  webStore.updateOrder(old.order, { created: Math.floor(Date.now() / 1000) - 4 * 3600 }); // long past any payment page

  assert.equal(await recheckPending(), 0, 'the first minute belongs to the buyer\'s own return');
  assert.equal(webStore.getOrder(paid.order).status, 'pending');
  assert.equal(await recheckPending(Date.now() + 2 * 60_000), 1);
  const order = webStore.getOrder(paid.order);
  assert.deepEqual([order.status, order.email, Boolean(order.plus.grantedAt)], ['paid', 'kupujacy@example.com', true], 'paid, with the address from Stripe and the code issued');
  assert.equal(webStore.getOrder(gone.order).status, 'expired');
  assert.equal(webStore.getOrder(old.order).status, 'pending', 'orders older than a few hours are left alone');
  // The buyer opens the Hammer+ page later: the code is in „Twoje kody”.
  const mine = await (await fetch(`${base}/api/shop/orders`, { headers: { cookie: sid } })).json();
  assert.ok(mine.orders.find((o) => o.id === paid.order).plus.code.startsWith('HP1.'));
  // Asked again: nothing happens twice.
  assert.equal(await recheckPending(Date.now() + 7 * 60_000), 0);
});

test('per-address limits: CF-Connecting-IP counts only when the connection comes from Cloudflare or the own network', () => {
  const ip = (peer, headers = {}) => clientIp({ socket: { remoteAddress: peer }, headers });
  const cf = { 'cf-connecting-ip': '83.12.34.56' };
  // Behind Cloudflare – IPv4, IPv4 on a dual-stack socket, IPv6 – and behind the hosting's own container network / a local proxy.
  for (const peer of ['162.158.10.20', '::ffff:172.70.1.1', '2a06:98c1:3120::7', '172.18.0.1', '127.0.0.1']) assert.equal(ip(peer, cf), '83.12.34.56', peer);
  assert.equal(ip('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 83.12.34.56' }), '83.12.34.56', 'the entry the own proxy added');
  // Straight to the server's port, past Cloudflare: a made-up header changes nothing – every made-up address is one visitor.
  const original = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    for (const fake of ['1.1.1.1', '2.2.2.2']) assert.equal(ip('203.0.113.9', { 'cf-connecting-ip': fake, 'x-forwarded-for': fake }), '203.0.113.9');
    assert.equal(ip('::ffff:203.0.113.9'), '203.0.113.9');
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1, 'the console hears about it once');
});

test('panel: „Co nowego” is as long as the launcher shows it (2000), and nothing is cut through the middle of an emoji', async () => {
  if (!webStore.currentRelease()) await publishBuild(crypto.randomBytes(1024));
  const publish = (notes) => fetch(`${base}/api/admin/releases`, { method: 'POST', headers: { cookie: ownerSid, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ version: '2.11.3', file: FILE, notes }) });
  const long = await publish('– poprawka\n'.repeat(250));
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /„Co nowego” może mieć najwyżej 2000 znaków – tyle pokaże launcher \(teraz 2749\)/);
  assert.equal((await publish('x'.repeat(2000))).status, 200);
  assert.equal(webStore.currentRelease().notes.length, 2000);
  assert.match(fs.readFileSync(require.resolve('../web/public/admin.html'), 'utf8'), /id="release-notes" maxlength="2000"/);
  // A news title of 119 letters and an emoji: cut at 120 it would end in half of the emoji („�”).
  const title = admin.line(`${'a'.repeat(119)}🔥 ognia`, 120);
  assert.equal(title, 'a'.repeat(119));
  assert.equal(admin.block('ab🔥', 3), 'ab');
  assert.equal(admin.line('Nowy sezon 🔥', 120), 'Nowy sezon 🔥');
});

/** A mail server that is busy for the first `busy` connections ("421 – try again later"), then the real fake. */
function busyFront(port, busy) {
  const front = net.createServer((socket) => {
    socket.on('error', () => {});
    if (front.refused < busy) {
      front.refused += 1;
      return socket.end('421 4.7.0 Try again later, closing connection.\r\n');
    }
    const up = net.connect(port, '127.0.0.1');
    up.on('error', () => socket.destroy());
    return socket.pipe(up).pipe(socket);
  });
  front.refused = 0;
  return new Promise((resolve) => front.listen(0, '127.0.0.1', () => resolve(front)));
}

test('e-mail: „try again later” from the mail server is tried again – the buyer\'s code is not lost to a busy minute; a wrong password is not', async (t) => {
  const smtp = await startSmtp({ user: ADDRESS, pass: PASS });
  const front = await busyFront(smtp.port, 2);
  t.after(() => {
    smtp.close();
    front.close();
    Object.assign(env.mail, { pass: '' });
    mail._test();
  });
  Object.assign(env.mail, { pass: PASS, user: '', to: '', host: '127.0.0.1', port: front.address().port });
  mail._test({ plain: true, retryMs: [20, 20] });

  const sent = await mail.send({ subject: 'Dziękujemy za zakup Hammer+ – Twój kod', text: 'HP1.kod', to: 'kupujacy@example.com' });
  assert.deepEqual(sent, { ok: true });
  assert.equal(front.refused, 2, 'two busy answers, the third try went through');
  assert.deepEqual(smtp.messages.map((m) => m.subject), ['Dziękujemy za zakup Hammer+ – Twój kod']);

  // Still busy after every try: the reason says what the server answered.
  front.refused = -10;
  const busy = await mail.send({ subject: 'x', text: 'y' });
  assert.equal(busy.ok, false);
  assert.match(busy.reason, /421/);
  assert.equal(front.refused, -7, 'three tries in all');
  assert.equal('temporary' in busy, false, 'callers get the same answer as before');

  // The panel's test e-mail: one try, the answer right away.
  front.refused = 0;
  assert.equal((await mail.send({ subject: 'Test', text: 't', retry: false })).ok, false);
  assert.equal(front.refused, 1);

  // A wrong password is not "later": one try only.
  front.refused = 99;
  smtp.behave = { rejectAuth: true };
  const sessions = smtp.sessions.length;
  const wrong = await mail.send({ subject: 'x', text: 'y' });
  assert.deepEqual([wrong.ok, wrong.code], [false, 'auth']);
  assert.equal(smtp.sessions.length, sessions + 1);
});

function playwright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try {
      return require(p);
    } catch {
      // next
    }
  }
  return null;
}
const pw = playwright();

test('the admin panel on the owner\'s phone: no tab is wider than the screen (a phone would zoom the whole panel out)', { skip: !pw && 'Playwright is not installed' }, async () => {
  if (!webStore.currentRelease()) await publishBuild(crypto.randomBytes(1024));
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addCookies([{ name: 'hs_sid', value: ownerSid.split('=')[1], url: base }]);
    await context.route(/^https:\/\//, (route) => route.abort()); // avatars from Discord's CDN – no network in tests
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
    const wide = {};
    for (const tab of ['pulpit', 'aktualnosci', 'komunikat', 'wersje', 'plus', 'serwery', 'zamowienia', 'wiadomosci']) {
      await page.locator(`[data-tab="${tab}"]`).first().click();
      await page.waitForTimeout(250);
      // A page wider than the phone makes the browser zoom out: the layout width grows past the screen.
      const extra = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - screen.width);
      if (extra > 0) wide[tab] = extra;
    }
    assert.deepEqual(wide, {}, 'tabs wider than the phone (px too wide)');
    // „Usuń” on the current version says what it does to the site – the download and the updates stop.
    await page.locator('[data-tab="wersje"]').first().click();
    await page.locator('#releases-list tr', { hasText: 'aktualna' }).locator('button', { hasText: 'Usuń' }).click();
    assert.match(await page.locator('#confirm-text').innerText(), /To jest aktualna wersja – strona przestanie dawać launcher do pobrania, a aktualizacje się zatrzymają/);
    await page.locator('#confirm-no').click();
    assert.ok(webStore.currentRelease(), 'nothing was deleted');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
