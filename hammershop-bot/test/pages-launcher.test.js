'use strict';

// The launcher's pages on Hammer Launcher's own site (BOT_PROFILE=launcher): one short page per subject instead of one
// long page. Every page answers with its own title, the old addresses still lead somewhere sensible, an address that
// is nothing gets a real 404, and „Twoje kody” lists only the Hammer+ codes that still run. Over real HTTP against a
// local copy of the website, with fake Discord, Stripe and Mojang; at the end the real pages in a browser.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { env } = require('../src/env');
const config = require('../src/lib/config');
const plus = require('../src/lib/plus');
const hammerplus = require('../src/features/hammerplus');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const releases = require('../src/web/releases');
const pages = require('../src/web/pages');
const { createWebServer } = require('../src/web/server');

const person = (id, name) => ({ id, username: name.toLowerCase(), global_name: name, avatar: null });
const OWNER = person('1', 'Szef');
const BUYER = person('200000000000000021', 'Kupujacy');
const GUEST = person('200000000000000022', 'Gosc');
const MC = { Steve: '8667ba71b85a4004af54457a9734eed7', Alex: '6ab4317889fd490597f60f67d9d76fd9', Notch: '069a79f444e94726a5befca90e38aaf5', Jeb: '853c80ef3c3749fdaa49938b674adae6' };
/** Every page: its address, its title and what its <h1> says. */
const SITE = [
  ['/', 'Hammer Launcher – nasz własny launcher Minecrafta', /Graj więcej\./],
  ['/funkcje', 'Funkcje – Hammer Launcher', /Wszystko do grania/],
  ['/hammer-plus', 'Hammer+ – Hammer Launcher', /Launcher po Twojemu/],
  ['/polecaj', 'Zaproś znajomego – Hammer Launcher', /\+7 dni Hammer\+/],
  ['/aktualnosci', 'Aktualności – Hammer Launcher', /Aktualności/],
  ['/pomoc', 'Pomoc i częste pytania – Hammer Launcher', /Częste pytania/],
  ['/kontakt', 'Kontakt – Hammer Launcher', /Napisz do nas/],
  ['/hammershop', 'HammerShop – współtwórca Hammer Launchera', /HammerShop – współtwórca Hammer Launchera/],
];

let fakes;
let site;
let base;
let guild;
let ip = 0;

test.before(async () => {
  fakes = await startFakes();
  guild = new FakeGuild({ ownerId: OWNER.id });
  db.guild(guild.id);
  for (const u of [BUYER, GUEST]) guild.addMember(u.id);
  env.plusPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  hammerplus.setFetch(async (url) => {
    const nick = decodeURIComponent(String(url).split('/').pop());
    const hit = Object.keys(MC).find((n) => n.toLowerCase() === nick.toLowerCase());
    return hit ? { ok: true, status: 200, json: async () => ({ id: MC[hit], name: hit }) } : { ok: false, status: 404, json: async () => ({}) };
  });
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
  webStore.setPlusPlans([{ id: 'p1', name: 'Hammer+ na 1 dzień', days: 1, price: 199 }, { id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1500 }, { id: 'pinf', name: 'Hammer+ na zawsze', days: 0, price: 7900 }]);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
});

const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).find((c) => c.startsWith(`${name}=`)) ?? '';

async function call(method, pathname, { sid = '', body, headers = {} } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: { 'x-forwarded-for': `10.8.${Math.floor(++ip / 250)}.${ip % 250}`, ...(sid && { cookie: sid }), ...(method !== 'GET' && { origin: base }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // a page or an empty answer
  }
  return { status: res.status, body: parsed, headers: res.headers, location: res.headers.get('location') };
}

/** The Discord sign-in, step by step → the session cookie (signIn.landed: where it ended). */
async function signIn(user, next = null) {
  fakes.state.user = user;
  const first = await fetch(`${base}/api/shop/auth/start${next ? `?next=${encodeURIComponent(next)}` : ''}`, { redirect: 'manual' });
  const state = new URL(first.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: [cookieOf(first, 'hs_oauth'), cookieOf(first, 'hs_next')].filter(Boolean).join('; ') }, redirect: 'manual' });
  signIn.landed = back.headers.get('location');
  return cookieOf(back, 'hs_sid');
}

