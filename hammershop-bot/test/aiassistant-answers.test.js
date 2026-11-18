'use strict';

// 🤖 What the AI assistant actually sends: whole answers (never cut in the middle), the opening answer to the ticket
// form, the owner's message format, and the team's knowledge file. The AI is a fake – a scripted fake fetch, a fake
// client, or a local HTTP server on 127.0.0.1 that behaves like a reasoning model – nothing leaves the computer.
process.env.HS_TEST_PROFILE = 'launcher';
// The real fetch, kept before the test setup replaces it – only ever pointed at the local fake server below.
const realFetch = globalThis.fetch;

const fakes = require('./helpers/aiFakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./helpers/setup');
const { textOf, lastResponse, customIds } = require('./helpers/fakeInteraction');
const assistant = require('../src/features/aiassistant');
const openai = require('../src/features/ai/openai');
const knowledge = require('../src/features/ai/knowledge');
const format = require('../src/features/ai/format');
const { GREETINGS } = require('../src/features/ai/prompt');

const { uid, role, sleep, groq, say, chat, limited, open, write, aiOf, botMessages, botTexts, countTexts, panelOf, ticketLog, command, KNOWLEDGE_FILE, LIMIT_TEXT } = fakes;
const CHAIN = { GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a, model-b' };

const SUPPORT_FORM = [['Temat', 'Gra się nie uruchamia'], ['Wersja launchera i Minecrafta', '2.11.2, 1.21.4 Fabric'], ['Opisz dokładnie, co się dzieje', 'Po kliknięciu Graj okno gry się zamyka po kilku sekundach.']];

/** A realistic Polish answer (~1000 characters, the length the old prompt allowed): full sentences, a numbered list. */
const LONG_ANSWER = [
  'To, że okno gry zamyka się po kilku sekundach, najczęściej oznacza konflikt modów albo za mało pamięci dla Javy. Zrób po kolei:',
  '1. Otwórz zakładkę Optymalizacja i kliknij Zoptymalizuj wszystko – launcher sam dobierze pamięć i ustawienia Javy.',
  '2. Jeśli dodawałeś ostatnio mody, wyłącz je w zakładce Mody i spróbuj uruchomić grę jeszcze raz.',
  '3. Sprawdź, czy masz najnowszą wersję launchera: Ustawienia → Aktualizacje launchera → Sprawdź teraz.',
  '4. Gdy nadal się wyłącza, utwórz nową, czystą instancję z tą samą wersją Minecrafta i sprawdź, czy ona startuje.',
  '5. Przy laptopie podłącz zasilanie – na baterii karta graficzna bywa wyłączona i gra potrafi się zamknąć bez komunikatu.',
  'Jeżeli żaden krok nie pomoże, otwórz Konsola → Wyślij logi i wklej tutaj link, który dostaniesz. Zespół przejrzy log i powie dokładnie, który mod albo ustawienie psuje start gry.',
].join('\n');

/**
 * A local HTTP server that answers like a reasoning model on a free plan: the hidden reasoning is paid out of the same
 * max_tokens as the answer, and Polish text costs about one token per 2.8 characters. What doesn't fit is cut off
 * with finish_reason "length" – exactly what such a provider does.
 */
async function reasoningServer({ reasoningTokens = 280, answer = LONG_ANSWER, charsPerToken = 2.8 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const room = Math.max(0, (body.max_tokens ?? 4096) - reasoningTokens);
      const text = typeof answer === 'function' ? answer(body, requests.length) : answer;
      const fits = text.length <= room * charsPerToken;
      const content = fits ? text : text.slice(0, Math.floor(room * charsPerToken));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-local',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: fits ? 'stop' : 'length' }],
          usage: { prompt_tokens: 1800, completion_tokens: reasoningTokens + Math.ceil(content.length / charsPerToken) },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  // The adapter's real fetch – allowed to reach this server only.
  openai.setFetch((url, init) => {
    assert.ok(String(url).startsWith(base), `only the local fake server: ${url}`);
    return realFetch(url, init);
  });
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Free provider through the local server: an OpenAI-compatible API with a gpt-oss model (reasoning_effort is sent). */
async function localProvider(options) {
  const guild = await fakes.server({});
  const local = await reasoningServer(options);
  fakes.useEnv({ AI_PROVIDER: 'openai', AI_BASE_URL: local.base, AI_API_KEY: 'local-test-key', AI_MODEL: 'openai/gpt-oss-120b' });
  return { guild, local };
}

/** The text of a posted assistant message without its signature line and the introduction. */
const bodyOf = (content) =>
  String(content)
    .split('\n')
    .filter((line) => !/^-# .*Asystent AI/.test(line) && line !== 'Cześć! Jestem asystentem AI Hammera.')
    .join('\n')
    .trim();
const assistantMessages = (channel) => botMessages(channel).filter((m) => (aiOf(channel).msgIds ?? []).includes(m.id));

// ───────────── 1. Answers that get cut off ─────────────

test('cut-off cause 1 (reproduced through the real adapter and a local server): the reasoning model spends the output budget – the answer must arrive whole', async (t) => {
  const { local } = await localProvider();
  t.after(local.close);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', SUPPORT_FORM, author);
  await write(channel, author, 'co mam zrobić?');
  const req = local.requests.at(-1);
  assert.equal(req.reasoning_effort, 'low');
  // The proof: the same model asked with the old budget (500 tokens) through the real adapter – cut mid-sentence.
  const old = await openai.createClient({ provider: 'openai', baseURL: local.base, apiKey: 'k', models: ['openai/gpt-oss-120b'] }).beta.messages.create({ model: 'openai/gpt-oss-120b', max_tokens: 500, messages: [{ role: 'user', content: 'co mam zrobić?' }] });
  assert.equal(old.stop_reason, 'max_tokens');
  assert.doesNotMatch(old.content[0].text, /[.!?]$/, `the old budget ends mid-sentence: …${old.content[0].text.slice(-40)}`);
  // Now: the budget leaves room for the reasoning and the whole answer.
  assert.ok(req.max_tokens >= 1200, `max_tokens ${req.max_tokens} leaves room for the reasoning`);
  const posted = assistantMessages(channel).map((m) => bodyOf(m.content)).join('\n');
  assert.ok(posted.includes(LONG_ANSWER), 'the whole answer is posted');
});

test('cut-off cause 2: an answer cut by max_tokens is never posted with half a sentence – it ends on the last complete sentence', async (t) => {
  // A very long reasoning: even the bigger budget runs out in the middle of the answer.
  const { local } = await localProvider({ reasoningTokens: 1300 });
  t.after(local.close);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', SUPPORT_FORM, author);
  await write(channel, author, 'co mam zrobić?');
  const posted = assistantMessages(channel).map((m) => bodyOf(m.content)).filter(Boolean);
  assert.ok(posted.length >= 1, 'something is posted');
  for (const text of posted) assert.match(text, /[.!?…]$/, `ends with a complete sentence: …${text.slice(-60)}`);
  assert.ok(LONG_ANSWER.startsWith(posted.at(-1)), 'only whole sentences of the answer, nothing invented');
});

test('cut-off cause 3: an answer longer than one Discord message is split into two clean messages – nothing replaced by „…”', async () => {
  await fakes.server({});
  const long = [LONG_ANSWER, LONG_ANSWER.replace('To, że', 'Jeszcze raz: to, że'), LONG_ANSWER.replace('To, że', 'I po raz trzeci: to, że')].join('\n\n');
  assert.ok(long.length > 2000);
  const client = {
    beta: { messages: { create: async () => ({ model: 'claude-opus-5-5', content: [{ type: 'text', text: long }], stop_reason: 'end_turn', usage: {} }) } },
  };
  assistant.setClient(client);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', SUPPORT_FORM, author);
  const parts = assistantMessages(channel);
  assert.ok(parts.length >= 2, `${parts.length} message(s)`);
  for (const m of parts) assert.ok(m.content.length <= 2000, `${m.content.length} characters`);
  const joined = parts.map((m) => bodyOf(m.content)).join('\n\n');
  assert.doesNotMatch(joined, /…/);
  assert.equal(joined.replace(/\s+/g, ' '), long.replace(/\s+/g, ' '), 'every word arrives, in order');
});

test('cut-off cause 4: a reasoning model cut inside <think> – its unfinished reasoning never reaches the ticket', async () => {
  await fakes.server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'qwen/qwen3-32b' });
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', [], author);
  groq((body) => fakes.chat({ content: '<think>\nUżytkownik pyta o FPS. Najpierw rozważę, czy chodzi o laptopa, potem' }, 'length', body.model), say('Kliknij Optymalizacja → Zoptymalizuj wszystko.'));
  await write(channel, author, 'mam mało fps');
  const texts = botMessages(channel).map((m) => m.content ?? '');
  assert.equal(texts.some((x) => /think|Najpierw rozważę/.test(x)), false, 'no reasoning in the ticket');
});

test('cut-off: nothing complete in a cut answer → asked once more for a shorter one (one extra request), never a half sentence', async () => {
  await fakes.server(CHAIN);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const { channel } = await open('support', [], author);
  const calls = groq((body) => chat({ content: 'Najpierw otwórz zakładkę Optymal' }, 'length', body.model), say('Kliknij **Optymalizacja → Zoptymalizuj wszystko**.'));
  await write(channel, author, 'mam mało fps');
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages.at(-1).content, /nie zmieściła się w limicie[\s\S]*krócej/);
  assert.equal(countTexts(channel, /Optymal$|Optymal\n/), 0, 'the cut text is never posted');
  assert.match(botMessages(channel).at(-1).content, /^Kliknij \*\*Optymalizacja → Zoptymalizuj wszystko\*\*\.\n-# /);
  // Cut again: nothing is posted from it – the usual „chwilowy problem” path, the message stays unanswered.
  const again = groq((body) => chat({ content: 'Spróbuj' }, 'length', body.model), (body) => chat({ content: '' }, 'length', body.model));
  await write(channel, author, 'a jeszcze?');
  assert.equal(again.length, 2);
  assert.equal(countTexts(channel, /^Spróbuj/), 0);
  assert.ok(botTexts(channel).some((t) => /Mam chwilowy problem z odpowiedzią/.test(t)));
});

// ───────────── 2. The form is the first question ─────────────

test('opening on a free provider: every model\'s limit used up → the fixed greeting (no notice, no ping); the break starts and the author\'s message gets the break notice', async (t) => {
  t.mock.method(console, 'error', () => {});
  await fakes.server(CHAIN);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const calls = groq(limited(1), limited(1));
  const { channel } = await open('support', SUPPORT_FORM, author);
  assert.deepEqual(calls.map((c) => c.body.model), ['model-a', 'model-b'], 'the opening request went to every model');
  const [greeting] = botMessages(channel).filter((m) => m.content?.startsWith(format.INTRO));
  assert.equal(greeting.content, `${format.INTRO}\n\n${GREETINGS.support}\n${format.signature(fakes.ctx.guild, true)}`);
  assert.deepEqual(customIds(greeting.body), ['ai:human', 'ai:off']);
  assert.equal(countTexts(channel, /Przerwa asystenta AI|Wołam zespół|Mam chwilowy problem/), 0, 'a ticket that just opened gets no error notice and no ping');
  assert.equal(assistant.paused().reason, 'limit', 'the free-limit break protects the other tickets');
  assert.ok(ticketLog().some((x) => /skończył się darmowy limit/.test(x)));
  assert.deepEqual([aiOf(channel).active, aiOf(channel).stopped, aiOf(channel).greeted], [true, null, true]);

  // The author writes during the break: as before – the break notice that calls the team, no request.
  const none = groq();
  await write(channel, author, 'halo?');
  assert.equal(none.length, 0);
  assert.equal(countTexts(channel, new RegExp(LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), 1);
  // The break is over: the next message is answered – no second introduction.
  await sleep(1100);
  const back = groq(say('Jestem z powrotem – spróbuj **Napraw instancję** w menu instancji.'));
  await write(channel, author, 'jesteś?');
  assert.equal(back.length, 1);
  assert.match(botMessages(channel).at(-1).content, /^Jestem z powrotem/);
  assert.equal(countTexts(channel, new RegExp(`^${format.INTRO}`)), 1);
});

test('opening: a provider error → the fixed greeting, not „chwilowy problem”; the author\'s first message is answered as usual', async () => {
  await fakes.server(CHAIN);
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  groq({ status: 500, body: { error: { message: 'boom' } } }, { status: 500, body: { error: { message: 'boom' } } });
  const { channel } = await open('bug', [['Co nie działa?', 'Edytor HUD nie zapisuje pozycji'], ['Wersja launchera i Minecrafta', '2.11.2'], ['Jak wywołać błąd – krok po kroku', '1. otwieram edytor 2. zapisuję']], author);
  assert.equal(countTexts(channel, new RegExp(`^${format.INTRO}\\n\\n${GREETINGS.bug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)), 1);
  assert.equal(countTexts(channel, /Mam chwilowy problem/), 0);
  assert.equal(aiOf(channel).failures ?? 0, 0, 'an opening that failed does not count towards calling the team');
  const calls = groq(say('Dzięki! Spróbuj na razie zapisać układ HUD przed wyjściem z gry.'));
  await write(channel, author, 'i co teraz?');
  assert.equal(calls.length, 1);
  assert.match(botMessages(channel).at(-1).content, /^Dzięki! Spróbuj na razie/);
});

test('opening with Claude: a reward ticket whose opening fails still gets the greeting and its claim buttons', async () => {
  await fakes.server({});
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const gw = fakes.giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 });
  assistant.setClient({ beta: { messages: { create: async () => { throw new Error('offline'); } } } });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const { channel } = await open('reward', [['Który giveaway wygrałeś/aś?', 'Hammer+ 30 dni']], author);
    assert.ok(botTexts(channel).some((x) => x.startsWith(`${format.INTRO}\n\n${GREETINGS.reward}`)));
    assert.deepEqual(customIds(panelOf(channel).body), [`ai:claim:${gw.id}`, 'ai:human']);
  } finally {
    console.error = original;
  }
});

// ───────────── 3. The message format ─────────────

test('format: the server\'s logo emoji in the signature – 🔨 when the custom emoji is gone; the model\'s greeting and sign-off are taken out', async () => {
  await fakes.server(CHAIN);
  const guild = fakes.ctx.guild;
  const id = db.emojiIds(guild.id).logo;
  assert.ok(id, '/zbuduj uploaded the logo');
  assert.equal(format.signature(guild), `-# <:${require('../src/lib/theme').emojiName('logo')}:${id}> Asystent AI`);
  const saved = guild.emojis.cache.get(id);
  guild.emojis.cache.delete(id);
  try {
    assert.equal(format.signature(guild), '-# 🔨 Asystent AI');
    assert.equal(format.signature(guild), '-# 🔨 Asystent AI');
    const author = guild.addMember(uid(), [role('member')]);
    groq(say('Cześć! 👋 Jestem asystentem AI zespołu Hammer Launchera.\nKod wpisz w **Hammer+ → „Mam kod”** → wklej → **Aktywuj**.\n\nPozdrawiam,\nAsystent AI'), say('Hej! Tu asystent AI Hammera. Kod działa tylko na koncie, dla którego go wystawiono.\n— Asystent AI'));
    const { channel } = await open('plus', [['Twój nick w Minecraft', 'Notch'], ['W czym możemy pomóc?', 'Jak aktywować kod Hammer+?']], author);
    const [first] = botMessages(channel).filter((m) => m.content?.startsWith(format.INTRO));
    assert.equal(first.content, `${format.INTRO}\n\nKod wpisz w **Hammer+ → „Mam kod”** → wklej → **Aktywuj**.\n-# 🔨 Asystent AI`);
    await write(channel, author, 'a jak mam inne konto?');
    assert.equal(botMessages(channel).at(-1).content, 'Kod działa tylko na koncie, dla którego go wystawiono.\n-# 🔨 Asystent AI');
  } finally {
    guild.emojis.cache.set(id, saved);
  }
});

test('format helpers: tidy, strip (also the old footer), complete, split', () => {
  assert.equal(format.tidy('Cześć! Jestem asystentem AI Hammera. Spróbuj **Napraw instancję**.'), 'Spróbuj **Napraw instancję**.');
  assert.equal(format.tidy('Hej Kuba, spróbuj tego.'), 'Spróbuj tego.');
  assert.equal(format.tidy('Jako asystent AI nie widzę logów – zespół je obejrzy.'), 'Jako asystent AI nie widzę logów – zespół je obejrzy.', 'content stays');
  assert.equal(format.tidy('Kliknij X.\n-# 🤖 Asystent AI'), 'Kliknij X.');
  assert.equal(format.strip(`${format.INTRO}\n\nOdpowiedź.\n-# <:hs_logo:123> Asystent AI · napisz „człowiek”, a zawołam zespół`), 'Odpowiedź.');
  assert.equal(format.strip('Stara odpowiedź.\n-# 🤖 Asystent AI – może się pomylić. Napisz „człowiek”, a zawołam zespół.'), 'Stara odpowiedź.', 'tickets from before the update');
  assert.equal(format.complete('Zrób po kolei:\n1. Otwórz **Optymalizacja**.\n2. Kliknij Zoptymaliz'), 'Zrób po kolei:\n1. Otwórz **Optymalizacja**.');
  assert.equal(format.complete('To konflikt modów. Zrób po kolei:\n1. Otw'), 'To konflikt modów.', 'a lead-in to what was cut goes too');
  assert.equal(format.complete('Wersja 2.11.2 jest najnowsza. Pobier'), 'Wersja 2.11.2 jest najnowsza.');
  assert.equal(format.complete('Jedno zdanie bez końca'), '');
  const long = Array.from({ length: 40 }, (_, i) => `Zdanie numer ${i + 1} ma sens i kończy się kropką.`).join(' ');
  const parts = format.split(`${long}\n\n${long}\n\n${long}`);
  assert.ok(parts.length >= 2 && parts.length <= 3);
  for (const part of parts) assert.ok(part.length <= format.BODY_MAX && /\.$/.test(part), `${part.length}: …${part.slice(-20)}`);
});

// ───────────── 4. The knowledge file ─────────────

/** Writes the test's knowledge file; a new mtime every time, so the assistant reads it again. */
let stamp = Date.now() / 1000 - 1000;
function knowledgeFile(text) {
  fs.writeFileSync(KNOWLEDGE_FILE, text);
  stamp += 10;
  fs.utimesSync(KNOWLEDGE_FILE, stamp, stamp);
}

test('knowledge file: tolerant parsing – bullets, tabs or spaces, shared answers, multi-line answers, blank lines, CRLF, BOM, comments', () => {
  const text = [
    '\uFEFF<!--',
    'Komentarz – a w nim przykład, który nie jest wpisem:',
    '- Jak zmienić wersję Minecrafta?',
    '\t- W launcherze: Instancje → Edytuj.',
    '-->',
    '# Instalacja',
    '- Jak zmienić wersję Minecrafta?',
    '\t- W launcherze: menu instancji → **Edytuj** → Wersja Minecrafta.',
    '',
    '* Jak pobrać launcher?',
    '* Skąd pobrać launcher?',
    '',
    '    - Tylko z hammerclient.com.',
    '      Zaloguj się przez Discorda, a pobieranie ruszy samo.',
    '- Gra crashuje po dodaniu modów',
    '  1. Wyłącz nowe mody w zakładce Mody.',
    '  2. Kliknij Napraw instancję.',
    '- **Czy Hammer+ daje przewagę?**',
    '\tNie – tylko wygląd i wygodę.',
    '- Pytanie bez odpowiedzi',
    'Luźny tekst, który nie jest wpisem',
    '\t- odpowiedź bez pytania',
  ].join('\r\n');
  assert.deepEqual(knowledge.parse(text), [
    { questions: ['Jak zmienić wersję Minecrafta?'], answer: 'W launcherze: menu instancji → **Edytuj** → Wersja Minecrafta.' },
    { questions: ['Jak pobrać launcher?', 'Skąd pobrać launcher?'], answer: 'Tylko z hammerclient.com.\nZaloguj się przez Discorda, a pobieranie ruszy samo.' },
    { questions: ['Gra crashuje po dodaniu modów'], answer: '1. Wyłącz nowe mody w zakładce Mody.\n2. Kliknij Napraw instancję.' },
    { questions: ['Czy Hammer+ daje przewagę?'], answer: 'Nie – tylko wygląd i wygodę.' },
  ]);
  for (const broken of [null, '', '\uFEFF', '<!-- niedomknięty komentarz\n- A?\n\t- B', '\t\t- samo wcięcie', '- - -', '\u0000\u0001']) assert.doesNotThrow(() => knowledge.parse(broken));
  assert.deepEqual(knowledge.parse('- Pytanie?\n\t- Odpowiedź.\n- Drugie?\n\t- Druga.'), [{ questions: ['Pytanie?'], answer: 'Odpowiedź.' }, { questions: ['Drugie?'], answer: 'Druga.' }]);
});

test('knowledge file: the bot writes it on its first start – no entries, only the comment that explains the format – and never overwrites it', () => {
  const T = knowledge.TEMPLATE;
  assert.deepEqual(knowledge.parse(T), []);
  assert.match(T, /^<!--[\s\S]*- Jak zmienić wersję Minecrafta\?\n\t- W launcherze[\s\S]*-->\s*$/);
  // It is not part of the bot's package (an update unpacked over the folder must not wipe the team's answers).
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /^\/wiedza-asystenta\.md$/m);
  const file = path.join(process.env.HS_DATA_DIR, 'nowa-wiedza.md');
  knowledge.setFile(file);
  try {
    assert.equal(knowledge.ensure(), true, 'missing → written');
    assert.equal(fs.readFileSync(file, 'utf8'), T);
    fs.writeFileSync(file, '- Jak pobrać launcher?\n\t- Ze strony hammerclient.com.\n');
    assert.equal(knowledge.ensure(), false, 'there → left alone');
    assert.equal(knowledge.stats().questions, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /hammerclient\.com/);
  } finally {
    knowledge.setFile(fakes.KNOWLEDGE_FILE);
  }
});

test('knowledge file: Polish-aware matching – diacritics or not, word forms, stop-words; an unrelated question matches nothing', async () => {
  await fakes.server(CHAIN);
  knowledgeFile('- Jak zmienić wersję Minecrafta?\n\t- Menu instancji → Edytuj → Wersja Minecrafta.\n- Jak pobrać launcher?\n- Skąd pobrać launcher?\n\t- Tylko z hammerclient.com.\n- Kod Hammer+ nie działa\n\t- Sprawdź, czy w launcherze wybrane jest konto, dla którego jest kod.\n');
  const best = (q) => knowledge.find(q)[0]?.question ?? null;
  assert.equal(best('jak pobrac launcher'), 'Jak pobrać launcher?', 'without diacritics');
  assert.equal(best('Skąd mogę POBRAĆ ten launcher??'), 'Jak pobrać launcher?');
  assert.equal(best('jak zmienic wersje minecrafta na 1.21'), 'Jak zmienić wersję Minecrafta?', 'other word forms');
  assert.equal(best('chcę zmienić wersję gry w minecrafcie'), 'Jak zmienić wersję Minecrafta?');
  assert.equal(best('mój kod hammer+ nie dziala'), 'Kod Hammer+ nie działa');
  assert.equal(best('ile kosztuje hammer+ na miesiąc?'), null, 'one shared word is not enough');
  assert.equal(best('gra mi crashuje przy starcie'), null, 'unrelated');
  assert.equal(best('jak to zrobić?'), null, 'only stop-words');
  assert.equal(knowledge.find('jak pobrac launcher')[0].score, 1);
});

test('knowledge file: the matching entry goes on top with what to do with it, the rest of the knowledge follows – the opening uses the form, later answers the new message', async () => {
  await fakes.server(CHAIN);
  knowledgeFile('- Gra zamyka się po kliknięciu Graj\n\t- Najpierw menu instancji → Napraw instancję, potem wyłącz nowe mody.\n- Jak aktywować kod Hammer+?\n\t- Hammer+ → Mam kod → wklej → Aktywuj.\n');
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const calls = groq(say('Kliknij w menu instancji **Napraw instancję**, a potem wyłącz nowo dodane mody.'), say('Kod aktywujesz w **Hammer+ → „Mam kod”**.'), say('Proszę bardzo!'));
  await open('support', [['Temat', 'Gra się zamyka'], ['Wersja launchera i Minecrafta', '2.11.2'], ['Opisz dokładnie, co się dzieje', 'Po kliknięciu Graj gra się zamyka po paru sekundach']], author);
  const context = calls[0].body.messages.at(-1);
  assert.equal(context.role, 'system');
  assert.match(context.content, /Wiedza zespołu – to wpisał zespół i to jest prawda[\s\S]*\n1\. Pytanie: Gra zamyka się po kliknięciu Graj\nOdpowiedź zespołu: Najpierw menu instancji → Napraw instancję/);
  // The form asks exactly this stored question – the model is told to answer from it, not only shown it.
  assert.match(context.content, /Wpis 1 wyraźnie pasuje do pytania – odpowiedz na jego podstawie, własnymi słowami[\s\S]*nie zaprzeczaj mu/);
  assert.match(context.content, /\n2\. Pytanie: Jak aktywować kod Hammer\+\?/, 'the rest of the (small) knowledge follows');
  const channel = fakes.ctx.guild.channels.cache.get(db.tickets((x) => x.ownerId === author.id)[0].channelId);
  await write(channel, author, 'a jak aktywowac kod hammer+?');
  assert.match(calls[1].body.messages.at(-1).content, /\n1\. Pytanie: Jak aktywować kod Hammer\+\?/, 'later answers put what matches the new message on top');
  await write(channel, author, 'dzięki!');
  assert.match(calls[2].body.messages.at(-1).content, /Wiedza zespołu[\s\S]*Jeśli któryś wpis dotyczy pytania/, 'nothing matched – the knowledge is still there, the model decides');
  // The free plans count every token: the block is capped however long the answers are.
  knowledgeFile(`- Gra zamyka się po kliknięciu Graj\n\t- ${'Bardzo długa odpowiedź. '.repeat(200)}\n`);
  const block = knowledge.promptBlock(knowledge.find('gra zamyka się po kliknięciu graj'), 1200);
  assert.ok(block.length <= 1200, `${block.length} characters`);
});

test('knowledge file: read again when it changes – no restart; a broken read keeps the last good version; /asystent status shows it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const guild = await fakes.server(CHAIN);
  const owner = guild.members.cache.get(guild.ownerId);
  const status = async () => textOf(lastResponse(await command(owner, null, 'status')));
  if (fs.existsSync(KNOWLEDGE_FILE)) fs.rmSync(KNOWLEDGE_FILE);
  assert.match(await status(), /Baza wiedzy[\s\S]*brak pliku `wiedza-asystenta\.md`/);
  knowledgeFile('<!-- tylko komentarz -->\n');
  assert.match(await status(), /Baza wiedzy[\s\S]*`wiedza-asystenta\.md` jest pusty/);
  knowledgeFile('- Jak pobrać launcher?\n- Skąd pobrać launcher?\n\t- Tylko z hammerclient.com.\n');
  assert.equal(knowledge.find('jak pobrac launcher').length, 1, 'the new entry is used at once');
  assert.match(await status(), /Baza wiedzy[\s\S]*✅ `wiedza-asystenta\.md` · 2 pytania \(1 odpowiedź\) · wczytany \d\d:\d\d/);
  knowledgeFile('- Jak pobrać launcher?\n\t- Tylko z hammerclient.com.\n- Jak zmienić wersję Minecrafta?\n\t- Menu instancji → Edytuj.\n- Zapomniana odpowiedź\n');
  assert.equal(knowledge.find('jak zmienic wersje minecrafta').length, 1, 'changed again – read again');
  assert.match(await status(), /2 pytania \(2 odpowiedzi\)[\s\S]*1 pytanie bez odpowiedzi/);
  // A read that fails (here: far too big) keeps what was read before.
  knowledgeFile(`- Jak pobrać launcher?\n\t- ${'x'.repeat(600 * 1024)}\n`);
  assert.equal(knowledge.find('jak zmienic wersje minecrafta').length, 1, 'the last good version still answers');
  assert.match(await status(), /nie udało się odczytać \(plik ma \d+ KB – to za dużo[\s\S]*ostatnia dobra wersja: 2 pytania/);
  fs.rmSync(KNOWLEDGE_FILE);
  assert.equal(knowledge.find('jak pobrac launcher').length, 0, 'removed – no entries, no error');
  assert.equal(path.basename(KNOWLEDGE_FILE), 'wiedza-asystenta.md');
});
