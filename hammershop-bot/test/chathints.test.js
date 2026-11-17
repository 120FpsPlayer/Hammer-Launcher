'use strict';

// Chat hints on the Hammer Launcher server (config.chatHints, src/features/chathints.js): a typical question in #czat
// gets one short pointer to the right channel – no AI, word patterns. Realistic chat lines that must and must not get
// one, the hint itself, the cooldowns, and who never gets a hint.
process.env.HS_TEST_PROFILE = 'launcher';

const { db } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { createInteraction, textOf } = require('./helpers/fakeInteraction');
const { buildServer } = require('../src/builder/executor');
const { env } = require('../src/env');
const config = require('../src/lib/config');
const hooks = require('../src/lib/hooks');
const hints = require('../src/features/chathints');
const handle = require('../src/handlers/interactions');
const commands = require('../src/commands')();

const PLAYER = '300000000000000701';
const FRIEND = '300000000000000702';
const STAFF = '300000000000000703';
let guild;

test.before(async () => {
  guild = new FakeGuild({ ownerId: '1' });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  guild.addMember(PLAYER, [db.roleId(guild.id, 'member')]);
  guild.addMember(FRIEND, [db.roleId(guild.id, 'member')]);
  guild.addMember(STAFF, [db.roleId(guild.id, 'member'), db.roleId(guild.id, 'support')]);
});
test.beforeEach(() => hints._reset());

const channel = (key) => guild.channels.cache.get(db.channelId(guild.id, key));
const mention = (key) => `<#${db.channelId(guild.id, key)}>`;
const say = (key, author, content) => channel(key).userMessage(author, content);
/** A message → the hint the bot replied with (or null). */
async function ask(key, author, content, now = Date.now()) {
  const before = channel(key).messageList.length;
  const msg = say(key, author, content);
  const topic = await hints.onMessage(msg, { now });
  const added = channel(key).messageList.slice(before).filter((m) => m !== msg);
  assert.ok(added.length <= 1, 'one hint at most');
  return added.length ? { topic, msg, hint: added[0] } : (assert.equal(topic, null), null);
}
/** Just the topic of the hint (or null) – a failed check then prints a word, not a whole fake server. */
const hinted = async (...args) => (await ask(...args))?.topic ?? null;

// ~20 realistic questions (with the typos people make) and the topic each one should get.
const ASKS = [
  ['jak pobrac launcher?', 'download'],
  ['Skąd ściągnąć Hammer Launcher', 'download'],
  ['gdzie jest link do launchera', 'download'],
  ['dajcie link do lanchera pls', 'download'],
  ['ktoś wie gdzie pobrać tego launchera?', 'download'],
  ['launcher mi nie działa', 'crash'],
  ['minecraft crashuje mi przy wejściu na serwer', 'crash'],
  ['wywala mnie z gry co chwile, co robic?', 'crash'],
  ['czarny ekran po odpaleniu gry, pomocy', 'crash'],
  ['launcher sie nie odpala po aktualizacji?', 'crash'],
  ['gra mi nie dziala od wczoraj', 'crash'],
  ['MINECRAFT NIE DZIAŁAAAA POMOCYYY', 'crash'],
  ['jak kupić hammer+?', 'plus'],
  ['kod do hammer plus nie dziala, co zrobic', 'plus'],
  ['ile kosztuje hammer plus', 'plus'],
  ['jak wgrać mody do launchera?', 'mods'],
  ['jak zainstalowac shadery', 'mods'],
  ['mam mało fps w minecraft, jak zwiększyć?', 'fps'],
  ['fpsy mi spadają na launcherze co zrobić?', 'fps'],
  ['czy da sie grac na non premium?', 'account'],
  ['nie mogę zalogować się kontem microsoft w launcherze', 'account'],
  ['kiedy nowa wersja launchera?', 'plans'],
];
// ~20 lines from an ordinary chat that look a bit like those – none of them gets a hint.
const CHAT = [
  'nie dziala',
  'to nie działa xD',
  'nie działa mi discord na telefonie',
  'serwer nie działa, ktoś wie co jest?',
  'kolega gra na serwerze ale mu nie działa mikrofon',
  'pobrałem launcher wczoraj i jest spoko',
  'launcher jest mega, dzięki za update',
  'launcher nigdy mi nie crashuje, polecam',
  'wczoraj minecraft mi crashowal ale juz dziala',
  'mam hammer+ od tygodnia, peleryny są super',
  'kupiłem hammer plus i jest git',
  'jakie mody polecacie?',
  'na serwerze dzisiaj lagi straszne',
  'fps w cs2 mam mało',
  'jak pobrać cs2?',
  'ktoś gra dzisiaj?',
  'czy ktoś chce zagrać w minecraft?',
  'nie mogę się zalogować na serwer, /login nie działa',
  'szukam serwera non premium, ktoś zna?',
  'mój kod w pythonie nie działa',
  'czarny ekran w filmie był najlepszy',
  'wywaliło mi prąd w domu xd',
  'u mnie wszystko działa',
  'kiedy aktualizacja serwera?',
];