async function buyPlus(sid, nick, plan) {
  const res = await call('POST', '/api/shop/checkout', { sid, body: { kind: 'plus', plan, nick, requestId: crypto.randomUUID() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  fakes.pay(res.body.url.split('/').pop());
  const verified = await call('POST', '/api/shop/verify', { sid, body: { sessionId: res.body.url.split('/').pop() } });
  assert.equal(verified.body.paid, true);
  return res.body.order;
}
/** The order's Hammer+ ended `seconds` ago (as if the days had passed). */
const expire = (id, seconds) => webStore.updateOrder(id, { plus: { ...webStore.getOrder(id).plus, exp: Math.floor(Date.now() / 1000) - seconds } });

test('every page answers with its own title, description and address – and marks its link as the current one', async () => {
  assert.deepEqual(pages.PAGES.map((p) => pages.pathOf(p.id)), SITE.map(([address]) => address), 'the test knows every page');
  const titles = new Set();
  const descriptions = new Set();
  for (const [address, title, h1] of SITE) {
    const res = await call('GET', address);
    const html = res.body;
    assert.equal(res.status, 200, address);
    assert.match(res.headers.get('content-type'), /text\/html/, address);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/, address);
    assert.equal(res.headers.get('x-robots-tag'), null, address);
    assert.equal(/<title>([^<]*)<\/title>/.exec(html)[1], title, address);
    titles.add(title);
    descriptions.add(/<meta name="description" content="([^"]+)">/.exec(html)[1]);
    assert.ok(html.includes(`<link rel="canonical" href="${base}${address}">`), `${address}: canonical`);
    assert.ok(html.includes(`<meta property="og:url" content="${base}${address}">`), `${address}: og:url`);
    assert.match(html, /<meta property="og:title" content="[^"]+">/, address);
    assert.match(html, new RegExp(`<meta property="og:image" content="${base}/assets/_v/[0-9a-f]{8}/launcher/og\\.jpg">`), address);
    // One <h1>, the page's own; nothing of the sources' markers is left; no inline script or style (the CSP forbids them).
    assert.equal(html.match(/<h1[ >]/g).length, 1, address);
    assert.match(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1], h1, address);
    assert.doesNotMatch(html, /\{\{|<!--|data-nav=|<style|style="|<script(?! src="\/assets\/_v\/[0-9a-f]{8}\/launcher(?:-head)?\.js"><\/script>)/, address);
    // The current page's link is marked – in the header's menu and in the footer.
    const current = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]* aria-current="page"/g)].map((m) => m[1]);
    assert.ok(current.length >= 2 && current.every((href) => href === address), `${address}: aria-current on ${current}`);
    // The footer of every page: the contact address and the way to the form; "Zaloguj" comes back to this very page.
    assert.ok(html.includes(`<a class="foot-mail" href="mailto:${config.contact.email}">`), `${address}: the contact address`);
    assert.match(html, /<nav class="foot-links"[^>]*>[\s\S]*<a href="\/kontakt"[^>]*>Kontakt<\/a>/, address);
    assert.ok(html.includes(`href="/api/shop/auth/start?next=${pages.PAGES.find((p) => pages.pathOf(p.id) === address).id}"`), `${address}: sign-in returns here`);
    assert.ok(html.includes(`data-base="" `) || html.includes(`data-base="">`), address);
    assert.equal((await call('GET', `${address === '/' ? '' : address}/`)).status, 200, `${address}/ – with a slash at the end`);
  }
  assert.equal(titles.size, SITE.length, 'no two pages share a title');
  assert.equal(descriptions.size, SITE.length, 'no two pages share a description');
  // The contact page's address is fixed: the Discord „Kontakt” card and the rules link to it.
  assert.equal(pages.pathOf('kontakt'), '/kontakt');
});

test('the page sources cannot be fetched raw; an address that is nothing gets a real 404 page', async () => {
  assert.ok(fs.existsSync(path.join(pages.DIR, 'layout.html')) && !pages.DIR.includes(`${path.sep}public`), 'the sources live outside web/public');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'web', 'public', 'launcher.html')), false, 'the one long page is gone');
  for (const raw of ['/layout.html', '/start.html', '/hammer-plus.html', '/pages/layout.html', '/web/pages/layout.html', '/../pages/layout.html', '/assets/../../pages/layout.html', '/assets/%2e%2e/%2e%2e/pages/layout.html']) {
    const res = await call('GET', raw);
    assert.notEqual(res.status, 200, raw);
    assert.doesNotMatch(String(res.body.error ?? res.body), /\{\{main\}\}|<!--shop-->/, raw);
  }
  for (const nothing of ['/cokolwiek', '/funkcje/cos', '/hammer-plus.html', '/launcher/cokolwiek', '/api/nie-ma', '/favicon.ico']) {
    const res = await call('GET', nothing);
    assert.equal(res.status, 404, nothing);
    assert.match(res.body, /<title>Nie ma takiej strony – Hammer Launcher<\/title>/, nothing);
    assert.match(res.body, /<meta name="robots" content="noindex">/, nothing);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex', nothing);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/, nothing);
    assert.match(res.body, /<a class="btn primary big" href="\/">Strona główna<\/a>/, nothing);
    assert.doesNotMatch(res.body, /aria-current|\{\{|<!--/, nothing);
  }
  // A missing picture is still a plain 404, not a page; the admin panel keeps its address and stays out of search engines.
  assert.deepEqual([(await call('GET', '/assets/nie-ma.png')).status, (await call('GET', '/assets/nie-ma.png')).body.error], [404, 'Nie znaleziono']);
  const panel = await call('GET', '/admin');
  assert.deepEqual([panel.status, panel.headers.get('x-robots-tag')], [200, 'noindex']);
  assert.equal((await call('GET', '/Admin.html')).status, 404, 'never the raw panel file');
});

