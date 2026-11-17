'use strict';

// The Hammer Launcher server (BOT_PROFILE=launcher): the „Gra teraz” stat channel (how many play right now
// with Hammer Client right now), #🗺️ plany with one card the bot edits in place from the admin panel's „Plany” tab –
// over real HTTP against a local copy of the website – and /zbuduj tylko:update adding both to an older server.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ChannelType, PermissionFlagsBits: P } = require('discord.js');
const { FakeGuild, validateMessage } = require('./helpers/fakeDiscord');
const { createInteraction, lastResponse, textOf } = require('./helpers/fakeInteraction');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { buildServer } = require('../src/builder/executor');
const { refreshContent } = require('../src/builder/refresh');
const { bareName } = require('../src/builder/style');
const { CATEGORIES } = require('../src/builder/layout');
const { env } = require('../src/env');
const stats = require('../src/features/stats');
const roadmap = require('../src/lib/roadmap');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const pages = require('../src/web/pages');
const { createWebServer } = require('../src/web/server');
const handle = require('../src/handlers/interactions');
const commands = require('../src/commands')();

const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const ADMIN = { id: '300000000000000501', username: 'devka', global_name: 'Devka', avatar: null };
const MEMBER = { id: '300000000000000502', username: 'gracz', global_name: 'Gracz', avatar: null };

let fakes;
let site;
let base;
let guild;
const sids = {};

test.before(async () => {
  fakes = await startFakes();
  guild = new FakeGuild({ ownerId: OWNER.id });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  guild.addMember(ADMIN.id, [db.roleId(guild.id, 'member'), db.roleId(guild.id, 'developer')]); // one of the bot's admins
  guild.addMember(MEMBER.id, [db.roleId(guild.id, 'member')]);
  website._setClient(guild.client);
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onLogin: website.onLogin, isMember: website.isMember, currency: () => 'eur',
    level: website.panelLevel, announce: website.announce, log: website.panelLog, roadmap: website.panelRoadmap,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  for (const [name, user] of Object.entries({ owner: OWNER, admin: ADMIN, member: MEMBER })) sids[name] = await signIn(user);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
});

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
/** → { status, body }. who: 'owner' | 'admin' | 'member' | null. */
async function call(method, pathname, { who = 'admin', body, origin = base } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      'x-forwarded-for': `10.88.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...(who && { cookie: sids[who] }),
      ...(origin && method !== 'GET' && { origin }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const plans = (method = 'GET', route = '', body, opts = {}) => call(method, `/api/admin/roadmap${route ? `/${route}` : ''}`, { body, ...opts });
const add = (fields, opts) => plans('POST', '', fields, opts);

const channel = (key, g = guild) => g.channels.cache.get(db.channelId(g.id, key));
const card = () => channel('roadmap').messageList.at(-1);
const cardText = () => textOf(card().body);
const logText = () => channel('serverLogs').messageList.map((m) => textOf(m.body)).join('\n');
/** Channels of a category from the top down, by layout key. */
function order(g, catKey) {
  const keyOf = Object.fromEntries(Object.entries(db.build(g.id).channels).map(([k, id]) => [id, k]));
  const parent = db.build(g.id).categories[catKey];
  return [...g.channels.cache.values()].filter((c) => c.parentId === parent).sort((a, b) => a.position - b.position).map((c) => keyOf[c.id] ?? c.name);
}
const uuid4 = () => crypto.randomUUID().replace(/-/g, '');
/** n accounts say "I am playing on a server with Hammer Client" – like the in-game client every 90 s. */
async function playing(n) {
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(`${base}/api/launcher/presence`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.99.0.${++ip % 250}` }, body: JSON.stringify({ me: uuid4(), uuids: [] }) });
    assert.equal(res.status, 200);
  }
}

