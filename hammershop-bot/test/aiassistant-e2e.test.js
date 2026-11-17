'use strict';

// 🤖 The AI assistant end to end, ticket type by ticket type, on a free provider (a fake Groq – nothing leaves the
// computer): open → the author writes → a follow-up → a staff member writes (it goes quiet) → back on → asking for a
// person → a 429 on every model in the middle of a tool loop → the break ending → the next message. And what must not
// leak between tickets: breaks, escalations, timers, closed tickets, a restart.
process.env.HS_TEST_PROFILE = 'launcher';

const fakes = require('./helpers/aiFakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers/setup');
const { textOf, customIds } = require('./helpers/fakeInteraction');
const tickets = require('../src/tickets/tickets');
const typestate = require('../src/tickets/typestate');
const assistant = require('../src/features/aiassistant');
const { GREETINGS } = require('../src/features/ai/prompt');
const { INTRO } = require('../src/features/ai/format');

const { uid, role, sleep, groq, say, callTools, limited, open, write, aiOf, botMessages, botTexts, panelOf, countTexts, giveaway, command, LIMIT_TEXT } = fakes;
const CHAIN = { GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a, model-b' };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FORMS = {
  support: [['Temat', 'Gra się nie uruchamia'], ['Wersja launchera i Minecrafta', '2.6.0, 1.21.4'], ['Opisz dokładnie, co się dzieje', 'Czarny ekran']],
  bug: [['Co nie działa?', 'Edytor HUD'], ['Wersja launchera i Minecrafta', '2.6.0'], ['Jak wywołać błąd – krok po kroku', '1. otwieram edytor 2. zapisuję']],
  plus: [['Twój nick w Minecraft', 'Notch'], ['W czym możemy pomóc?', 'Kod nie działa']],
  reward: [['Który giveaway wygrałeś/aś?', 'Hammer+ 30 dni'], ['Twój nick w Minecraft', 'Steve']],
  apply: [['Ile masz lat?', '17'], ['W czym chcesz pomagać?', 'Support'], ['Doświadczenie', 'Moderowałem serwer'], ['Dlaczego mamy wybrać właśnie Ciebie?', 'Bo lubię pomagać']],
};
const TOOLS = { reward: ['moje_wygrane', 'odbierz_nagrode', 'wezwij_zespol'], other: ['wezwij_zespol', 'info_launchera'] };

