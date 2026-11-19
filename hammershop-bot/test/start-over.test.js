'use strict';

// „Start od zera (przed premierą)” in the admin panel (Hammer Launcher's site, owner only): before the premiere every
// trace of the test weeks goes – on the website (statistics, orders, accounts and sessions, referrals, messages, cloud
// copies, capes) and in the bot (closed tickets and the counter, invite tracking, the Hammer+ codes list, ended
// giveaways, message counters) – after a byte-for-byte copy of both databases into data/kopia-przed-startem-…/, which
// no address serves. What the owner set up stays exactly as it was. Over real HTTP against a local copy of the website
// with a fake Discord server; the dialog in a real browser on a phone and a laptop.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { textOf } = require('./helpers/fakeInteraction');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { buildServer } = require('../src/builder/executor');
const { ROLES } = require('../src/builder/layout');
const { env } = require('../src/env');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const releases = require('../src/web/releases');
const { createWebServer } = require('../src/web/server');

const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const ADMIN = { id: '200000000000000401', username: 'adminka', global_name: 'Adminka', avatar: null };
const BUYER = { id: '200000000000000402', username: 'tester', global_name: 'Tester', avatar: null };
const MC = '8667ba71b85a4004af54457a9734eed7';
const OTHER_GUILD = '200000000000000499'; // a server in db.json the bot is not on any more – only closed tickets there
const MARK = 'notatka-zespolu-7f3a'; // a staff note: whatever serves a copy of db.json would show it

let fakes;
let site;
let base;
let guild;
const sids = {};

