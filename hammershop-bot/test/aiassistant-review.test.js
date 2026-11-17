'use strict';

// 🤖 Regression tests for the AI assistant review (R1–R9 and the rest of its list): prize hand-offs that must always
// reach the team, rerolled winners, nothing posted after staff took over or the ticket closed, tiny 429 waits, staff
// snippets and claims, broken tool calls, false „człowiek” alarms, honest texts, and cleanup. Fake Groq only.
process.env.HS_TEST_PROFILE = 'launcher';

const fakes = require('./helpers/aiFakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers/setup');
const { textOf, lastResponse } = require('./helpers/fakeInteraction');
const config = require('../src/lib/config');
const tickets = require('../src/tickets/tickets');
const giveaways = require('../src/features/giveaways');
const hammerplus = require('../src/features/hammerplus');
const assistant = require('../src/features/aiassistant');
const prizes = require('../src/features/ai/prizes');
const openai = require('../src/features/ai/openai');
const { runTool } = require('../src/features/ai/tools');
const { asksForHuman } = require('../src/features/ai/human');

const { uid, role, sleep, groq, chat, say, callTools, limited, open, write, aiOf, botMessages, botTexts, countTexts, giveaway, command, click, ticketLog, toolMessages } = fakes;
const CHAIN = { GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a, model-b' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake Groq whose answers are async functions (body) → Response – for things that happen while a request is in flight. */
function fetchSeq(...steps) {
  const calls = [];
  openai.setFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const step = steps.shift();
    if (!step) throw new Error(`fake Groq: nothing more in the script (${body.model})`);
    return step(body);
  });
  return calls;
}
const answer = (content) => async (body) => json(chat({ content }, 'stop', body.model).body);
const fails500 = async () => json({ error: { message: 'boom' } }, 500);

// ───────────── 1. Prize hand-offs always reach the team ─────────────

test('R1: after a break, a non-Hammer+ prize claimed through the AI is posted, logged and pings the team', async () => {
  const guild = await fakes.server(CHAIN);
  const author = guild.addMember(uid(), [role('member')]);
  const gw = giveaway({ prize: 'Discord Nitro', winners: [author.id] });
  const { channel } = await open('reward', [], author);
  groq(limited(1), limited(1));
  await write(channel, author, 'hej');
  assert.equal(aiOf(channel).stopped, 'break');
  await sleep(1100);
  const logBefore = ticketLog().length;
  groq(callTools(['odbierz_nagrode', { giveawayId: gw.id }, 't1']));
  await write(channel, author, 'chcę odebrać Nitro');
  assert.equal(gw.claims[author.id].status, 'reported');
  const handOff = botMessages(channel).find((m) => /Wołam zespół/.test(textOf(m.body)) && /Discord Nitro/.test(textOf(m.body)));
  assert.ok(handOff, 'the hand-off is posted');
  assert.ok(handOff.body.allowedMentions.roles.includes(role('support')), 'and pings the team');
  assert.ok(ticketLog().slice(logBefore).some((t) => /nagroda do wydania ręcznie/.test(t) && /Discord Nitro/.test(t)), 'and is logged');
  assert.equal(aiOf(channel).stopped, 'escalated');
});

test('R2: two non-Hammer+ prizes claimed in one turn – each reaches the team on its own', async () => {
  const guild = await fakes.server(CHAIN);
  const author = guild.addMember(uid(), [role('member')]);
  const a = giveaway({ prize: 'Discord Nitro', winners: [author.id] });
  const b = giveaway({ prize: 'Paysafecard 50 zł', winners: [author.id] });
  const { channel } = await open('reward', [], author);
  const logBefore = ticketLog().length;
  groq(callTools(['odbierz_nagrode', { giveawayId: a.id }, 't1'], ['odbierz_nagrode', { giveawayId: b.id }, 't2']));
  await write(channel, author, 'odbierz obie nagrody');
  assert.deepEqual([a.claims[author.id].status, b.claims[author.id].status], ['reported', 'reported']);
  assert.equal(countTexts(channel, /Wołam zespół[\s\S]*Discord Nitro/), 1);
  assert.equal(countTexts(channel, /Wołam zespół[\s\S]*Paysafecard 50 zł/), 1);
  const log = ticketLog().slice(logBefore);
  assert.equal(log.filter((t) => /Paysafecard 50 zł/.test(t) && /nagroda do wydania ręcznie/.test(t)).length, 1);
  assert.equal(log.filter((t) => /Discord Nitro/.test(t) && /nagroda do wydania ręcznie/.test(t)).length, 1);
});