for (const typeId of Object.keys(FORMS)) {
  test(`${typeId}: open → answers → staff takes over → back on → „człowiek” → a 429 on every model mid-tool-loop → the break ends`, async () => {
    const guild = await fakes.server(CHAIN);
    if (typeId === 'apply') typestate.set(guild.id, 'apply', false); // recruitment open
    const author = guild.addMember(uid(), [role('member')]);
    const staff = guild.addMember(uid(), [role('member'), role('support')]);
    const gw = typeId === 'reward' ? giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 }) : null;
    const tools = TOOLS[typeId === 'reward' ? 'reward' : 'other'];

    // 1. Open: the form is answered right away (one request with this type's tools); a reward ticket gets the fixed
    // greeting and the prize list instead – no request.
    let calls = groq(say('Odpowiedź na formularz.'));
    const { channel } = await open(typeId, FORMS[typeId], author);
    if (gw) {
      assert.equal(calls.length, 0, 'a reward ticket: the buttons, no request');
      assert.equal(countTexts(channel, new RegExp(`^${escape(`${INTRO}\n\n${GREETINGS.reward}`)}`)), 1, 'the fixed greeting, once');
      assert.deepEqual(customIds(panelOf(channel).body), [`ai:claim:${gw.id}`, 'ai:human']);
    } else {
      assert.equal(calls.length, 1, 'one request answers the form');
      assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), tools);
      assert.equal(countTexts(channel, new RegExp(`^${escape(`${INTRO}\n\nOdpowiedź na formularz.`)}`)), 1, 'introduction + the answer, once');
      assert.equal(panelOf(channel), undefined, 'no prize list here');
    }

    // 2. The first message → one request with this type's tools.
    calls = groq(say('Pierwsza odpowiedź.'));
    await write(channel, author, 'Cześć, potrzebuję pomocy.');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), tools);
    assert.match(calls[0].body.messages.at(-1).content, new RegExp(`ticket typu ${typeId}`));
    assert.equal(countTexts(channel, /^Pierwsza odpowiedź/), 1);

    // 3. A follow-up: the earlier answer is in the history.
    calls = groq(say('Druga odpowiedź.'));
    await write(channel, author, 'A coś jeszcze?');
    assert.ok(calls[0].body.messages.some((m) => m.role === 'assistant' && m.content === 'Pierwsza odpowiedź.'));

    // 4. A staff member writes → it goes quiet.
    await write(channel, staff, 'Cześć, tu zespół – już patrzę.');
    assert.equal(aiOf(channel).stopped, 'staff');
    calls = groq();
    await write(channel, author, 'Dzięki!');
    assert.equal(calls.length, 0);

    // 5. Back on (/asystent ticket stan:Włącz) → it answers what comes next, and knows what the team wrote.
    await command(staff, channel, 'ticket', { state: 'on' });
    assert.equal(countTexts(channel, /Asystent AI znów odpowiada w tym tickecie/), 1);
    calls = groq(say('Trzecia odpowiedź.'));
    await write(channel, author, 'Jeszcze jedno pytanie.');
    assert.equal(calls.length, 1);
    const history = calls[0].body.messages.map((m) => m.content ?? '').join('\n');
    assert.match(history, /\[Zespół – .+\]: Cześć, tu zespół – już patrzę\./);
    assert.equal(calls[0].body.messages.filter((m) => m.role === 'user').at(-1).content.split('\n\n').at(-1), 'Jeszcze jedno pytanie.');

    // 6. „człowiek” → the team, without the model, once.
    calls = groq();
    await write(channel, author, 'chcę rozmawiać z prawdziwym człowiekiem');
    assert.equal(calls.length, 0);
    assert.equal(countTexts(channel, /Wołam zespół/), 1);
    assert.equal(aiOf(channel).stopped, 'escalated');

    // 7. On again → a tool loop whose second request finds every model limited → one break notice that pings the team.
    await command(staff, channel, 'ticket', { state: 'on' });
    const tool = gw ? ['moje_wygrane', {}, 't1'] : ['info_launchera', {}, 't1'];
    calls = groq(callTools(tool), limited(1), limited(1));
    await write(channel, author, 'Sprawdzisz coś dla mnie?');
    assert.deepEqual(calls.map((c) => c.body.model), ['model-a', 'model-a', 'model-b']);
    assert.equal(assistant.paused()?.reason, 'limit');
    assert.equal(aiOf(channel).stopped, 'break');
    assert.equal(countTexts(channel, new RegExp(escape(LIMIT_TEXT))), 1);
    const notice = botMessages(channel).find((m) => textOf(m.body).includes(LIMIT_TEXT));
    assert.ok(notice.body.allowedMentions.roles.includes(role('support')));
    if (gw) assert.equal(countTexts(channel, /^## 🎁 Twoje wygrane/), 1, 'the prize list is not posted again');

    // 8. During the break: nothing is asked, nothing is posted twice.
    calls = groq();
    await write(channel, author, 'halo?');
    assert.equal(calls.length, 0);
    assert.equal(countTexts(channel, new RegExp(escape(LIMIT_TEXT))), 1);

    // 9. The break ends → the next message is answered again.
    await sleep(1100);
    calls = groq(say('Jestem z powrotem.'));
    await write(channel, author, 'jesteś?');
    assert.equal(calls.length, 1);
    assert.equal(aiOf(channel).stopped, null);
    assert.equal(countTexts(channel, /^Jestem z powrotem/), 1);

    // Nothing doubled, nothing leaked.
    assert.equal(countTexts(channel, new RegExp(`^${escape(INTRO)}`)), 1, 'introduced once');
    assert.equal(countTexts(channel, /Wołam zespół/), 1);
    assert.equal(botTexts(channel).some((t) => /<think>|undefined|NaN/.test(t)), false);
    if (typeId === 'apply') typestate.set(guild.id, 'apply', true);
  });
}

test('a break or an escalation in one ticket neither silences nor wakes up another', async () => {
  const guild = await fakes.server(CHAIN);
  const a = await open('support');
  groq(say('Kod wpisz w Hammer+ → „Mam kod”.'));
  const b = await open('plus', FORMS.plus);
  groq();
  await write(a.channel, a.author, 'człowiek');
  assert.equal(aiOf(a.channel).stopped, 'escalated');
  let calls = groq(say('Odpowiedź w drugim tickecie.'));
  await write(b.channel, b.author, 'jak aktywować kod?');
  assert.equal(calls.length, 1, 'the other ticket still gets answers');

  calls = groq(limited(1), limited(1));
  await write(b.channel, b.author, 'a ile kosztuje?');
  assert.equal(aiOf(b.channel).stopped, 'break');
  assert.equal(countTexts(a.channel, /Przerwa asystenta AI/), 0, 'the escalated ticket is not told about the break');
  await sleep(1100);
  calls = groq(say('Po przerwie.'));
  await write(a.channel, a.author, 'halo?');
  assert.equal(calls.length, 0, 'an escalated ticket stays with the team after the break');
  await write(b.channel, b.author, 'jesteś?');
  assert.equal(calls.length, 1, 'the ticket that only had a break answers again');
  assert.equal(guild.id, fakes.ctx.guild.id);
});