test.before(async () => {
  fakes = await startFakes();
  guild = new FakeGuild({ ownerId: OWNER.id });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  guild.addMember(ADMIN.id, [db.roleId(guild.id, ROLES.find((r) => r.perms === 'admin').key)]);
  guild.addMember(BUYER.id, [db.roleId(guild.id, 'member')]);
  website._setClient(guild.client);
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onPaid: website.onPaid, onLogin: website.onLogin, isMember: website.isMember, currency: () => 'pln',
    level: website.panelLevel, log: website.panelLog, plus: website.panelPlus, referrals: website.panelReferrals, statsReset: website.statsReset, startOver: website.startOver,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  for (const [name, user] of Object.entries({ owner: OWNER, admin: ADMIN, buyer: BUYER })) sids[name] = await signIn(user);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await tick();
  }
}
/** The console, quiet while fn runs. → { result, said } */
async function quietly(fn) {
  const said = [];
  const { warn, log } = console;
  console.warn = (...a) => said.push(a.join(' '));
  console.log = (...a) => said.push(a.join(' '));
  try {
    return { result: await fn(), said };
  } finally {
    Object.assign(console, { warn, log });
  }
}
let ip = 0;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).find((c) => c.startsWith(`${name}=`)) ?? '';
async function signIn(user) {
  fakes.state.user = user;
  const start = await fetch(`${base}/api/shop/auth/start?next=admin`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const jar = [cookieOf(start, 'hs_oauth'), cookieOf(start, 'hs_next')].filter(Boolean).join('; ');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: jar }, redirect: 'manual' });
  return cookieOf(back, 'hs_sid');
}
async function call(method, pathname, { who = null, body, origin = base } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: { 'x-forwarded-for': `10.71.${Math.floor(++ip / 250)}.${ip % 250}`, ...(who && { cookie: sids[who] }), ...(origin && method !== 'GET' && { origin }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** A raw GET – the path exactly as written (fetch would tidy up „..” before sending). */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: site.address().port, path: rawPath, method: 'GET', headers: { 'x-forwarded-for': `10.72.0.${++ip % 250}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const backups = () => fs.readdirSync(db.dataDir).filter((f) => f.startsWith('kopia-przed-startem-'));
const channelOf = (key) => guild.channels.cache.get(db.channelId(guild.id, key));

/** A ticket record (and, unless gone, its channel) as the ticket system keeps it. */
async function ticket(guildId, number, status) {
  const settings = db.settings(guildId);
  const channel = guildId === guild.id && status !== 'deleted' ? await guild.channels.create({ name: `pomoc-${String(number).padStart(4, '0')}`, type: ChannelType.GuildText, parent: status === 'closed' ? settings.closedCategoryId : settings.categoryId }) : null;
  const channelId = channel?.id ?? String(BigInt('300000000000000000') + BigInt(number) + BigInt(guildId.length));
  db.createTicket({ channelId, guildId, number, typeId: 'support', ownerId: BUYER.id, ownerName: 'tester', status, priority: 'normal', claimedBy: null, participants: [], answers: {}, createdAt: Date.now(), lastActivity: Date.now(), ...(status !== 'open' && { closedAt: Date.now(), closedBy: OWNER.id }) });
  return channelId;
}

/** Everything the test weeks leave behind – and everything the owner set up, which must stay. */
async function seed() {
  // ── The website ──
  fs.mkdirSync(releases.DIR(), { recursive: true });
  fs.writeFileSync(releases.fileOf('Hammer-Launcher-Setup-2.11.4.exe'), Buffer.from('MZ-fake-installer'));
  await quietly(() => releases.publish({ version: '2.11.4', file: 'Hammer-Launcher-Setup-2.11.4.exe', notes: 'Beta' }));
  for (let i = 0; i < 3; i += 1) webStore.countDownload('2.11.4');
  webStore.countLaunch('2.11.4', 'k1');
  webStore.countUserDownload(BUYER.id);
  const order = webStore.createOrder({ userId: BUYER.id, kind: 'plus', items: [{ id: 'p30', name: 'Hammer+ na 30 dni', price: 1499, quantity: 1 }], amount: 1499, currency: 'pln', requestId: crypto.randomUUID(), plus: { nick: 'Steve', mc: MC, days: 30 } });
  webStore.markPaid(order.id, { stripe_id: 'cs_test_seed' });
  webStore.referralCode(OWNER.id);
  webStore.addReferral(BUYER.id, OWNER.id);
  webStore.addReferralDays(OWNER.id, 7, { balance: true });
  webStore.addReferralReward(OWNER.id, { id: 'r1', mc: MC, nick: 'Steve', days: 7, at: Date.now(), friend: BUYER.id });
  webStore.addMessage({ name: 'Jan', email: 'jan@example.com', topic: 'pomoc', text: 'Testowa wiadomość' });
  webStore.saveCloud(MC, { servers: ['mc.example.com'] });
  webStore.setCape(MC, 'ogien', 0);
  webStore.setCosmetics(MC, { wings: 'smok', halo: true }, 0);
  webStore.addNews({ title: 'Beta jest dostępna', body: 'Zostaje', by: OWNER.id });
  webStore.setAlert({ level: 'info', text: 'Premiera 6 grudnia', by: OWNER.id });
  webStore.setPlusPlans([{ id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1499 }]);
  webStore.setRoadmap([{ id: webStore.roadmapId(), section: 'now', title: 'Premiera', note: '', at: Date.now(), by: OWNER.id }], OWNER.id);
  webStore.addAnnouncement({ title: 'Startujemy', kind: 'ogloszenie', ping: 'none', by: OWNER.id, url: 'https://discord.com/channels/1/2/3', channelId: '2', messageId: '3', crossposted: false });

  // ── The bot ──
  const g = db.guild(guild.id);
  const open = await ticket(guild.id, 7, 'open');
  const closed = await ticket(guild.id, 3, 'closed');
  await ticket(guild.id, 2, 'deleted');
  g.counter = 9;
  db.guild(OTHER_GUILD).counter = 12;
  await ticket(OTHER_GUILD, 12, 'closed');
  g.invites = { members: { [BUYER.id]: { inviterId: OWNER.id, code: 'abc', joinedAt: Date.now(), verified: true, creditedTo: OWNER.id } }, inviters: {}, rewarded: { [OWNER.id]: { 5: { code: null, percent: 10, at: Date.now(), delivered: true } } } };
  g.plusCodes = [{ id: 'a1b2c3d4e5f60718', mc: MC, nick: 'Steve', exp: 0, by: OWNER.id, at: Date.now(), source: 'website', discordId: BUYER.id }];
  await guild.members.cache.get(BUYER.id).roles.add(db.roleId(guild.id, 'hammerPlus'));
  g.giveaways = { gw_end: { id: 'gw_end', prize: 'Hammer+ na 30 dni', ended: true, endsAt: Date.now() - 86_400_000, entries: [BUYER.id] }, gw_run: { id: 'gw_run', prize: 'Hammer+ na zawsze', ended: false, endsAt: Date.now() + 86_400_000, entries: [] } };
  g.activity = { total: { [BUYER.id]: 42 }, weekKey: require('../src/features/stats').weekKey(), week: { [BUYER.id]: 5 } };
  g.notes = { [BUYER.id]: [{ id: 'n1', by: OWNER.id, text: MARK, at: Date.now() }] };
  g.blacklist = [{ userId: '200000000000000498', reason: 'spam', by: OWNER.id, at: Date.now() }];
  g.knowledge = { seq: 1, entries: [{ id: 1, questions: ['Jak zainstalować?'], answer: 'Pobierz instalator.', by: OWNER.id, at: Date.now() }] };
  g.featuredServers = [{ id: 'f1', name: 'Serwer', address: 'mc.example.com', addedBy: OWNER.id, addedAt: Date.now() }];
  db.updateSettings(guild.id, { autoCloseHours: 72 });
  await require('../src/lib/panels').refresh(guild, 'leaderboard');
  return { open, closed };
}

let seeded = null;
test('„Start od zera”: only the owner, from the panel itself, after typing PREMIERA – anything else changes nothing', async () => {
  seeded = await seed();
  webStore.flush();
  db.flush();
  const before = { db: fs.readFileSync(path.join(db.dataDir, 'db.json')), web: fs.readFileSync(path.join(db.dataDir, 'web.json')) };
  const reset = (opts) => call('POST', '/api/admin/start-over', { who: 'owner', body: { confirm: 'PREMIERA' }, ...opts });
  assert.equal((await reset({ who: null })).status, 401);
  const byAdmin = await reset({ who: 'admin' });
  assert.deepEqual([byAdmin.status, byAdmin.body.error], [403, 'To może zrobić tylko właściciel serwera.']);
  assert.equal((await reset({ who: 'buyer' })).status, 403);
  assert.equal((await reset({ origin: null })).status, 403, 'no Origin – not from the panel');
  assert.equal((await reset({ origin: 'https://evil.example' })).status, 403);
  for (const confirm of [undefined, '', 'ZERUJ', 'tak', 'PREMIERA TERAZ', 'premier']) {
    const res = await reset({ body: { confirm } });
    assert.deepEqual([res.status, res.body.error], [400, 'Wpisz PREMIERA w polu potwierdzenia – bez tego nic nie zostanie usunięte.'], String(confirm));
  }
  assert.equal((await reset({ body: null })).status, 400);
  assert.deepEqual(backups(), [], 'no copy made, nothing reset');
  // The copy cannot be made (a full disk): nothing is deleted, no half copy is left, the owner is told why.
  const { copyFileSync } = fs;
  let copied = 0;
  fs.copyFileSync = (...args) => {
    if ((copied += 1) === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return copyFileSync(...args);
  };
  try {
    const full = await quietly(() => reset());
    assert.deepEqual([full.result.status, full.result.body.error], [500, 'Nie udało się zrobić kopii danych (na dysku serwera zabrakło miejsca) – nic nie zostało usunięte. Spróbuj ponownie.']);
    assert.ok(full.said.some((l) => /Start od zera przerwany – nie udało się zrobić kopii danych: ENOSPC/.test(l)), full.said.join('\n'));
  } finally {
    fs.copyFileSync = copyFileSync;
  }
  assert.deepEqual(backups(), [], 'the half copy is gone');
  webStore.flush();
  db.flush();
  assert.ok(fs.readFileSync(path.join(db.dataDir, 'db.json')).equals(before.db), 'db.json as it was');
  assert.ok(fs.readFileSync(path.join(db.dataDir, 'web.json')).equals(before.web), 'web.json as it was');
  assert.equal((await call('GET', '/api/admin/me', { who: 'owner' })).status, 200, 'still signed in');
});

test('„Start od zera”: a copy first, then every trace of the tests goes – everything the owner set up stays exactly as it was; Discord follows', async () => {
  const { open, closed } = seeded; // the open #0007 and the closed #0003 (the test above seeded them)
  const ranking = channelOf('leaderboard').messageList.find((m) => /Ranking/.test(textOf(m.body)));
  assert.match(textOf(ranking.body), /<@200000000000000402> – \*\*42\*\*/, 'the #ranking card shows the test chatter');
  const stat = channelOf('statDownloads');
  await stat.setName('📥 Pobrania: 3');
  assert.ok(guild.members.cache.get(BUYER.id).roles.cache.has(db.roleId(guild.id, 'hammerPlus')));

  // What it was right before – on the disk and in memory.
  webStore.flush();
  db.flush();
  const files = { 'db.json': fs.readFileSync(path.join(db.dataDir, 'db.json')), 'web.json': fs.readFileSync(path.join(db.dataDir, 'web.json')) };
  const web = clone(webStore._state());
  const bot = clone(db.guild(guild.id));
  const openTicket = clone(db.getTicket(open));
  assert.ok(Object.keys(web.users).length >= 3 && Object.keys(web.sessions).length >= 3 && Object.keys(web.orders).length === 1);

  const { result: done, said } = await quietly(() => call('POST', '/api/admin/start-over', { who: 'owner', body: { confirm: ' premiera ' } }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.folder, /^kopia-przed-startem-\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.deepEqual(backups(), [done.body.folder]);
  assert.deepEqual(done.body.before, { downloads: 3, launches: 1, releases: 3, people: 1, orders: 1, users: Object.keys(web.users).length, sessions: Object.keys(web.sessions).length, referrals: 2, messages: 1, cloud: 1, capes: 1, cosmetics: 1, tickets: 3, invites: 1, plusCodes: 1, giveaways: 1, activity: 1 });

  // The copy: both files exactly as they were (byte for byte) – putting them back undoes everything.
  const dir = path.join(db.dataDir, done.body.folder);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['db.json', 'web.json']);
  for (const [name, bytes] of Object.entries(files)) assert.ok(fs.readFileSync(path.join(dir, name)).equals(bytes), `${name}: a byte-for-byte copy`);

  // The website: what the tests left is gone, what the owner set up is identical (release counters are statistics).
  const expectWeb = { ...clone(web), users: {}, sessions: {}, orders: {}, cloud: {}, capes: {}, referrals: null, stats: { downloads: {}, launches: {} } };
  delete expectWeb.cosmetics;
  delete expectWeb.messages;
  for (const r of expectWeb.releases.list) r.downloads = 0;
  assert.deepEqual(webStore._state(), expectWeb);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(db.dataDir, 'web.json'), 'utf8')), expectWeb, 'on the disk at once');
  assert.ok(webStore.newsList().length && webStore.getAlert() && webStore.plusPlans().length && webStore.roadmap().items.length && webStore.announcementList().length && webStore.currentRelease());
  assert.ok(fs.existsSync(releases.fileOf('Hammer-Launcher-Setup-2.11.4.exe')), 'the installer stays');

  // The bot: closed tickets gone, open ones identical; the counter so that no number repeats.
  assert.deepEqual(db.tickets().map((t) => t.channelId), [open]);
  assert.deepEqual(db.getTicket(open), openTicket);
  const expectBot = { ...clone(bot), counter: 7, invites: { members: {}, inviters: {}, rewarded: {} }, plusCodes: [], activity: { total: {}, weekKey: null, week: {} } };
  delete expectBot.giveaways.gw_end;
  assert.deepEqual(clone(db.guild(guild.id)), expectBot, 'everything else on the server – build, panels, settings, notes, /wiedza … – as it was');
  assert.equal(JSON.parse(fs.readFileSync(path.join(db.dataDir, 'db.json'), 'utf8')).guilds[guild.id].counter, 7, 'on the disk at once');
  assert.equal(db.nextTicketNumber(guild.id), 8, 'open #0007 stays → the next one is #0008');
  assert.equal(db.nextTicketNumber(OTHER_GUILD), 1, 'none open → the next one is #0001');

  // Everybody is signed out – the owner too.
  assert.equal((await call('GET', '/api/admin/me', { who: 'owner' })).status, 401);
  assert.equal((await call('GET', '/api/shop/session', { who: 'buyer' })).body.user, null);

  // One line in the console and in the server log – with the copy's folder.
  assert.ok(said.some((l) => l.includes(`Start od zera z panelu admina przez 1 – kopia danych: data/${done.body.folder}. Usunięto: 1 zamówienie, 3 konta na stronie, 2 wpisy poleceń, 1 wiadomość, 3 pobrania (90 dni), 1 uruchomienie launchera, 3 zamknięte tickety, 1 zaproszenie, 1 wpis kodów Hammer+, 1 zakończony giveaway.`)), said.join('\n'));
  await until(() => channelOf('serverLogs').messageList.some((m) => /Start od zera \(przed premierą\)/.test(textOf(m.body))), 'the log line');
  const logs = channelOf('serverLogs').messageList.map((m) => textOf(m.body)).join('\n');
  assert.match(logs, new RegExp(`Start od zera \\(przed premierą\\)\\*\\*: usunięto dane z testów – statystyki, 1 zamówienie, 3 konta na stronie, polecenia, wiadomości, 3 zamknięte tickety, zaproszenia, listę kodów Hammer\\+ i zakończone giveawaye\\. Kopia sprzed resetu: \`data/${done.body.folder}\` · <@1>`));

  // Discord follows right away: „📥 Pobrania: 0”, #ranking empty, the closed ticket's channel gone, 💎 Hammer+ off.
  await until(() => /: 0$/.test(stat.name) && !guild.channels.cache.has(closed) && !guild.members.cache.get(BUYER.id).roles.cache.has(db.roleId(guild.id, 'hammerPlus')), 'Discord updated');
  assert.ok(guild.channels.cache.has(open), 'the open ticket\'s channel stays');
  await until(() => /Jeszcze nikogo/.test(textOf(ranking.body)), 'the #ranking card');

  // No address serves the copy – whatever the path looks like.
  const folder = done.body.folder;
  for (const p of [`/data/${folder}/db.json`, `/${folder}/db.json`, `/${folder}/web.json`, `/data/db.json`, `/db.json`, `/updates/${folder}/db.json`, `/updates/..%2F${folder}%2Fdb.json`, `/updates/../${folder}/db.json`, `/assets/../../data/${folder}/db.json`, `/assets/..%2F..%2Fdata%2F${folder}%2Fdb.json`, `/assets/_v/x/../../../data/${folder}/web.json`, `/download/../data/${folder}/db.json`]) {
    const res = await rawGet(p);
    assert.ok(!res.text.includes(MARK) && !res.text.includes('"sessions"') && !res.text.includes(guild.id), `${p} → ${res.status} must not be the copy`);
  }

  // Signing in again works; the site counts from 0.
  sids.owner = await signIn(OWNER);
  const overview = await call('GET', '/api/admin/overview', { who: 'owner' });
  assert.equal(overview.status, 200);
  assert.deepEqual([overview.body.downloads.total30, overview.body.orders.paid30, overview.body.accounts.users], [0, 0, 1]);
});

