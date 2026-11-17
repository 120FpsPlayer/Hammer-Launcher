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
  ['/hammer-client', 'Hammer Client – Hammer Launcher', /Twój Minecraft, tylko lepszy/],
  ['/wyglad', 'Wygląd: motywy i peleryny – Hammer Launcher', /Wygląd po Twojemu/],
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
    assert.doesNotMatch(html, /\{\{|<!--|data-nav=|<style|style="|<script(?! src="\/assets\/_v\/[0-9a-f]{8}\/launcher(?:-old)?\.js"><\/script>)/, address);
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
  assert.ok(start.indexOf('launcher-old.js') > 0 && start.indexOf('launcher-old.js') < start.indexOf('</head>'), 'in the <head> of the start page');
  assert.doesNotMatch((await call('GET', '/hammer-plus')).body, /launcher-old\.js/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'assets', 'launcher-old.js'), 'utf8');
  for (const [hash, page] of [['plus', 'hammer-plus'], ['polecaj', 'polecaj'], ['faq', 'pomoc'], ['funkcje', 'funkcje'], ['klient', 'hammer-client'], ['wyglad', 'wyglad'], ['aktualnosci', 'aktualnosci'], ['hammershop', 'hammershop']]) {
    assert.match(script, new RegExp(`${hash}(: | = )'${page}'`), `#${hash} → /${page}`);
    assert.ok(pages.PAGES.some((p) => p.id === page), `/${page} is a page`);
  }
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
  for (const outside of ['https://evil.example', '//evil.example', '/kontakt', 'hammer-plus/../admin', 'constructor', '__proto__']) {
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
  assert.equal((await call('GET', '/download', { sid })).location, '/updates/Hammer-Launcher-Setup-2.11.1.exe');
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
      for (const [old, to] of [['/launcher#plus', '/hammer-plus'], ['/launcher#polecaj', '/polecaj'], ['/#faq', '/pomoc'], ['/#hammershop', '/hammershop'], ['/#funkcje', '/funkcje'], ['/#klient', '/hammer-client'], ['/#wyglad', '/wyglad'], ['/#start', '/funkcje#start'], ['/#aktualnosci', '/aktualnosci'], ['/?connected=1#polecaj', '/polecaj'], ['/launcher?auth=failed#plus', '/hammer-plus']]) {
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
      assert.ok((await tab.locator('#contact-website').boundingBox()).x < 0, 'the trap field is off the screen');
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

      assert.deepEqual(problems, [], `no errors at ${w}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