test('a ticket closed while a message waits for its answer is not answered, shows no typing and throws nothing', async (t) => {
  const guild = await fakes.server(CHAIN);
  const errors = t.mock.method(console, 'error', () => {});
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  let typed = 0;
  channel.sendTyping = async () => {
    typed += 1;
  };
  const calls = groq();
  assistant.timing.debounce = 200;
  try {
    await write(channel, author, 'pomocy', { wait: false });
    await tickets.closeTicket(channel, staff, 'test');
    await assistant.settle();
  } finally {
    assistant.timing.debounce = 5;
  }
  assert.equal(calls.length, 0);
  assert.equal(typed, 0, 'no "typing…" for a message that is never answered');
  assert.equal(errors.mock.calls.length, 0);

  // A deleted ticket: the same.
  const second = await open('support');
  assistant.timing.debounce = 200;
  try {
    await write(second.channel, second.author, 'halo', { wait: false });
    db.updateTicket(second.channel.id, { status: 'deleted', deletedAt: Date.now() });
    await assistant.settle();
  } finally {
    assistant.timing.debounce = 5;
  }
  assert.equal(calls.length, 0);
  assert.equal(errors.mock.calls.length, 0);
});

test('after a restart the assistant goes on from the database: no second greeting, the earlier answers in the history', async () => {
  await fakes.server(CHAIN);
  groq(say('Dzięki za zgłoszenie – dopisz link z Konsola → Wyślij logi.'));
  const { channel, author } = await open('bug', FORMS.bug);
  groq(say('Spróbuj aktualizacji.'));
  await write(channel, author, 'HUD się nie zapisuje');
  assistant._reset(); // the bot restarts: timers, breaks and model states are gone – the tickets are in data/db.json
  const calls = groq(say('Dzięki za info!'));
  await write(channel, author, 'zaktualizowałem i dalej to samo');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.messages.some((m) => m.role === 'assistant' && m.content === 'Spróbuj aktualizacji.'));
  assert.doesNotMatch(calls[0].body.messages.at(-1).content, /pierwsza odpowiedź/);
  assert.equal(countTexts(channel, new RegExp(`^${escape(INTRO)}`)), 1, 'no second introduction');
});

test('a ticket opened during a break gets the AI once the break is over (it was without AI only for the break)', async () => {
  const guild = await fakes.server(CHAIN);
  const first = await open('support');
  groq(limited(1), limited(1));
  await write(first.channel, first.author, 'hej');
  assert.ok(assistant.paused());
  const during = await open('support');
  assert.equal(aiOf(during.channel).mode, 'noai');
  assert.equal(countTexts(during.channel, new RegExp(`^${escape(INTRO)}`)), 0, 'no greeting while the AI has a break');
  await sleep(1100);
  const calls = groq(say('Cześć! Jestem asystentem AI – w czym pomóc?'));
  await write(during.channel, during.author, 'launcher nie chce się zainstalować');
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.messages.at(-1).content, /pierwsza odpowiedź/, 'its first answer here');
  const reply = botMessages(during.channel).at(-1);
  assert.match(reply.content, new RegExp(`^${escape(INTRO)}\n\n`), 'it introduces itself – there was no greeting');
  assert.deepEqual(customIds(reply.body), ['ai:human', 'ai:off'], 'the first AI message carries the buttons');
  assert.equal(guild.id, fakes.ctx.guild.id);
});

test('staff can switch the assistant off while it has a break – it does not come back by itself afterwards', async () => {
  const guild = await fakes.server(CHAIN);
  const staff = guild.addMember(uid(), [role('member'), role('support')]);
  const { channel, author } = await open('support');
  groq(limited(1), limited(1));
  await write(channel, author, 'pomocy');
  assert.equal(aiOf(channel).stopped, 'break');
  const off = await command(staff, channel, 'ticket', { state: 'off' });
  assert.match(textOf(off.state.replies[0] ?? off.state.edits[0]), /wyłączony/);
  assert.equal(aiOf(channel).stopped, 'manual');
  await sleep(1100);
  const calls = groq();
  await write(channel, author, 'halo?');
  assert.equal(calls.length, 0);
});