test('„Start od zera” on HammerShop\'s site does not exist – the shop has real customers (see also panel.test.js)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'admin.html'), 'utf8');
  // The button and the dialog are only between the launcher's markers.
  for (const id of ['start-open', 'start-dialog']) assert.match(html, new RegExp(`<!--launcher-->(?:(?!<!--/launcher-->)[\\s\\S])*id="${id}"`), id);
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

test('the dialog in a browser at 390 and 1366 px: what goes and what stays, PREMIERA unlocks it, then the sign-in with the copy\'s folder', { skip: !pw && 'Playwright is not installed' }, async () => {
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
      sids.owner = await signIn(OWNER);
      webStore.addMessage({ name: 'Ola', email: 'ola@example.com', topic: 'pomoc', text: 'Jeszcze jeden test' });
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(viewport.width < 500 && { isMobile: true, hasTouch: true }) });
      await context.addCookies([{ name: 'hs_sid', value: sids.owner.split('=')[1], url: base }]);
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.73.0.${viewport.width % 250}` });
      await context.route(/^https:\/\//, (route) => route.abort());
      const tab = await context.newPage();
      const problems = [];
      tab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await tab.clock.install();
      await tab.goto(`${base}/admin`, { waitUntil: 'networkidle' });
      await tab.locator('#start-open').click();
      const dialog = tab.locator('#start-dialog');
      assert.ok(await dialog.isVisible(), `${viewport.width}: the dialog is open`);
      assert.equal(await tab.evaluate(() => document.activeElement.id), 'start-title', 'it opens on its title – the lists are read first');
      const text = (await dialog.evaluate((d) => d.textContent)).replace(/\s+/g, ' ');
      for (const words of ['Usuniemy', 'zamówienia ze strony', 'wszyscy, także Ty, zalogują się od nowa', 'zamknięte tickety', 'Zostaje', 'wersje launchera i ich pliki', 'otwarte tickety', 'data/kopia-przed-startem-…']) assert.ok(text.includes(words), `${viewport.width}: „${words}”`);
      const fits = await tab.evaluate(() => {
        const d = document.getElementById('start-dialog');
        const r = d.getBoundingClientRect();
        return { page: document.documentElement.scrollWidth <= window.innerWidth, inside: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight, wide: d.scrollWidth <= d.clientWidth, nothingOut: [...d.querySelectorAll('*')].every((n) => n.getBoundingClientRect().right <= r.right + 0.5) };
      });
      assert.deepEqual(fits, { page: true, inside: true, wide: true, nothingOut: true }, `${viewport.width}: nothing wider than the screen`);
      const yes = tab.locator('#start-yes');
      assert.equal(await yes.isDisabled(), true);
      await tab.locator('#start-confirm').fill('ZERUJ');
      assert.equal(await yes.isDisabled(), true, 'the other reset\'s word does not unlock it');
      await tab.locator('#start-confirm').fill('premiera');
      assert.equal(await yes.isDisabled(), false);
      await quietly(() => yes.click().then(() => tab.locator('#gate-done').waitFor({ state: 'visible' })));
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await tab.locator('#panel').isVisible(), false);
      assert.equal(await tab.locator('#gate-title').innerText(), 'Gotowe – start od zera');
      const said = await tab.locator('#gate-done').innerText();
      const folder = /w folderze data\/(kopia-przed-startem-[0-9-]+) – żeby wszystko cofnąć, przy wyłączonym bocie skopiuj z niej oba pliki \(db\.json i web\.json\) z powrotem do folderu data\./.exec(said)?.[1];
      assert.ok(folder && fs.existsSync(path.join(db.dataDir, folder, 'web.json')), said);
      assert.match(said, /^Dane z testów są usunięte\. Kopia sprzed resetu jest na serwerze/);
      assert.ok(await tab.locator('#gate-login').isVisible(), 'the sign-in button');
      assert.equal(webStore.messageList().length, 0);
      // A minute later the unread counter asks again: its 401 keeps the sign-in – and the message with the folder.
      await Promise.all([tab.waitForResponse((r) => r.url().endsWith('/api/admin/messages/count') && r.status() === 401), tab.clock.fastForward(61_000)]);
      await tab.waitForTimeout(100);
      assert.equal(await tab.locator('#gate-done').innerText(), said);
      assert.equal(await tab.locator('#panel').isVisible(), false);
      assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      assert.deepEqual(problems, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