test('old addresses: what the server can see goes to the page that has that part now, with the query kept', async () => {
  for (const [old, to] of [
    ['/launcher', '/'],
    ['/launcher/', '/'],
    ['/launcher.html', '/'],
    ['/index.html', '/'],
    ['/launcher?connected=1&joined=1', '/?connected=1&joined=1'],
    ['/launcher?auth=failed', '/?auth=failed'],
    ['/launcher?download=1&connected=1', '/?download=1&connected=1'],
    ['/launcher?invited=1', '/?invited=1'],
    ['/launcher/hammer-plus', '/hammer-plus'],
    ['/launcher/polecaj?connected=1', '/polecaj?connected=1'],
    // Hammer Client and Wygląd were pages of their own for a while – they are parts of Funkcje now.
    ['/hammer-client', '/funkcje#hammer-client'],
    ['/hammer-client/', '/funkcje#hammer-client'],
    ['/wyglad', '/funkcje#wyglad'],
    ['/wyglad?connected=1', '/funkcje?connected=1#wyglad'],
    ['/launcher/hammer-client', '/funkcje#hammer-client'],
    ['/launcher/wyglad', '/funkcje#wyglad'],
    // Back from Stripe to the old page (a payment page made before the change stays open for an hour).
    ['/?payment=return&session_id=cs_test_1', '/hammer-plus?payment=return&session_id=cs_test_1'],
    ['/?payment=cancelled', '/hammer-plus?payment=cancelled'],
  ]) {
    const res = await call('GET', old);
    assert.deepEqual([res.status, res.location], [302, to], old);
  }
  const viaOld = await call('GET', '/launcher?payment=return&session_id=cs_test_1');
  assert.equal(viaOld.location, '/?payment=return&session_id=cs_test_1'); // … and from there to /hammer-plus, as above
  // A # never reaches the server: the start page loads the script that sends #plus, #polecaj … on – before anything else.
  const start = (await call('GET', '/')).body;
  assert.ok(start.indexOf('launcher-head.js') > 0 && start.indexOf('launcher-head.js') < start.indexOf('</head>'), 'in the <head> of the start page');
  assert.doesNotMatch((await call('GET', '/hammer-plus')).body, /launcher-head\.js/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'assets', 'launcher-head.js'), 'utf8');
  const funkcje = (await call('GET', '/funkcje')).body;
  for (const [hash, to] of [['plus', 'hammer-plus'], ['polecaj', 'polecaj'], ['faq', 'pomoc'], ['funkcje', 'funkcje'], ['klient', 'funkcje#hammer-client'], ['wyglad', 'funkcje#wyglad'], ['start', 'funkcje#start'], ['aktualnosci', 'aktualnosci'], ['hammershop', 'hammershop']]) {
    const [page, part] = to.split('#');
    assert.match(script, new RegExp(`${hash}(: | = )'${to}'`), `#${hash} → /${to}`);
    assert.ok(pages.PAGES.some((p) => p.id === page), `/${page} is a page`);
    if (part) assert.ok(funkcje.includes(` id="${part}"`), `/${page} has #${part}`);
  }
  // Nothing is left of the two pages: no file, no id, no sign-in target.
  assert.deepEqual(['hammer-client.html', 'wyglad.html'].filter((f) => fs.existsSync(path.join(pages.DIR, f))), []);
  assert.deepEqual(pages.PAGES.filter((p) => ['hammer-client', 'wyglad'].includes(p.id)), []);
});