test('after a break the AI can call the team again at once; asking for a person during the break gets a visible answer', async () => {
  const guild = await fakes.server(CHAIN);
  const { channel, author } = await open('support');
  groq(limited(1), limited(1));
  await write(channel, author, 'hej');
  assert.equal(aiOf(channel).stopped, 'break');
  await write(channel, author, 'chcę rozmawiać z człowiekiem');
  assert.equal(countTexts(channel, /Zespół jest już powiadomiony – ktoś zaraz tu odpisze/), 1, 'no second ping, but an answer');

  await fakes.server(CHAIN); // a fresh start – the next ticket must see the AI, not this break
  groq(say('Napisz proszę, czego dotyczy płatność – sprawdzę, co da się zrobić.')); // the opening answer to the form
  const second = await open('plus', [['Twój nick w Minecraft', 'Notch'], ['W czym możemy pomóc?', 'Zwrot']], guild.addMember(uid(), [role('member')]));
  assert.equal(aiOf(second.channel).mode, 'ai');
  groq(limited(1), limited(1));
  await write(second.channel, second.author, 'chcę zwrot');
  assert.equal(aiOf(second.channel).stopped, 'break');
  await sleep(1100);
  groq(callTools(['wezwij_zespol', { powod: 'Prośba o zwrot pieniędzy za Hammer+.' }, 'w1']));
  await write(second.channel, second.author, 'jest ktoś?');
  assert.equal(countTexts(second.channel, /Wołam zespół[\s\S]*Prośba o zwrot/), 1, 'the AI’s call right after the break is posted');
});

// ───────────── 2. Rerolled winners ─────────────

test('R7: after /giveaway losuj-ponownie only the new winner can claim; claimed prizes stay; the next reroll skips both', async () => {
  const guild = await fakes.server(CHAIN);
  const channel = guild.channels.cache.get(db.channelId(guild.id, 'giveaways'));
  const { gw } = await giveaways.start(guild, guild.members.cache.get(guild.ownerId), { prize: 'Hammer+ 30 dni', durationMs: 120_000, winners: 1, channel, plusDays: 30, ping: false });
  const people = [uid(), uid(), uid()].map((id) => guild.addMember(id, [role('member')]));
  gw.entries.push(...people.map((m) => m.id));
  const [first] = await giveaways.end(guild, gw);
  const [second] = await giveaways.end(guild, gw, { reroll: true, count: 1 });
  assert.notEqual(first, second);
  assert.deepEqual(gw.rerolledOut, [first]);
  assert.equal((await prizes.claim({ guildId: guild.id, userId: first, giveawayId: gw.id, nick: 'OldWinner' })).result, 'rerolled');
  assert.equal(prizes.claimable(guild.id, first).length, 0, 'no button for the old winner');
  assert.equal(prizes.winsOverview(guild.id, first).wygrane.length, 0);
  assert.equal((await prizes.claim({ guildId: guild.id, userId: second, giveawayId: gw.id, nick: 'NewWinner' })).result, 'granted');
  const msg = await channel.messages.fetch(gw.messageId);
  assert.match(textOf(msg.body), new RegExp(`Zwycięzcy\\n<@${second}>$`), 'the card shows the current winner only');
  const [third] = await giveaways.end(guild, gw, { reroll: true, count: 1 });
  assert.ok(![first, second].includes(third), 'the next reroll draws somebody else');
  assert.ok(!gw.rerolledOut.includes(second), 'a winner who already claimed is not rerolled out');
});