test('realistic chat: the usual questions get the right hint – with missing Polish letters and typos – the rest of the chat none', () => {
  assert.equal(config.chatHints.enabled, true);
  for (const [line, topic] of ASKS) assert.equal(hints.match(line)?.id ?? null, topic, line);
  for (const line of CHAT) assert.equal(hints.match(line)?.id ?? null, null, line);
  assert.equal(hints.simplify('Nie DZIAŁAAAA!!! <@123> https://x.pl/a?b ŁÓDŹ?'), ' nie dziala lodz ? ');
});

test('the hint: a reply to the question that pings nobody, with the right channels and a „To nie to” button', async () => {
  const before = { url: env.web.publicUrl, enabled: env.web.enabled };
  try {
    Object.assign(env.web, { publicUrl: 'https://hammerclient.com', enabled: true });
    const got = await ask('chat', PLAYER, 'jak pobrac launcher?');
    assert.equal(got.topic, 'download');
    const body = got.hint.body;
    assert.deepEqual(body.reply, { messageReference: got.msg.id, failIfNotExists: false });
    assert.deepEqual(body.allowedMentions, { parse: [], repliedUser: false }, 'not even the person who asked is pinged');
    assert.ok((body.flags & MessageFlags.IsComponentsV2) !== 0);
    const text = textOf(body);
    assert.match(text, new RegExp(`pobierzesz na ${mention('launcher')}`));
    assert.match(text, /Albo prosto ze strony: <https:\/\/hammerclient\.com>/);
    assert.match(text, /Automatyczna podpowiedź/);
    assert.match(JSON.stringify(body.components), new RegExp(`"custom_id":"hint:no:${PLAYER}"`));
    assert.match(text, /To nie to/);
    // Without the website's address the line with it is left out – no empty "<>".
    Object.assign(env.web, { publicUrl: '' });
    hints._reset();
    const bare = textOf((await ask('chat', PLAYER, 'jak pobrac launcher?')).hint.body);
    assert.doesNotMatch(bare, /Albo prosto ze strony|<>/);
  } finally {
    Object.assign(env.web, before);
  }
  // Each topic points where the brief says.
  const crash = textOf((await ask('chat', FRIEND, 'launcher mi crashuje przy starcie')).hint.body);
  assert.match(crash, new RegExp(`ticket \\*\\*Pomoc z launcherem\\*\\* na ${mention('tickets')}`));
  assert.match(crash, /Konsola → Wyślij logi/); // the button's real name in the launcher
  const plus = textOf((await ask('chat', FRIEND, 'jak kupic hammer+?')).hint.body);
  assert.match(plus, new RegExp(`na ${mention('plus')}`));
  assert.match(plus, /Hammer\+ i płatności\*\* na <#/);
  assert.match(textOf((await ask('chat', FRIEND, 'jak wgrac mody?')).hint.body), new RegExp(`zakładce \\*\\*Mody\\*\\*[\\s\\S]*${mention('faq')}`));
  assert.match(textOf((await ask('chat', FRIEND, 'mam tylko 20 fps w grze, jak zwiekszyc?')).hint.body), /\*\*Optymalizacja\*\*/);
  assert.match(textOf((await ask('chat', FRIEND, 'czy moge grac bez premium?')).hint.body), new RegExp(`kontem Microsoft[\\s\\S]*${mention('faq')}`));
  assert.match(textOf((await ask('chat', FRIEND, 'kiedy update?')).hint.body), new RegExp(`${mention('roadmap')}[\\s\\S]*${mention('updates')}`));
});

test('not spammy: once per person per topic per 30 minutes, once per channel per topic per 2 minutes', async () => {
  const t0 = Date.now();
  const min = (n) => t0 + n * 60_000;
  assert.ok(await hinted('chat', PLAYER, 'jak pobrac launcher?', min(0)));
  assert.equal(await hinted('chat', PLAYER, 'no ale gdzie pobrać ten launcher?', min(1)), null, 'the same person, the same topic');
  assert.equal(await hinted('chat', FRIEND, 'skad pobrac launcher?', min(1)), null, 'the same channel, the same topic, a minute later');
  assert.ok(await hinted('servers', FRIEND, 'skad pobrac launcher?', min(1)), 'another channel (#serwery) is fine');
  assert.ok(await hinted('chat', PLAYER, 'launcher mi nie dziala', min(1)), 'another topic is fine');
  assert.ok(await hinted('chat', '300000000000000799', 'link do launchera?', min(3)), 'somebody new, 2 minutes later');
  assert.equal(await hinted('chat', PLAYER, 'jak pobrac launcher?', min(10)), null, 'still within the person\'s 30 minutes');
  assert.ok(await hinted('chat', PLAYER, 'jak pobrac launcher?', min(31)), 'half an hour later – again');
});

test('never for the team, a bot, in a ticket, outside the hint channels, on a message the chat filter takes down, or when off', async () => {
  assert.equal(await hinted('chat', STAFF, 'jak pobrac launcher?'), null, 'the team knows');
  const fromBot = say('chat', PLAYER, 'jak pobrac launcher?');
  fromBot.author = { ...fromBot.author, bot: true };
  assert.equal(await hints.onMessage(fromBot), null, 'a bot'); // (onMessage answers with the topic id or null)
  assert.equal(await hinted('suggestions', PLAYER, 'jak pobrac launcher?'), null, '#propozycje is not a hint channel');
  assert.equal(await hinted('chat', PLAYER, `jak pobrac launcher? ${'bo nie wiem '.repeat(40)}`), null, 'a long message is a conversation');
  assert.equal(await hinted('chat', PLAYER, 'jak pobrac ten kurwa launcher?'), null, 'the chat filter deletes this one');
  // A ticket – even if its channel were on the list by mistake.
  const ticketChannel = await guild.channels.create({ name: 'pomoc-0001' });
  db.createTicket({ channelId: ticketChannel.id, guildId: guild.id, ownerId: PLAYER, typeId: 'support', number: 1, status: 'open' });
  const before = config.chatHints.channels;
  try {
    config.chatHints.channels = [...before, ticketChannel.id];
    const msg = ticketChannel.userMessage(PLAYER, 'jak pobrac launcher?');
    assert.equal(await hints.onMessage(msg), null, 'never in a ticket');
    config.chatHints.enabled = false;
    assert.equal(await hinted('chat', FRIEND, 'jak pobrac launcher?'), null, 'switched off');
  } finally {
    config.chatHints.channels = before;
    config.chatHints.enabled = true;
  }
  // Through the bot's own event: the hint comes, once.
  hints._reset();
  const n = channel('chat').messageList.length;
  await hooks.emit('messageCreate', say('chat', FRIEND, 'jak zainstalowac shadery?'));
  assert.equal(channel('chat').messageList.length, n + 2, 'the question and one hint');
  assert.match(textOf(channel('chat').messageList.at(-1).body), /zakładce \*\*Mody\*\*/);
});

test('„To nie to”: the person who asked, or the team, takes the hint away – nobody else can', async () => {
  const { hint } = await ask('chat', PLAYER, 'jak pobrac launcher?');
  const click = (who) => createInteraction({ guild, member: guild.members.cache.get(who), kind: 'button', customId: `hint:no:${PLAYER}`, message: hint, channel: channel('chat') });
  const stranger = click(FRIEND);
  await handle(stranger, commands);
  assert.match(textOf(stranger.state.replies.at(-1)), /tylko osoba, która pytała/);
  assert.ok(channel('chat').messageList.includes(hint), 'still there');
  const asker = click(PLAYER);
  await handle(asker, commands);
  assert.ok(!channel('chat').messageList.includes(hint), 'gone');
  assert.equal(asker.state.replies.length, 0, 'no extra message for the person who asked');
  // The team can take one away too.
  hints._reset();
  const other = (await ask('chat', PLAYER, 'jak pobrac launcher?')).hint;
  await handle(createInteraction({ guild, member: guild.members.cache.get(STAFF), kind: 'button', customId: `hint:no:${PLAYER}`, message: other, channel: channel('chat') }), commands);
  assert.ok(!channel('chat').messageList.includes(other));
});

test('a broken pattern in the config is skipped with a warning – the bot keeps running', () => {
  const before = config.chatHints.topics;
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  try {
    config.chatHints.topics = [{ id: 'zly', patterns: ['(niezamkniety'], text: 'x' }, ...before];
    assert.equal(hints.match('jak pobrac launcher?')?.id, 'download');
    assert.match(said.join('\n'), /topics\[zly\]\.patterns\[0\]: zły wzorzec/);
  } finally {
    config.chatHints.topics = before;
    console.warn = warn;
  }
});