test('Funkcje is one page with three parts: the switcher and the parts are in the page, which one shows is the browser\'s business', async () => {
  const html = (await call('GET', '/funkcje')).body;
  // The switcher: plain links to the parts (they work without scripts); the parts follow in this order.
  assert.deepEqual([...html.matchAll(/<a class="part-tab" id="(part-tab-[a-z-]+)" href="(#[a-z-]+)"/g)].map((m) => [m[1], m[2]]), [['part-tab-launcher', '#launcher'], ['part-tab-hammer-client', '#hammer-client'], ['part-tab-wyglad', '#wyglad']]);
  assert.deepEqual([...html.matchAll(/<div class="part" id="([a-z-]+)">/g)].map((m) => m[1]), ['launcher', 'hammer-client', 'wyglad']);
  assert.match(html, /<div class="part" id="launcher">[\s\S]*Zobacz launcher w&nbsp;akcji[\s\S]*role="tablist"[\s\S]*id="start"[\s\S]*<div class="part" id="hammer-client">[\s\S]*Twój Minecraft, tylko lepszy[\s\S]*<div class="part" id="wyglad">[\s\S]*Wygląd po Twojemu/);
  // Nothing says which part is open – without scripts all three are simply there; the script in the <head> decides
  // before the first paint (so a link to #wyglad never shows the launcher part first).
  assert.doesNotMatch(html, /data-part=/);
  assert.ok(html.indexOf('launcher-head.js') > 0 && html.indexOf('launcher-head.js') < html.indexOf('</head>'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'assets', 'launcher.css'), 'utf8');
  assert.match(css, /html\[data-part\] \.part \{ display: none;/);
  for (const part of ['launcher', 'hammer-client', 'wyglad']) assert.ok(css.includes(`html[data-part="${part}"] #${part}`), part);
  // The menu: one item for all three parts; the footer and the start page lead straight to a part.
  assert.match(html, /<nav class="nav"[^>]*>[\s\S]*?<a href="\/funkcje" aria-current="page">Funkcje<\/a>\s*<a href="\/hammer-plus">Hammer\+<\/a>\s*<a href="\/polecaj">Polecaj<\/a>\s*<a href="\/aktualnosci">Aktualności<\/a>\s*<a href="\/pomoc">Pomoc<\/a>\s*<a href="\/kontakt">Kontakt<\/a>/);
  assert.doesNotMatch(html, /href="\/(hammer-client|wyglad)"/);
  assert.match(html, /<a href="\/funkcje#hammer-client">Hammer Client<\/a>\s*<a href="\/funkcje#wyglad">Wygląd<\/a>/);
  const start = (await call('GET', '/')).body;
  for (const href of ['/funkcje', '/funkcje#hammer-client', '/funkcje#wyglad']) assert.ok(start.includes(`<a class="go-card pic reveal"`) && start.includes(`href="${href}">`), `the start page leads to ${href}`);
  assert.ok((await call('GET', '/hammer-plus')).body.includes('<a href="/funkcje#wyglad">Wygląd</a>'));
});

test('sign-in comes back to the page it started on – only to pages of this site; downloads, links and Stripe use the new addresses', async () => {
  for (const page of pages.PAGES) {
    await signIn(GUEST, page.id);
    assert.equal(signIn.landed, `${pages.pathOf(page.id)}?connected=1`, page.id);
  }
  await signIn(GUEST, 'launcher');
  assert.equal(signIn.landed, '/?connected=1');
  await signIn(GUEST, 'download');
  assert.equal(signIn.landed, '/?download=1&connected=1');
  await signIn(GUEST, 'admin');
  assert.equal(signIn.landed, '/admin?connected=1');
  for (const outside of ['https://evil.example', '//evil.example', '/kontakt', 'hammer-plus/../admin', 'constructor', '__proto__', 'hammer-client', 'wyglad', 'funkcje#wyglad']) {
    await signIn(GUEST, outside);
    assert.equal(signIn.landed, '/?connected=1', outside);
  }
  // Nothing to download yet → the start page says so; a friend's link → the start page.
  assert.deepEqual([(await call('GET', '/download')).status, (await call('GET', '/download')).location], [302, '/?download=none']);
  assert.equal((await call('GET', '/r/nieznany')).location, '/');
  const sid = await signIn(GUEST);
  const code = webStore.referralCode(GUEST.id);
  assert.equal((await call('GET', `/r/${code}`)).location, '/?invited=1');
  // Not signed in and a launcher to download: Discord first, then the start page starts the download.
  fs.mkdirSync(releases.DIR(), { recursive: true });
  fs.writeFileSync(releases.fileOf('Hammer-Launcher-Setup-2.11.1.exe'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 7)]));
  await releases.publish({ version: '2.11.1', file: 'Hammer-Launcher-Setup-2.11.1.exe', notes: 'Poprawki.' });
  const out = await call('GET', '/download');
  assert.match(out.location, /\/discord\/authorize\?/);
  assert.equal(decodeURIComponent(cookieOf(out, 'hs_next').split('=')[1]), '/?download=1');
  assert.equal((await call('GET', '/download', { sid })).location, releases.downloadPath(webStore.currentRelease())); // /updates/_v/<sha>/Hammer-Launcher-Setup-2.11.1.exe
  // Stripe sends the buyer back to the Hammer+ page.
  const res = await call('POST', '/api/shop/checkout', { sid, body: { kind: 'plus', plan: 'p30', nick: 'Alex', requestId: crypto.randomUUID() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fakes.state.lastCheckout.get('success_url'), `${base}/hammer-plus?payment=return&session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(fakes.state.lastCheckout.get('cancel_url'), `${base}/hammer-plus?payment=cancelled`);
});

test('robots.txt and the sitemap name the pages – not the panel, the API or the sources', async () => {
  const robots = await call('GET', '/robots.txt');
  assert.deepEqual([robots.status, robots.headers.get('content-type')], [200, 'text/plain; charset=utf-8']);
  assert.match(robots.body, /^User-agent: \*\nDisallow: \/admin\nDisallow: \/api\/\n/);
  assert.ok(robots.body.includes(`Sitemap: ${base}/sitemap.xml`));
  const map = await call('GET', '/sitemap.xml');
  assert.deepEqual([map.status, map.headers.get('content-type')], [200, 'application/xml; charset=utf-8']);
  assert.deepEqual([...map.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), SITE.map(([address]) => base + address));
});

test('an expired Hammer+ order is marked and carries no code; the ones that still run keep theirs', async () => {
  const sid = await signIn(BUYER);
  const gone = await buyPlus(sid, 'Steve', 'p1');
  const short = await buyPlus(sid, 'Notch', 'p1');
  const month = await buyPlus(sid, 'Jeb', 'p30');
  const forever = await buyPlus(sid, 'Alex', 'pinf');
  expire(gone, 3600);
  const orders = Object.fromEntries((await call('GET', '/api/shop/orders', { sid })).body.orders.map((o) => [o.id, o]));
  // Its time is over: marked, and no code is signed again (it would open nothing in the launcher anyway).
  assert.deepEqual([orders[gone].status, orders[gone].plus.expired, orders[gone].plus.code, orders[gone].plus.nick], ['paid', true, null, 'Steve']);
  assert.ok(orders[gone].plus.until < Date.now());
  for (const id of [short, month, forever]) {
    assert.equal(orders[id].plus.expired, false, id);
    assert.equal(plus.verify(orders[id].plus.code).mc, MC[orders[id].plus.nick], 'the very code for that account');
  }
  assert.equal(orders[forever].plus.until, 0, 'forever never expires');
  // The moment the time is up it changes – no restart, nothing stored.
  expire(short, 1);
  const again = (await call('GET', '/api/shop/orders', { sid })).body.orders.find((o) => o.id === short);
  assert.deepEqual([again.plus.expired, again.plus.code], [true, null]);
  // An order that is not paid is never "expired" – it has no code to begin with.
  const pending = await call('POST', '/api/shop/checkout', { sid, body: { kind: 'plus', plan: 'p30', nick: 'Steve', requestId: crypto.randomUUID() } });
  const waiting = (await call('GET', '/api/shop/orders', { sid })).body.orders.find((o) => o.id === pending.body.order);
  assert.deepEqual([waiting.status, waiting.plus.expired, waiting.plus.code], ['pending', false, null]);
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

test('the real pages in a browser: the menu, old #links, „Twoje kody” without the expired ones, the contact form – no errors', { skip: !pw && 'Playwright is not installed' }, async () => {
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const shots = process.env.HS_SHOTS;
  try {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const tab = await context.newPage();
      const problems = [];
      tab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      tab.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      const w = viewport.width;
      const where = () => new URL(tab.url()).pathname + new URL(tab.url()).search + new URL(tab.url()).hash;
      const fits = () => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      // The contact API is another module's: the page is tested against what the contract says it answers.
      const sent = [];
      let answer = { status: 200, body: { ok: true } };
      await tab.route('**/api/shop/contact', async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email: 'kontakt@example.com', topics: [{ id: 'launcher', label: 'Pomoc z launcherem' }, { id: 'plus', label: 'Hammer+ i płatności' }, { id: 'bug', label: 'Zgłoszenie błędu' }, { id: 'collab', label: 'Współpraca' }, { id: 'other', label: 'Inne' }], mail: true }) });
        sent.push(route.request().postDataJSON());
        await new Promise((r) => setTimeout(r, 400)); // long enough for a second click
        return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
      });

      // (the site counts calls per address; a test clicks through the pages faster than any visitor – each part of it
      // comes from its own address, as different visitors would)
      const visitor = (net) => context.setExtraHTTPHeaders({ 'x-forwarded-for': `${net}.${w % 250}` });
      await visitor('10.9.1');

      // Every page through the menu (on a phone: behind the ☰ button): no errors, nothing wider than the window.
      await tab.goto(`${base}/`);
      for (const [address, title] of SITE.slice(1)) {
        if (w < 1240) await tab.locator('#nav-toggle').click();
        const link = tab.locator(`#nav a[href="${address}"]`);
        if (!(await link.isVisible())) await tab.locator(`footer a[href="${address}"]`).first().click(); // a page that is only in the footer on wide screens
        else await link.click();
        await tab.waitForURL(base + address);
        assert.equal(await tab.title(), title);
        assert.equal(await fits(), true, `${address} at ${w}: no sideways scrolling`);
        assert.equal(await tab.locator('h1').count(), 1, address);
        if (w >= 1240) assert.equal(await tab.evaluate(() => new Set([...document.querySelectorAll('#nav a')].filter((a) => a.offsetParent).map((a) => a.getBoundingClientRect().top)).size), 1, 'the menu stays on one line');
        if (shots) await tab.screenshot({ path: `${shots}/strona-${address.slice(1)}-${w}.png` });
      }
      // The logo leads home; the download button waits for the release and the session.
      await tab.locator('header .logo').click();
      await tab.waitForURL(`${base}/`);
      await tab.waitForFunction(() => document.getElementById('download').textContent === 'Zaloguj przez Discord i pobierz');

      // Old links (installed launchers open /launcher#plus and /launcher#polecaj): straight to the new page.
      await visitor('10.9.2');
      for (const [old, to] of [['/launcher#plus', '/hammer-plus'], ['/launcher#polecaj', '/polecaj'], ['/#faq', '/pomoc'], ['/#hammershop', '/hammershop'], ['/#funkcje', '/funkcje'], ['/#klient', '/funkcje#hammer-client'], ['/#wyglad', '/funkcje#wyglad'], ['/#start', '/funkcje#start'], ['/hammer-client', '/funkcje#hammer-client'], ['/wyglad', '/funkcje#wyglad'], ['/#aktualnosci', '/aktualnosci'], ['/?connected=1#polecaj', '/polecaj'], ['/launcher?auth=failed#plus', '/hammer-plus']]) {
        await tab.goto(base + old, { waitUntil: 'commit' });
        await tab.waitForFunction((address) => location.pathname + location.search + location.hash === address, to).catch(() => null);
        assert.equal(where(), to, old);
        await tab.locator('h1').waitFor();
      }
      // A # that is not an old section stays on the start page.
      await tab.goto(`${base}/#tresc`);
      await tab.locator('#download').waitFor();
      assert.equal(where(), '/#tresc');

      // Hammer+ signed out: the plans ask for Discord; a "Kup" click signs in and comes back to this page with the plan.
      await visitor('10.9.3');
      await tab.goto(`${base}/hammer-plus`);
      await tab.locator('#plans .plan').first().waitFor();
      assert.equal(await tab.locator('#plans .plan').count(), 3);
      assert.equal(await tab.locator('#plans .plan .sub').first().textContent(), '1 dzień od zakupu');
      assert.equal(await tab.locator('#my-codes').isHidden(), true);
      fakes.state.user = BUYER;
      await tab.locator('#plans .plan button', { hasText: 'Zaloguj i kup' }).nth(1).click();
      await tab.locator('#nick-dialog[open]').waitFor();
      assert.equal(where(), '/hammer-plus', 'back on the Hammer+ page, the address clean');
      assert.match(await tab.locator('#nick-plan').textContent(), /Hammer\+ na 30 dni/);
      await tab.locator('#nick-cancel').click();
      // „Twoje kody”: the expired orders (Steve, Notch) are not there; the one that runs the longest comes first.
      await tab.locator('#my-codes .code-card').first().waitFor();
      assert.deepEqual(await tab.locator('#my-codes .code-card b').allTextContents(), ['Konto Alex', 'Konto Jeb']);
      assert.equal(await tab.locator('#my-codes .pill').first().textContent(), 'na zawsze');
      assert.equal(plus.verify(await tab.locator('#my-codes .code').first().textContent()).mc, MC.Alex);
      assert.equal(await tab.locator('#my-codes-more').isHidden(), true, 'two codes need no folding');
      assert.equal(await fits(), true);
      // Many short plans: three codes show, the rest waits behind „Pokaż wszystkie (N)”.
      const sid = await signIn(BUYER);
      for (const nick of ['Steve', 'Notch', 'Steve']) await buyPlus(sid, nick, 'p1');
      await tab.reload();
      await tab.locator('#my-codes-more').waitFor();
      assert.equal(await tab.locator('#my-codes-more').textContent(), 'Pokaż wszystkie (5)');
      assert.equal(await tab.locator('#my-codes .code-card:visible').count(), 3);
      await tab.locator('#my-codes-more').click();
      assert.equal(await tab.locator('#my-codes .code-card:visible').count(), 5);
      assert.deepEqual([await tab.locator('#my-codes-more').textContent(), await tab.locator('#my-codes-more').getAttribute('aria-expanded')], ['Pokaż mniej', 'true']);
      if (shots) await tab.screenshot({ path: `${shots}/hammer-plus-kody-${w}.png`, fullPage: true });
      await tab.locator('#my-codes-more').click();
      assert.equal(await tab.locator('#my-codes .code-card:visible').count(), 3);
      // (the test's own purchases end again, so the second window size starts from the same two codes)
      for (const o of webStore.ordersOf(BUYER.id)) if (o.status === 'paid' && o.plus.days === 1 && o.plus.exp * 1000 > Date.now()) expire(o.id, 60);

      // Back from Stripe: the payment is checked and the fresh code shows in the success card.
      const bought = await call('POST', '/api/shop/checkout', { sid, body: { kind: 'plus', plan: 'p30', nick: 'Notch', requestId: crypto.randomUUID() } });
      const stripeId = bought.body.url.split('/').pop();
      fakes.pay(stripeId);
      await tab.goto(`${base}/launcher?payment=return&session_id=${stripeId}`); // the address an old payment page would come back to
      await tab.locator('#plus-result .code-card').waitFor();
      assert.match(await tab.locator('#plus-result .code-card b').textContent(), /Gotowe! Konto Notch/);
      assert.equal(where(), '/hammer-plus', 'on the Hammer+ page, the address clean – a refresh does not check again');
      assert.deepEqual(await tab.locator('#my-codes .code-card b').allTextContents(), ['Konto Alex', 'Konto Jeb'], 'the fresh one is in the card above, not twice');
      expire(bought.body.order, 60);

      // Kontakt: the address and the topics come from the server; signed in, the name is filled in.
      await visitor('10.9.4');
      await tab.goto(`${base}/kontakt?temat=bug`);
      await tab.locator('#contact-mail:visible').waitFor();
      assert.equal(await tab.locator('#contact-mail').getAttribute('href'), 'mailto:kontakt@example.com');
      assert.equal(await tab.locator('#contact-topic').inputValue(), 'bug');
      assert.deepEqual(await tab.locator('#contact-topic option').allTextContents(), ['Pomoc z launcherem', 'Hammer+ i płatności', 'Zgłoszenie błędu', 'Współpraca', 'Inne']);
      await tab.waitForFunction(() => document.getElementById('contact-name').value === 'Kupujacy');
      assert.ok((await tab.locator('#contact-website').boundingBox()).x < 0, 'the trap field is off the screen');
      // Nothing typed: every field says what is wrong, in Polish, and nothing is sent.
      await tab.locator('#contact-name').fill('');
      await tab.locator('#contact-send').click();
      assert.deepEqual(await tab.locator('.field-error').allTextContents(), ['Podaj imię albo nick – co najmniej 2 znaki.', 'Podaj swój e-mail – na niego odpiszemy.', 'Napisz trochę więcej – co najmniej 10 znaków.']);
      assert.equal(await tab.evaluate(() => document.activeElement.id), 'contact-name');
      await tab.locator('#contact-name').fill('Ola');
      await tab.locator('#contact-email').fill('ola@');
      await tab.locator('#contact-message').fill('Launcher nie startuje po aktualizacji.');
      assert.equal(await tab.locator('#contact-count').textContent(), '38');
      await tab.locator('#contact-send').click();
      assert.deepEqual(await tab.locator('.field-error').allTextContents(), ['Ten adres e-mail wygląda na niepoprawny – sprawdź go.']);
      assert.equal(sent.length, 0);
      // The server refuses: its sentence is shown as it is, the form stays filled in.
      await tab.locator('#contact-email').fill('ola@example.com');
      answer = { status: 429, body: { error: 'Za dużo wiadomości – spróbuj ponownie za kilka minut.' } };
      await tab.locator('#contact-send').click();
      await tab.locator('#contact-error:visible').waitFor();
      assert.equal(await tab.locator('#contact-error').textContent(), 'Za dużo wiadomości – spróbuj ponownie za kilka minut.');
      assert.equal(await tab.locator('#contact-message').inputValue(), 'Launcher nie startuje po aktualizacji.');
      assert.equal(await tab.locator('#contact-send').isDisabled(), false);
      // It goes through: sent once however fast the clicks are, the button waits meanwhile, then the thanks.
      answer = { status: 200, body: { ok: true } };
      sent.length = 0;
      await tab.locator('#contact-send').click();
      await tab.locator('#contact-send').click({ force: true }).catch(() => null);
      assert.equal(await tab.locator('#contact-send').isDisabled(), true);
      await tab.locator('#contact-done:visible').waitFor();
      assert.match(await tab.locator('#contact-done').textContent(), /Dziękujemy – odpiszemy na podany e-mail[\s\S]*ola@example\.com/);
      assert.equal(await tab.locator('#contact-form').isHidden(), true);
      assert.deepEqual(sent, [{ name: 'Ola', email: 'ola@example.com', topic: 'bug', message: 'Launcher nie startuje po aktualizacji.', website: '' }]);
      if (shots) await tab.screenshot({ path: `${shots}/kontakt-wyslane-${w}.png` });
      await tab.locator('#contact-again').click();
      assert.deepEqual([await tab.locator('#contact-form').isVisible(), await tab.locator('#contact-message').inputValue(), await tab.locator('#contact-name').inputValue()], [true, '', 'Ola']);
      assert.equal(await fits(), true);

      // Aktualności: nothing published → the page says so (and still shows the current version).
      await tab.goto(`${base}/aktualnosci`);
      await tab.locator('#news-empty:visible').waitFor();
      assert.match(await tab.locator('#release-title').textContent(), /Hammer Launcher 2\.11\.1/);
      webStore.addNews({ title: 'Nowy sezon', body: 'Start w piątek.', tag: 'Nowość', pinned: false, url: null, image: null, by: OWNER.id });
      await tab.reload();
      await tab.locator('#news article').first().waitFor();
      assert.equal(await tab.locator('#news article h2').first().textContent(), 'Nowy sezon');
      assert.equal(await tab.locator('#news-empty').isHidden(), true);
      for (const n of webStore.newsList()) webStore.removeNews(n.id);

      // (the browser itself notes the 429 the form was answered with above – that one is the test's doing)
      assert.deepEqual(problems.filter((p) => !/status of 429/.test(p)), [], `no errors at ${w}`);
      assert.equal(problems.length, 1);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test('Funkcje in a browser: three parts, one at a time – the switcher, deep links, Back and Forward, clips only in the open part; all three without scripts', { skip: !pw && 'Playwright is not installed' }, async () => {
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const shots = process.env.HS_SHOTS;
  try {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const w = viewport.width;
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.9.5.${w % 250}` });
      const tab = await context.newPage();
      const problems = [];
      tab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      tab.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      const where = () => new URL(tab.url()).pathname + new URL(tab.url()).search + new URL(tab.url()).hash;
      const fits = () => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      /** The parts that are on the screen (laid out at all) and the tab the switcher marks. */
      const open = () => tab.evaluate(() => ({
        shown: [...document.querySelectorAll('.part')].filter((p) => p.getClientRects().length).map((p) => p.id),
        selected: [...document.querySelectorAll('.part-tab[aria-selected="true"]')].map((t) => t.id),
      }));
      const isOpen = async (part, address) => {
        await tab.waitForFunction((id) => document.documentElement.getAttribute('data-part') === id, part);
        assert.deepEqual(await open(), { shown: [part], selected: [`part-tab-${part}`] }, `${part} is the one part on the screen`);
        if (address) assert.equal(where(), address);
        assert.equal(await fits(), true, `${part} at ${w}: no sideways scrolling`);
      };
      const playing = () => tab.evaluate(() => [...document.querySelectorAll('video.clip')].filter((v) => !v.paused).map((v) => v.closest('.part').id));
      const switcherOnScreen = async () => {
        const box = await tab.locator('#parts').boundingBox();
        return box.y >= 0 && box.y + box.height <= viewport.height;
      };

      // The page opens on the launcher part; the switcher is a tab list, the parts are its panels, the menu marks Funkcje.
      await tab.goto(`${base}/funkcje`);
      await isOpen('launcher', '/funkcje');
      assert.equal(await tab.locator('#parts').getAttribute('role'), 'tablist');
      assert.deepEqual(await tab.locator('.part-tab').evaluateAll((tabs) => tabs.map((t) => [t.getAttribute('role'), t.getAttribute('aria-controls'), t.tabIndex, document.getElementById(t.getAttribute('aria-controls')).getAttribute('aria-labelledby') === t.id])), [['tab', 'launcher', 0, true], ['tab', 'hammer-client', -1, true], ['tab', 'wyglad', -1, true]]);
      assert.deepEqual(await tab.locator('.part').evaluateAll((parts) => parts.map((p) => p.getAttribute('role'))), ['tabpanel', 'tabpanel', 'tabpanel']);
      assert.equal(await tab.locator('#nav a[aria-current="page"]').first().getAttribute('href'), '/funkcje');
      assert.equal(await tab.locator('h1').count(), 1);
      // The tabs inside the launcher part are their own thing: a click there changes the pane, not the part or the address.
      await tab.locator('#tab-mody').click();
      assert.equal(await tab.locator('#pane-mody').getAttribute('class'), 'tabpanel is-active');
      await isOpen('launcher', '/funkcje');
      await tab.locator('#pane-mody video').scrollIntoViewIfNeeded();
      await tab.waitForFunction(() => !document.querySelector('#pane-mody video').paused);
      assert.deepEqual(await playing(), ['launcher']);
      if (shots) await tab.screenshot({ path: `${shots}/funkcje-launcher-${w}.png` });

      // The switcher: another part, the address follows, the page does not jump, the launcher's clip stops.
      await tab.locator('#part-tab-hammer-client').click();
      await isOpen('hammer-client', '/funkcje#hammer-client');
      assert.equal(await switcherOnScreen(), true, 'the switcher stays where it was clicked');
      await tab.waitForFunction(() => [...document.querySelectorAll('video.clip')].every((v) => v.paused));
      assert.equal(await tab.locator('#hammer-client h2').first().textContent(), 'Twój Minecraft, tylko lepszy');
      if (shots) await tab.screenshot({ path: `${shots}/funkcje-hammer-client-${w}.png` });
      await tab.locator('#part-tab-wyglad').click();
      await isOpen('wyglad', '/funkcje#wyglad');
      await tab.locator('.theme-pick[data-theme="end"]').click();
      assert.equal(await tab.locator('#theme-stage').getAttribute('data-theme'), 'end');
      await tab.locator('.live video').first().scrollIntoViewIfNeeded();
      await tab.waitForFunction(() => [...document.querySelectorAll('#wyglad video')].some((v) => !v.paused));
      assert.deepEqual([...new Set(await playing())], ['wyglad'], 'clips run only in the open part');
      if (shots) await tab.screenshot({ path: `${shots}/funkcje-wyglad-${w}.png` });
      // A click on the open part adds no step; Back and Forward walk through the parts.
      await tab.locator('#part-tab-wyglad').click();
      await tab.goBack();
      await isOpen('hammer-client', '/funkcje#hammer-client');
      await tab.goBack();
      await isOpen('launcher', '/funkcje');
      await tab.goForward();
      await isOpen('hammer-client', '/funkcje#hammer-client');

      // The keyboard: arrows, Home and End move between the parts (focus follows), Space opens like a click.
      await tab.locator('#part-tab-hammer-client').focus();
      await tab.keyboard.press('ArrowRight');
      await isOpen('wyglad', '/funkcje#wyglad');
      assert.equal(await tab.evaluate(() => document.activeElement.id), 'part-tab-wyglad');
      await tab.keyboard.press('ArrowRight');
      await isOpen('launcher', '/funkcje');
      await tab.keyboard.press('End');
      await isOpen('wyglad', '/funkcje#wyglad');
      await tab.keyboard.press('Home');
      await isOpen('launcher', '/funkcje');
      await tab.locator('#part-tab-hammer-client').focus();
      await tab.keyboard.press('Space');
      await isOpen('hammer-client', '/funkcje#hammer-client');

      // A link further down the page that leads to another part: that part, from its top, the switcher in sight.
      await tab.locator('#part-tab-launcher').click();
      await tab.locator('a.btn[href="#hammer-client"]').click();
      await isOpen('hammer-client', '/funkcje#hammer-client');
      await tab.waitForFunction(() => window.scrollY === 0);
      assert.equal(await tab.evaluate(() => document.activeElement.id), 'part-tab-hammer-client');
      await tab.locator('#hammer-client a[href="#wyglad"]').first().click();
      await isOpen('wyglad', '/funkcje#wyglad');
      // The footer's links to the parts switch on the spot – the page is not loaded again.
      await tab.evaluate(() => { window.samePage = true; });
      await tab.locator('footer a[href="/funkcje#hammer-client"]').click();
      await isOpen('hammer-client', '/funkcje#hammer-client');
      await tab.waitForFunction(() => window.scrollY === 0);
      assert.equal(await tab.evaluate(() => window.samePage), true);
      // A # typed into the address: the part it names – or the part that holds what it names (#start is in the launcher part).
      await tab.evaluate(() => { location.hash = '#wyglad'; });
      await isOpen('wyglad', '/funkcje#wyglad');
      await tab.evaluate(() => { location.hash = '#start'; });
      await isOpen('launcher', '/funkcje#start');
      await tab.waitForFunction(() => { const r = document.getElementById('start').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });

      // A link from somewhere else straight to a part: only that part, from the top of the page.
      for (const [address, part, to] of [
        ['/funkcje#wyglad', 'wyglad', '/funkcje#wyglad'],
        ['/funkcje#hammer-client', 'hammer-client', '/funkcje#hammer-client'],
        ['/funkcje#launcher', 'launcher', '/funkcje#launcher'],
        // the old addresses: pages of their own for a while, and before that sections of the one long page
        ['/hammer-client', 'hammer-client', '/funkcje#hammer-client'],
        ['/wyglad', 'wyglad', '/funkcje#wyglad'],
        ['/#klient', 'hammer-client', '/funkcje#hammer-client'],
        ['/#wyglad', 'wyglad', '/funkcje#wyglad'],
        ['/#funkcje', 'launcher', '/funkcje'],
      ]) {
        await tab.goto('about:blank');
        await tab.goto(base + address, { waitUntil: 'commit' });
        await tab.waitForFunction((there) => location.pathname + location.search + location.hash === there, to);
        await tab.waitForLoadState('load');
        await isOpen(part, to);
        assert.equal(await tab.evaluate(() => window.scrollY), 0, `${address}: the page starts at its top`);
        assert.equal(await switcherOnScreen(), true, address);
      }
      await tab.goto('about:blank');
      await tab.goto(`${base}/#start`, { waitUntil: 'commit' });
      await tab.waitForFunction(() => location.pathname + location.hash === '/funkcje#start');
      await tab.waitForLoadState('load');
      await isOpen('launcher', '/funkcje#start');
      await tab.waitForFunction(() => { const r = document.getElementById('start').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
      // The start page's cards lead to the parts.
      await tab.goto(`${base}/`);
      await tab.locator('.go-card[href="/funkcje#wyglad"]').click();
      await tab.waitForURL(`${base}/funkcje#wyglad`);
      await isOpen('wyglad', '/funkcje#wyglad');

      // A sign-in started on a part comes back to Funkcje – and the page opens that part again.
      fakes.state.user = GUEST;
      await tab.locator('#login').click();
      await tab.waitForFunction(() => document.querySelector('#who > span') && document.querySelector('#who > span').textContent === 'Gosc');
      await isOpen('wyglad', '/funkcje#wyglad');

      assert.deepEqual(problems, [], `no errors at ${w}`);
      await context.close();
    }

    // Without scripts: nothing is hidden – the three parts follow one another and the switcher's links jump to them.
    const plain = await browser.newContext({ viewport: { width: 1366, height: 768 }, javaScriptEnabled: false });
    const page = await plain.newPage();
    await page.goto(`${base}/funkcje`);
    assert.equal(await page.locator('html').getAttribute('data-part'), null);
    for (const part of ['launcher', 'hammer-client', 'wyglad']) assert.equal(await page.locator(`#${part}`).isVisible(), true, `${part} without scripts`);
    assert.deepEqual(await page.locator('.part-tab').evaluateAll((tabs) => tabs.map((t) => [t.getAttribute('href'), t.getAttribute('role')])), [['#launcher', null], ['#hammer-client', null], ['#wyglad', null]]);
    await page.locator('#part-tab-wyglad').click();
    assert.equal(new URL(page.url()).hash, '#wyglad');
    let top = Infinity; // (the page scrolls there smoothly – it takes a moment)
    for (let i = 0; i < 40 && top >= 200; i++) {
      await page.waitForTimeout(100);
      top = (await page.locator('#wyglad').boundingBox()).y;
    }
    assert.ok(top < 200, 'the link jumps to the part');
    await plain.close();
  } finally {
    await browser.close();
  }
});