test('rerolls from before this was written down: clear from the draw times, otherwise the team decides', async () => {
  const guild = await fakes.server(CHAIN);
  const [oldW, newW] = [uid(), uid()];
  const known = giveaway({ prize: 'Hammer+ 30 dni', winners: [oldW, newW] });
  known.winnersCount = 1; // one prize, two names: a reroll happened
  known.wonAt = { [oldW]: Date.now() - 3 * 86_400_000, [newW]: Date.now() - 60_000 };
  assert.equal(prizes.winnerState(known, oldW), 'rerolled');
  assert.equal(prizes.winnerState(known, newW), 'ok');
  const unknown = giveaway({ prize: 'Hammer+ 30 dni', winners: [oldW, newW] });
  unknown.winnersCount = 1;
  const r = await prizes.claim({ guildId: guild.id, userId: oldW, giveawayId: unknown.id, nick: 'Ktos' });
  assert.deepEqual([r.result, r.why], ['reported', 'rerolled-unclear']);
  assert.equal(hammerplus.codes(guild.id).filter((c) => c.nick === 'Ktos').length, 0);
});

// ───────────── 3. Nothing posted after staff took over or the ticket closed ─────────────

test('R3b: staff write while the request is in flight and it fails – no „Mam chwilowy problem…”', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  const before = botTexts(channel).length;
  fetchSeq(async () => {
    await write(channel, staff, 'Tu zespół.', { wait: false });
    return json({ error: { message: 'boom' } }, 500);
  }, fails500);
  await write(channel, author, 'pytanie');
  assert.equal(aiOf(channel).stopped, 'staff');
  assert.deepEqual(botTexts(channel).slice(before), [], 'nothing from the bot after staff wrote');
});

test('R3: a second failure after staff took over neither pings the roles nor overwrites stopped:"staff"', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  fetchSeq(fails500, fails500);
  await write(channel, author, 'pierwsze pytanie');
  assert.equal(aiOf(channel).failures, 1);
  const before = botTexts(channel).length;
  fetchSeq(async () => {
    await write(channel, staff, 'Tu zespół, już patrzę.', { wait: false });
    return json({ error: { message: 'boom' } }, 500);
  }, fails500);
  await write(channel, author, 'drugie pytanie');
  assert.equal(aiOf(channel).stopped, 'staff');
  assert.deepEqual(botTexts(channel).slice(before), []);
});

test('refusal, step limit and a mid-loop wezwij_zespol after staff took over stay silent', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const a = await open('support');
  fetchSeq(async (body) => {
    await write(a.channel, staff, 'Zajmuję się tym.', { wait: false });
    return json(chat({ content: '' }, 'content_filter', body.model).body);
  });
  await write(a.channel, a.author, 'pytanie');
  assert.equal(countTexts(a.channel, /Wołam zespół/), 0);
  assert.equal(aiOf(a.channel).stopped, 'staff');

  const b = await open('support');
  fetchSeq(async (body) => {
    await write(b.channel, staff, 'Już jestem.', { wait: false });
    return json(callTools(['wezwij_zespol', { powod: 'Nie umiem pomóc.' }, 'w'])(body).body);
  });
  await write(b.channel, b.author, 'pomóż');
  assert.equal(countTexts(b.channel, /Wołam zespół/), 0, 'no ping – staff are already here');
  assert.equal(aiOf(b.channel).stopped, 'staff', 'not overwritten with escalated');
});