test('layout: „Gra teraz” is the last stat channel, #🗺️ plany comes right after #aktualności, read-only for members', () => {
  assert.deepEqual(CATEGORIES.find((c) => c.key === 'catStats').channels.map((c) => c.key), ['statMembers', 'statVersion', 'statDownloads', 'statPlaying']);
  assert.deepEqual(order(guild, 'catStats'), ['statMembers', 'statVersion', 'statDownloads', 'statPlaying']);
  assert.deepEqual(order(guild, 'catLauncher'), ['launcher', 'updates', 'news', 'roadmap', 'plus', 'faq']);
  const stat = channel('statPlaying');
  assert.equal(stat.type, ChannelType.GuildVoice);
  assert.equal(bareName(stat.name), bareName(stats.STAT_NAMES.statPlaying(0)));
  assert.match(stat.name, /^🕹️/);
  const plany = channel('roadmap');
  assert.equal(plany.type, ChannelType.GuildText);
  assert.match(plany.name, /^🗺/);
  assert.match(plany.topic, /pracujemy/);
  const visitor = guild.addMember('300000000000000590', []);
  const member = guild.members.cache.get(MEMBER.id);
  const can = (m, key, perm) => channel(key).permissionsFor(m).has(perm);
  assert.ok(can(visitor, 'statPlaying', P.ViewChannel) && !can(visitor, 'statPlaying', P.Connect), 'visible, nobody can join');
  assert.ok(can(member, 'roadmap', P.ViewChannel) && !can(member, 'roadmap', P.SendMessages), '#plany is read-only for members');
  // /zbuduj posted the card: one live panel, remembered as the channel's /build post – with the friendly empty state.
  assert.equal(plany.messageList.length, 1);
  assert.deepEqual(db.panels(guild.id, 'roadmap').map((p) => p.messageId), [card().id]);
  assert.deepEqual(db.build(guild.id).posts.roadmap, [{ type: 'panel', id: card().id, kind: 'roadmap' }]);
  assert.match(cardText(), /# 🗺️ Plany/);
  assert.match(cardText(), /Plany są w drodze/);
  assert.match(cardText(), new RegExp(`<#${db.channelId(guild.id, 'suggestions')}>`));
  assert.doesNotMatch(cardText(), /Ostatnia zmiana/, 'no date while nothing is planned');
  // The channel guide in #informacje names it.
  assert.match(channel('information').messageList.map((m) => textOf(m.body)).join('\n'), new RegExp(`<#${plany.id}> – nad czym pracujemy`));
});

test('the shop server gets neither channel, no „Plany” tab and no chat hints', () => {
  const html = pages.forProfile(fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'admin.html'), 'utf8'));
  assert.match(html, /data-tab="plany"/, 'the launcher\'s panel has the tab');
  const out = spawnSync(process.execPath, ['-e', `
    require('./test/helpers/setup');
    const keys = require('./src/builder/layout').CATEGORIES.flatMap((c) => c.channels.map((ch) => ch.key));
    const html = require('./src/web/pages').forProfile(require('node:fs').readFileSync('web/public/admin.html', 'utf8'));
    console.log(JSON.stringify({ keys, tab: html.includes('data-tab="plany"'), section: html.includes('id="tab-plany"'), hints: require('./src/lib/config').chatHints.enabled }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, HS_TEST_PROFILE: 'shop' }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const shop = JSON.parse(out.stdout.trim().split('\n').at(-1));
  assert.ok(shop.keys.includes('statMembers') && shop.keys.includes('chat'), 'the shop layout');
  assert.ok(!shop.keys.includes('statPlaying') && !shop.keys.includes('roadmap'));
  assert.deepEqual([shop.tab, shop.section, shop.hints], [false, false, false]);
});

test('„Gra teraz” counts who the game reports as playing, renames only on a change and never over Discord\'s limit', async (t) => {
  const stat = channel('statPlaying');
  const shown = () => bareName(stat.name);
  const wanted = (n) => bareName(stats.STAT_NAMES.statPlaying(n));
  // Right after a restart the list of players is empty for a moment – the channel keeps its number meanwhile.
  stats._setStartedAt(Date.now());
  await playing(2);
  assert.equal(stats.playingNow(), 2);
  assert.equal(stats.statNames(guild).statPlaying, undefined);
  await stats.updateStatChannels(guild.client);
  assert.equal(stat.renames, 0);
  stats._setStartedAt(0); // the bot has been running for a while

  await playing(1);
  assert.equal(stats.statNames(guild).statPlaying, stats.STAT_NAMES.statPlaying(3));
  await stats.updateStatChannels(guild.client, { keys: ['statPlaying'] });
  assert.equal(shown(), wanted(3));
  assert.equal(stat.renames, 1);
  await stats.updateStatChannels(guild.client);
  assert.equal(stat.renames, 1, 'the same number – no rename');
  // The other stat channels keep their names (nothing changed there).
  assert.equal(channel('statDownloads').renames, 0);

  await playing(2);
  await stats.updateStatChannels(guild.client, { keys: ['statPlaying'] });
  assert.equal(shown(), wanted(5));
  assert.equal(stat.renames, 2);
  // A third change within 10 minutes: Discord would refuse it – the bot doesn't even try, and nothing throws.
  await playing(1);
  await stats.updateStatChannels(guild.client, { keys: ['statPlaying'] });
  assert.equal(shown(), wanted(5));
  assert.equal(stat.renames, 2);
  assert.equal(stat.renameTimes.length, 2, 'Discord never saw a third rename');

  // Ten minutes later: everybody who stopped saying "I am playing" is gone after 5 minutes, and the rename goes through.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(5 * 60_000 + 1000);
  assert.equal(stats.playingNow(), 0, 'the website forgets a player 5 minutes after the last "I am playing"');
  t.mock.timers.tick(5 * 60_000);
  await playing(4);
  await stats.updateStatChannels(guild.client, { keys: ['statPlaying'] });
  assert.equal(shown(), wanted(4));
  assert.equal(stat.renames, 3);
});

/** A launcher says a game runs (or ended) – PUT playing with its random session id. */
async function report(session, playing = true, from = `10.98.0.${++ip % 250}`) {
  return fetch(`${base}/api/launcher/playing`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify({ session, playing }) });
}

test('„Gra teraz” counts the games launchers report – singleplayer and vanilla too – and Hammer Client players from older launchers, never both twice', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 60 * 60_000 }); // everybody from the test above is gone
  assert.equal(stats.playingNow(), 0);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  assert.equal((await report(a)).status, 200);
  assert.equal((await report(b)).status, 200);
  assert.equal((await report(a)).status, 200, 'the same game again (every two minutes) – still one');
  assert.equal(stats.playingNow(), 2);
  // Two Hammer Client players on a server: they are launcher games too – the larger number counts, not the sum.
  await playing(2);
  assert.equal(stats.playingNow(), 2);
  await playing(1); // one more on an older launcher that doesn't report its game
  assert.equal(stats.playingNow(), 3);
  // A game ends: the launcher says so at once.
  t.mock.timers.tick(5 * 60_000 + 1000); // (the Hammer Client players stopped saying "I am playing")
  assert.equal(stats.playingNow(), 0, 'nobody said anything for 5 minutes');
  await report(a);
  await report(b);
  assert.equal(stats.playingNow(), 2);
  assert.equal((await report(b, false)).status, 200);
  assert.equal(stats.playingNow(), 1);
  // Only a random id goes in – nothing else is accepted, and one address cannot report a crowd.
  for (const bad of ['', 'krótkie', 'a'.repeat(65), 'zła spacja w środku ok', null, 12]) assert.equal((await report(bad)).status, 400, String(bad));
  const many = [];
  for (let i = 0; i < 9; i += 1) many.push((await report(crypto.randomUUID(), true, '10.97.0.1')).status);
  assert.deepEqual(many, [200, 200, 200, 200, 200, 200, 200, 200, 400]);
});

test('the „Plany” tab: only for the panel\'s people, every change from the panel itself, every field checked', async () => {
  assert.equal((await plans('GET', '', undefined, { who: null })).status, 401);
  assert.equal((await plans('GET', '', undefined, { who: 'member' })).status, 403);
  assert.equal((await add({ section: 'now', title: 'X' }, { who: 'member' })).status, 403);
  const r = await plans();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sections.map((s) => s.title), ['🔨 Teraz robimy', '🚀 W następnej wersji', '💡 Później', '✅ Ostatnio zrobione']);
  assert.deepEqual(r.body.limits, { title: 80, note: 140, items: 20 });
  assert.deepEqual(r.body.items, []);
  assert.equal(r.body.discord.channel.id, channel('roadmap').id);
  assert.equal(r.body.discord.url, card().url, 'the tab links to the card');
  assert.equal((await plans('GET', '', undefined, { who: 'owner' })).status, 200);

  // Changes must come from the panel itself (CSRF): no Origin, or somebody else's site → refused.
  assert.equal((await add({ section: 'now', title: 'Z innej strony' }, { origin: null })).status, 403);
  assert.equal((await add({ section: 'now', title: 'Z innej strony' }, { origin: 'https://zla-strona.example' })).status, 403);

  const edits = card().edits ?? 0;
  const refused = [
    [{ title: 'Bez sekcji' }, /Wybierz sekcję/],
    [{ section: 'kiedys', title: 'Zła sekcja' }, /Wybierz sekcję/],
    [{ section: 'now', title: '   ' }, /tytuł punktu/],
    [{ section: 'now', title: 'x'.repeat(81) }, /najwyżej 80 znaków \(teraz 81\)/],
    [{ section: 'now', title: 'Dobre', note: 'n'.repeat(141) }, /najwyżej 140 znaków \(teraz 141\)/],
    [null, /Wybierz sekcję/],
  ];
  for (const [body, message] of refused) {
    const res = await add(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, message);
  }
  assert.equal((await plans('PUT', 'plan_nieznany', { title: 'X' })).status, 404);
  assert.equal((await plans('DELETE', 'plan_nieznany')).status, 404);
  assert.deepEqual(webStore.roadmap().items, [], 'nothing was saved');
  assert.equal(card().edits ?? 0, edits, 'and the card was not touched');
});

test('every change is on Discord at once: the same card edited in place, no ping, sections in order, a log line for each', async () => {
  const id = card().id;
  const messages = channel('roadmap').messageList.length;
  const first = await add({ section: 'next', title: 'Jasny motyw', note: 'Ustawienia → Wygląd' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.discord, { ok: true, url: card().url, reposted: false });
  assert.equal(first.body.items.length, 1);
  assert.deepEqual(Object.keys(first.body.items[0]).sort(), ['at', 'by', 'id', 'note', 'section', 'title']);
  assert.equal(first.body.items[0].by, ADMIN.id);
  assert.equal(card().id, id, 'the same message');
  assert.equal(channel('roadmap').messageList.length, messages, 'nothing new posted');
  assert.match(cardText(), /### 🚀 W następnej wersji\n- \*\*Jasny motyw\*\* – Ustawienia → Wygląd/);
  assert.doesNotMatch(cardText(), /Teraz robimy|Później|Ostatnio zrobione|Plany są w drodze/, 'empty sections are left out');
  assert.match(cardText(), /Ostatnia zmiana: <t:\d+:D>/);
  assert.deepEqual(card().body.allowedMentions, { parse: [] }, 'an edit pings nobody');
  validateMessage(card().body, guild);

  await add({ section: 'done', title: 'Kopie światów' });
  await add({ section: 'now', title: 'Szybszy start gry' });
  await add({ section: 'later', title: 'Wersja na Linuxa', note: 'jeszcze nie wiemy kiedy' });
  await add({ section: 'done', title: 'Nowe peleryny' }); // „Ostatnio zrobione”: the newest on top
  const text = cardText();
  const at = (s) => text.indexOf(s);
  assert.ok(at('🔨 Teraz robimy') < at('🚀 W następnej wersji') && at('🚀 W następnej wersji') < at('💡 Później') && at('💡 Później') < at('✅ Ostatnio zrobione'), text);
  assert.match(text, /### ✅ Ostatnio zrobione\n- \*\*Nowe peleryny\*\*\n- \*\*Kopie światów\*\*/);
  assert.equal(card().id, id);
  assert.ok(card().edits >= 5);

  // Moving within a section, and the ends of a section.
  const b = (await add({ section: 'next', title: 'Tryb dla słabszych komputerów' })).body.items.find((i) => i.title.startsWith('Tryb'));
  assert.match(cardText(), /- \*\*Jasny motyw\*\* – Ustawienia → Wygląd\n- \*\*Tryb dla słabszych komputerów\*\*/);
  const up = await plans('POST', `${b.id}/move`, { dir: 'up' });
  assert.equal(up.status, 200);
  assert.match(cardText(), /- \*\*Tryb dla słabszych komputerów\*\*\n- \*\*Jasny motyw\*\*/);
  const top = await plans('POST', `${b.id}/move`, { dir: 'up' });
  assert.equal(top.status, 200);
  assert.equal(top.body.discord, null, 'already first – nothing to do');
  assert.equal((await plans('POST', `${b.id}/move`, { dir: 'w bok' })).status, 400);

  // Editing: a new title in place; a new section – „Ostatnio zrobione” puts it on top.
  const motyw = webStore.roadmap().items.find((i) => i.title === 'Jasny motyw');
  assert.equal((await plans('PUT', motyw.id, { title: 'Jasny i ciemny motyw' })).status, 200);
  assert.match(cardText(), /\*\*Jasny i ciemny motyw\*\* – Ustawienia → Wygląd/);
  const moved = await plans('PUT', motyw.id, { section: 'done' });
  assert.equal(moved.status, 200);
  assert.match(cardText(), /### ✅ Ostatnio zrobione\n- \*\*Jasny i ciemny motyw\*\* – Ustawienia → Wygląd\n- \*\*Nowe peleryny\*\*/);
  assert.equal((await plans('PUT', motyw.id, { title: '' })).status, 400);

  // What people type is shown as typed – no markdown tricks, no pings.
  await add({ section: 'later', title: '**Gruby** # nagłówek [link](https://x.example) @everyone', note: '> cytat' });
  // Bold and the masked link are escaped; a „#” or „>” in the middle of a line does nothing on Discord anyway.
  assert.ok(cardText().includes('- **\\*\\*Gruby\\*\\* # nagłówek \\[link](https://x.example) @everyone** – > cytat'), cardText());
  assert.deepEqual(card().body.allowedMentions, { parse: [] });
  const gruby = webStore.roadmap().items.find((i) => i.title.startsWith('**Gruby'));
  assert.equal((await plans('DELETE', gruby.id)).status, 200);
  assert.doesNotMatch(cardText(), /Gruby/);
  assert.equal(card().id, id, 'still the very same card');

  // Each change is in the log channel, with who did it.
  const log = logText();
  assert.match(log, new RegExp(`🗺️ Plany: dodano „Jasny motyw” \\(🚀 W następnej wersji\\) · <@${ADMIN.id}>`));
  assert.match(log, /🗺️ Plany: przesunięto „Tryb dla słabszych komputerów” w górę/);
  assert.match(log, /🗺️ Plany: zmieniono „Jasny i ciemny motyw” \(teraz: ✅ Ostatnio zrobione\)/);
  assert.match(log, /🗺️ Plany: usunięto „\\\*\\\*Gruby/);

  // Saved next to the other site data (data/web.json), with who changed it last.
  webStore.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(db.dataDir, 'web.json'), 'utf8')).roadmap;
  assert.deepEqual(saved.items.map((i) => [i.section, i.title]), webStore.roadmap().items.map((i) => [i.section, i.title]));
  assert.equal(saved.by, ADMIN.id);
  const shown = await plans();
  assert.equal(shown.body.items.length, webStore.roadmap().items.length);
  assert.deepEqual(shown.body.by, { id: ADMIN.id, name: 'Devka' });
});

test('a deleted card comes back with the next change – once, remembered for the next change and for /zbuduj tylko:panels', async () => {
  await card().delete();
  assert.equal(channel('roadmap').messageList.length, 0);
  const res = await add({ section: 'now', title: 'Poprawki po zgłoszeniach' });
  assert.equal(res.status, 200);
  assert.equal(res.body.discord.reposted, true);
  assert.equal(channel('roadmap').messageList.length, 1);
  const fresh = card();
  assert.equal(res.body.discord.url, fresh.url);
  assert.match(cardText(), /Poprawki po zgłoszeniach/);
  assert.deepEqual(db.panels(guild.id, 'roadmap').map((p) => p.messageId), [fresh.id], 'the old card is forgotten, the new one remembered');
  assert.deepEqual(db.build(guild.id).posts.roadmap, [{ type: 'panel', id: fresh.id, kind: 'roadmap' }]);
  assert.match(logText(), /dodano „Poprawki po zgłoszeniach” \(🔨 Teraz robimy\) – kartę wysłano od nowa/);

  const next = await plans('POST', `${webStore.roadmap().items.at(-1).id}/move`, { dir: 'up' });
  assert.equal(next.body.discord.reposted, false);
  assert.equal(channel('roadmap').messageList.length, 1);
  assert.equal(card().id, fresh.id);

  // /zbuduj tylko:panels edits this same card – no second one.
  const res2 = await refreshContent(guild);
  assert.deepEqual(res2.errors, []);
  assert.equal(channel('roadmap').messageList.length, 1);
  assert.equal(card().id, fresh.id);
  assert.match(cardText(), /Poprawki po zgłoszeniach/);

  // „Odśwież kartę na Discordzie”: edits it, or posts it again when it is gone.
  const again = await plans('POST', 'publish', {});
  assert.deepEqual(again.body, { url: fresh.url, reposted: false });
  await card().delete();
  // Two changes at the same moment, the card gone: still exactly one new card.
  const both = await Promise.all([add({ section: 'later', title: 'Pierwszy naraz' }), add({ section: 'later', title: 'Drugi naraz' })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.equal(channel('roadmap').messageList.length, 1, JSON.stringify(both.map((r) => r.body.discord)));
  assert.match(cardText(), /Pierwszy naraz[\s\S]*Drugi naraz|Drugi naraz[\s\S]*Pierwszy naraz/);
  assert.equal(both.filter((r) => r.body.discord.reposted).length, 1);
  assert.match(logText(), /karta na Discordzie (odświeżona|wysłana od nowa)/);
});

test('limits: the card always fits one Discord message', async () => {
  // Clean start: everything off the list.
  for (const item of webStore.roadmap().items) assert.equal((await plans('DELETE', item.id)).status, 200);
  // Long items: the list stops before the card would be too long – and the card is still a valid message.
  let refusedAt = null;
  for (let i = 0; i < roadmap.LIMITS.items && refusedAt === null; i += 1) {
    const res = await add({ section: roadmap.SECTION_IDS[i % 4], title: `${i} ${'Długi tytuł punktu '.repeat(5)}`.slice(0, 80), note: 'Notka o maksymalnej długości, żeby sprawdzić, czy karta na Discordzie się zmieści. '.repeat(3).slice(0, 140) });
    if (res.status === 400) refusedAt = i;
    else assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.ok(refusedAt !== null && refusedAt < roadmap.LIMITS.items, 'refused before the item limit');
  const res = await add({ section: 'now', title: 'Jeszcze jeden długi punkt'.padEnd(80, '!'), note: 'x'.repeat(140) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /za długa/);
  validateMessage(card().body, guild);
  assert.ok(roadmap.listText(webStore.roadmap().items).length <= roadmap.LIST_BUDGET);

  // Short items: at most LIMITS.items.
  for (const item of webStore.roadmap().items) await plans('DELETE', item.id);
  for (let i = 0; i < roadmap.LIMITS.items; i += 1) assert.equal((await add({ section: 'later', title: `Punkt ${i + 1}` })).status, 200);
  const over = await add({ section: 'later', title: 'Punkt 21' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /już 20 punktów/);
  validateMessage(card().body, guild);
  for (const item of webStore.roadmap().items) await plans('DELETE', item.id);
  assert.match(cardText(), /Plany są w drodze/, 'everything deleted – the empty state again');
});

test('without the channel the change is still saved – the tab and the answer say where it went wrong', async () => {
  const plany = channel('roadmap');
  const build = db.build(guild.id);
  const { roadmap: _gone, ...channels } = build.channels;
  db.setBuild(guild.id, { ...build, channels });
  try {
    const res = await add({ section: 'now', title: 'Zapisane mimo wszystko' });
    assert.equal(res.status, 200);
    assert.equal(res.body.discord.ok, false);
    assert.match(res.body.discord.error, /nie ma kanału #🗺️ plany.*\/zbuduj tylko:update/);
    assert.ok(webStore.roadmap().items.some((i) => i.title === 'Zapisane mimo wszystko'));
    assert.match(logText(), /dodano „Zapisane mimo wszystko” \(🔨 Teraz robimy\) – karta na Discordzie się nie zmieniła/);
    const shown = await plans();
    assert.deepEqual(shown.body.discord, { channel: null, url: null });
    const publish = await plans('POST', 'publish', {});
    assert.equal(publish.status, 409);
    assert.match(publish.body.error, /\/zbuduj tylko:update/);
  } finally {
    db.setBuild(guild.id, { ...db.build(guild.id), channels: { ...db.build(guild.id).channels, roadmap: plany.id } });
  }
  // Back: the next publish shows what was saved meanwhile.
  assert.equal((await plans('POST', 'publish', {})).status, 200);
  assert.match(cardText(), /Zapisane mimo wszystko/);
});

test('/zbuduj tylko:update on a server built before them: the stat channel and #🗺️ plany with its card appear in their places', async () => {
  const old = new FakeGuild({ ownerId: '1' });
  await buildServer({ guild: old, mode: 'add', invokerId: old.ownerId });
  // The server as it was: no „Gra teraz”, no #plany, no card.
  const b = db.build(old.id);
  for (const key of ['statPlaying', 'roadmap']) await channel(key, old).delete();
  for (const p of db.panels(old.id, 'roadmap')) db.removePanel(old.id, p.messageId);
  const { statPlaying: _s, roadmap: _r, ...channels } = b.channels;
  const { roadmap: _p, ...posts } = b.posts;
  db.setBuild(old.id, { ...b, channels, posts });
  assert.equal(db.channelId(old.id, 'roadmap'), null);

  const i = createInteraction({ guild: old, member: old.members.cache.get(old.ownerId) ?? old.addMember(old.ownerId), kind: 'command', commandName: 'build', options: { only: 'update' } });
  await handle(i, commands);
  const out = textOf(lastResponse(i));
  assert.match(out, /Serwer zaktualizowany/, out);
  assert.match(out, /🕹️/);
  assert.match(out, /🗺/);
  assert.deepEqual(order(old, 'catStats'), ['statMembers', 'statVersion', 'statDownloads', 'statPlaying']);
  assert.deepEqual(order(old, 'catLauncher'), ['launcher', 'updates', 'news', 'roadmap', 'plus', 'faq']);
  assert.equal(channel('statPlaying', old).type, ChannelType.GuildVoice);
  const plany = channel('roadmap', old);
  assert.equal(plany.messageList.length, 1, 'the card is there');
  assert.deepEqual(db.panels(old.id, 'roadmap').map((p) => p.messageId), [plany.messageList[0].id]);
  assert.deepEqual(db.build(old.id).posts.roadmap, [{ type: 'panel', id: plany.messageList[0].id, kind: 'roadmap' }]);
  assert.match(textOf(plany.messageList[0].body), /🗺️ Plany/);
  // Run again: nothing new.
  const j = createInteraction({ guild: old, member: old.members.cache.get(old.ownerId), kind: 'command', commandName: 'build', options: { only: 'update' } });
  await handle(j, commands);
  assert.equal(old.channels.cache.filter((c) => c.name === channel('roadmap', old).name).size, 1);
  assert.equal(old.channels.cache.filter((c) => c.name === channel('statPlaying', old).name).size, 1);
  assert.equal(channel('roadmap', old).messageList.length, 1);
});