test('R8: the ticket is closed while the request is in flight – nothing is posted into it, nothing throws', async (t) => {
  const guild = await fakes.server(CHAIN);
  const errors = t.mock.method(console, 'error', () => {});
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  fetchSeq(async () => {
    await tickets.closeTicket(channel, staff, 'załatwione');
    return json({ error: { message: 'boom' } }, 500);
  }, fails500);
  await write(channel, author, 'pytanie');
  const afterClose = botTexts(channel).slice(botTexts(channel).findIndex((x) => /Ticket zamknięty/.test(x)) + 1);
  assert.deepEqual(afterClose, []);
  assert.equal(errors.mock.calls.length, 0);

  const second = await open('support');
  fetchSeq(async (body) => {
    await tickets.closeTicket(second.channel, staff, 'załatwione');
    return json(chat({ content: 'Odpowiedź po zamknięciu' }, 'stop', body.model).body);
  });
  await write(second.channel, second.author, 'pytanie');
  assert.equal(countTexts(second.channel, /Odpowiedź po zamknięciu/), 0);
});

// ───────────── 4. Tiny waits ─────────────

test('R4: a 429 with retry-after 0 (or a reset of a few ms) is a short break – never „no model works” until a restart', async () => {
  await fakes.server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a' });
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', [], author);
  groq(limited(0));
  await write(channel, author, 'hej');
  assert.equal(assistant.paused().reason, 'limit');
  assert.notEqual(assistant.paused().until, Infinity);
  assert.ok(assistant.paused().until - Date.now() >= 500, 'at least about a second');

  await fakes.server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a, model-b' });
  const other = await open('support');
  groq(
    { status: 429, headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6ms' }, body: { error: { message: 'limit' } } },
    { status: 429, headers: { 'retry-after': '0.2' }, body: { error: { message: 'limit' } } },
  );
  await write(other.channel, other.author, 'hej');
  assert.equal(assistant.paused().reason, 'limit');
});

// ───────────── 5. Staff snippets and claims ─────────────

test('R5: after the assistant is switched back on, a staff /reply snippet or a claim silences it again', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  groq(say('Odp 1'));
  await write(channel, author, 'pytanie 1');
  await write(channel, staff, 'Tu zespół.');
  await command(staff, channel, 'ticket', { state: 'on' });
  await tickets.sendSnippet(channel, config.snippets[0], staff);
  let calls = groq(say('Odp AI po snippecie'));
  await write(channel, author, 'dzięki, a jeszcze...');
  assert.equal(calls.length, 0);
  assert.equal(aiOf(channel).stopped, 'staff');

  await command(staff, channel, 'ticket', { state: 'on' });
  await tickets.claimTicket(channel, staff); // right away – the same millisecond still counts
  calls = groq(say('Odp AI po przejęciu'));
  await write(channel, author, 'halo');
  assert.equal(calls.length, 0);
  assert.equal(countTexts(channel, /Odp AI po/), 0);
});

test('a snippet sent while the request is in flight stops that reply', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  fetchSeq(async (body) => {
    await tickets.sendSnippet(channel, config.snippets[0], staff);
    return json(chat({ content: 'Spóźniona odpowiedź AI' }, 'stop', body.model).body);
  });
  await write(channel, author, 'pytanie');
  assert.equal(countTexts(channel, /Spóźniona odpowiedź AI/), 0);
  assert.equal(aiOf(channel).stopped, 'staff');
});

// ───────────── 6. Broken tool calls and the per-type prompt ─────────────

test('Groq tool_use_failed: retried once with a correction, then the next model – not a hard failure', async () => {
  await fakes.server(CHAIN);
  const { channel, author } = await open('support');
  const failed = { status: 400, body: { error: { message: 'Failed to call a function.', type: 'invalid_request_error', code: 'tool_use_failed' } } };
  const calls = groq(failed, failed, say('Odpowiedź z drugiego modelu.'));
  await write(channel, author, 'jaka jest wersja?');
  assert.deepEqual(calls.map((c) => c.body.model), ['model-a', 'model-a', 'model-b']);
  assert.match(calls[1].body.messages.at(-1).content, /Poprzednie wywołanie narzędzia było błędne/);
  assert.equal(calls[2].body.messages.some((m) => /Poprzednie wywołanie/.test(m.content ?? '')), false, 'the next model gets the request as it was');
  assert.ok(botTexts(channel).some((x) => /Odpowiedź z drugiego modelu/.test(x)));
  assert.equal(assistant.paused(), null);
});

test('malformed tool_calls in an answer are a bad answer: one corrected retry, no crash', async (t) => {
  await fakes.server(CHAIN);
  const errors = t.mock.method(console, 'error', () => {});
  const { channel, author } = await open('support');
  const calls = groq((body) => chat({ content: null, tool_calls: { oops: true } }, 'tool_calls', body.model), (body) => chat({ content: null, tool_calls: [null] }, 'tool_calls', body.model), say('Działa.'));
  await write(channel, author, 'hej');
  assert.deepEqual(calls.map((c) => c.body.model), ['model-a', 'model-a', 'model-b']);
  assert.ok(botTexts(channel).some((x) => /^Działa\./.test(x)));
  assert.equal(errors.mock.calls.length, 0);
});

// ───────────── 7. „człowiek” false alarms ─────────────

test('R9: ordinary messages are not a request for a person; the real requests still are', () => {
  for (const no of [
    'Człowieku, launcher mi nie działa',
    'Mój kolega jest adminem na serwerze i mówi że potrzebuję logu, gdzie go znajdę?',
    'Kiedy zespół doda wersję 1.21.5? gdzie ją znajdę',
    'Proszę o pomoc, owner serwera kazał mi zainstalować Hammer Client',
    'Jestem człowiekiem, który nie umie zainstalować javy',
    'dzięki zespole, działa!',
    'jak zostać adminem?',
    'jesteś botem czy człowiekiem?',
  ]) {
    assert.equal(asksForHuman(no), false, no);
  }
  for (const yes of [
    'człowiek',
    'Chcę rozmawiać z prawdziwym człowiekiem',
    'potrzebuję pomocy od kogoś prawdziwego',
    'chcę pogadać z kimś normalnym, nie z botem',
    'dajcie mi człowieka',
    'zawołaj admina',
    'potrzebuję pomocy od admina',
    'czy jest tu jakiś admin?',
    'gdzie jest administracja?',
    'czy admin mi pomoże?',
    'ktoś z zespołu?',
    'ADMIN!!',
  ]) {
    assert.equal(asksForHuman(yes), true, yes);
  }
});

// ───────────── 8. Honest texts ─────────────

test('closed DMs: the ticket says to keep the code from the ticket (no „wysłaliśmy w DM”); a claim elsewhere points there', async () => {
  const guild = await fakes.server({});
  const author = guild.addMember(uid(), [role('member')]);
  guild.closedDms.add(author.id);
  const gw = giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 });
  const { channel } = await open('reward', [], author);
  const submit = await click(author, channel, `ai:nick:${gw.id}`, { kind: 'modal', fields: { nick: 'Steve' } });
  const code = botTexts(channel).find((x) => /Twoja nagroda: Hammer\+/.test(x));
  assert.match(code, /zachowaj go z tego ticketu/);
  assert.doesNotMatch(code, /wysłaliśmy go też w wiadomości prywatnej/);
  assert.match(textOf(lastResponse(submit)), /wiadomość prywatna nie doszła/);
  assert.equal(gw.claims[author.id].dm, false);

  const otherChannel = await tickets.openTicket(author, config.getType('reward'), [], {}, { force: true }); // a second ticket right away
  const again = await click(author, otherChannel, `ai:claim:${gw.id}`);
  assert.match(textOf(lastResponse(again)), new RegExp(`w tickecie <#${channel.id}>`));
  assert.doesNotMatch(textOf(lastResponse(again)), /wiadomościach prywatnych/);
});

test('the AI path: the tool result says the DM did not arrive; the team notice no longer contradicts itself', async () => {
  const guild = await fakes.server(CHAIN);
  const author = guild.addMember(uid(), [role('member')]);
  guild.closedDms.add(author.id);
  const gw = giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 });
  const { channel } = await open('reward', [], author);
  const calls = groq(callTools(['odbierz_nagrode', { giveawayId: gw.id, minecraftNick: 'Steve' }, 't']), say('Gotowe.'));
  await write(channel, author, 'odbierz');
  assert.match(toolMessages(calls[1])[0].content, /wiadomość prywatna nie doszła/);
  groq();
  await write(channel, author, 'człowiek');
  const notice = botTexts(channel).find((x) => /Wołam zespół/.test(x));
  assert.match(notice, /Zawołałem zespół – ktoś odpisze tutaj, gdy tylko będzie dostępny/);
  assert.doesNotMatch(notice, /Zaraz ktoś|kilku godzin/);
});

test('/asystent status does not suggest /asystent ticket during a break', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  groq(limited(5), limited(5));
  await write(channel, author, 'hej');
  const status = await command(staff, channel, 'status');
  const text = textOf(lastResponse(status));
  assert.match(text, /Ten ticket ⏸️ ma przerwę/);
  assert.doesNotMatch(text, /\/asystent ticket/);
});

// ───────────── 9. answeredUpTo, cleanup, privacy ─────────────

test('a reply that could not be posted leaves the messages unanswered – the next run answers them', async () => {
  await fakes.server(CHAIN);
  const { channel, author } = await open('support');
  const realSend = channel.send.bind(channel);
  let failOnce = true;
  channel.send = async (payload) => {
    if (failOnce && typeof payload?.content === 'string' && payload.content.startsWith('Pierwsza')) {
      failOnce = false;
      throw new Error('Discord: Missing Access');
    }
    return realSend(payload);
  };
  groq(say('Pierwsza odpowiedź'));
  await write(channel, author, 'pytanie A');
  assert.equal(aiOf(channel).answeredUpTo, null);
  const calls = groq(say('Druga odpowiedź'));
  await write(channel, author, 'pytanie B');
  const last = calls[0].body.messages.filter((m) => m.role === 'user').at(-1).content;
  assert.match(last, /pytanie A[\s\S]*pytanie B/, 'both questions are still to be answered');
});

test('info_launchera: another account shows only whether Hammer+ runs; the author’s own account shows until when', async () => {
  const guild = await fakes.server(CHAIN);
  const author = guild.addMember(uid(), [role('member')]);
  const crypto = require('node:crypto');
  const mcOf = (name) => crypto.createHash('md5').update(name).digest('hex');
  hammerplus.grantKnown(guild.id, { mc: mcOf('ObcyGracz'), nick: 'ObcyGracz', days: 30, discordId: uid() });
  hammerplus.grantKnown(guild.id, { mc: mcOf('MojNick'), nick: 'MojNick', days: 30, discordId: author.id });
  const ctx = { guild, ownerId: author.id, channel: { id: 'x' } };
  const other = JSON.parse((await runTool('info_launchera', { nick: 'ObcyGracz' }, ctx)).content).hammer_plus_nicku;
  assert.deepEqual(other, { nick: 'ObcyGracz', status: 'Hammer+ aktywny' });
  const own = JSON.parse((await runTool('info_launchera', { nick: 'MojNick' }, ctx)).content).hammer_plus_nicku;
  assert.match(own.status, /^aktywny do /);
});

test('closing a ticket drops its waiting answer and its timers (ticketClosed)', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  const calls = groq();
  assistant.timing.debounce = 300;
  try {
    await write(channel, author, 'pomocy', { wait: false });
    assert.equal(assistant._waiting(), 1);
    await tickets.closeTicket(channel, staff, 'test');
    await sleep(0);
    assert.equal(assistant._waiting(), 0, 'the waiting answer is dropped at once, not when its timer fires');
    await sleep(350);
    await assistant.settle();
  } finally {
    assistant.timing.debounce = 5;
  }
  assert.equal(calls.length, 0);
});
