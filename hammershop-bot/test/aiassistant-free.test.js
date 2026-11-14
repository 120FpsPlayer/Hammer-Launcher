'use strict';

// 🤖 The AI assistant on the free providers (Groq, any OpenAI-compatible API) and without AI at all. Groq is a fake
// fetch – nothing leaves the computer. This file runs in its own process, so the profile is set before anything loads.
process.env.HS_TEST_PROFILE = 'launcher';

const fakes = require('./helpers/aiFakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers/setup');
const { createInteraction, lastResponse, textOf, customIds } = require('./helpers/fakeInteraction');
const hammerplus = require('../src/features/hammerplus');
const assistant = require('../src/features/aiassistant');
const ai = require('../src/features/ai/client');
const openai = require('../src/features/ai/openai');
const { SYSTEM_PROMPT_FREE, GREETINGS } = require('../src/features/ai/prompt');
const assistantCommand = require('../src/commands/assistant');

const { uid, role, sleep, useEnv, groq, chat, say, callTools, limited, notFound, open, write, aiOf, botMessages, botTexts, panelOf, ticketLog, toolMessages, countTexts, giveaway, click, LIMIT_TEXT } = fakes;
let guild;
async function server(values) {
  guild = await fakes.server(values);
  return guild;
}
const owner = () => guild.members.cache.get(guild.ownerId);
async function statusText(channel) {
  const status = createInteraction({ guild, member: owner(), kind: 'command', commandName: 'assistant', subcommand: 'status', channel });
  await assistantCommand.execute(status);
  return textOf(lastResponse(status));
}
const CLAUDE_ONLY = ['cache_control', 'betas', 'fallbacks', 'output_config', '"strict"', 'additionalProperties', 'thinking'];

test('Groq by default: a fixed greeting when the ticket opens (no API call), a small request only when the author writes', async () => {
  await server();
  assert.deepEqual([ai.provider(), ai.model()], ['groq', 'openai/gpt-oss-120b']);
  const calls = groq(say('Spróbuj Optymalizacja → Zoptymalizuj wszystko. Jeśli nie pomoże, wyślij log.'));
  const { channel, author } = await open('support', [['Temat', 'Gra się nie uruchamia'], ['Wersja launchera i Minecrafta', '2.6.0, 1.21.4 Fabric'], ['Opisz dokładnie, co się dzieje', 'Czarny ekran']]);
  assert.equal(calls.length, 0, 'opening a ticket costs nothing');
  const greeting = botMessages(channel).find((m) => m.content.startsWith(GREETINGS.support));
  assert.ok(greeting, 'the greeting for a support ticket');
  assert.deepEqual(customIds(greeting.body), ['ai:human', 'ai:off']);
  assert.equal(panelOf(channel), undefined, 'no prize list outside reward tickets');
  assert.equal(aiOf(channel).replies, 0, 'the greeting is not an answer from the model');

  await write(channel, author, 'gra pokazuje czarny ekran po starcie, co robić?');
  assert.equal(calls.length, 1);
  const [req] = calls;
  assert.equal(req.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer gsk_test_key');
  assert.equal(req.body.model, 'openai/gpt-oss-120b');
  assert.equal(req.body.reasoning_effort, 'low');
  assert.ok(req.body.max_tokens <= 500, `max_tokens ${req.body.max_tokens}`);
  assert.equal(req.body.tool_choice, 'auto');
  assert.deepEqual(req.body.tools.map((t) => [t.type, t.function.name]), [['function', 'wezwij_zespol'], ['function', 'info_launchera']], 'a support ticket: only these two');
  for (const t of req.body.tools) assert.ok(t.function.description.length <= 140, t.function.name);
  const raw = JSON.stringify(req.body);
  for (const claudeOnly of CLAUDE_ONLY) assert.equal(raw.includes(claudeOnly), false, claudeOnly);
  assert.deepEqual(req.body.messages[0], { role: 'system', content: SYSTEM_PROMPT_FREE });
  assert.ok(SYSTEM_PROMPT_FREE.length <= 3500, `the free prompt has ${SYSTEM_PROMPT_FREE.length} characters`);
  assert.match(req.body.messages[1].content, /Czarny ekran/);
  assert.equal(req.body.messages.at(-1).role, 'system');
  assert.match(req.body.messages.at(-1).content, /ticket typu support/);
  assert.doesNotMatch(req.body.messages.at(-1).content, /pierwsza wiadomość/, 'the greeting already introduced it');
  assert.ok(req.body.messages.some((m) => m.role === 'assistant' && m.content.startsWith('Cześć! 👋')), 'the greeting is in the history');
  assert.ok(botTexts(channel).some((t) => /Zoptymalizuj wszystko/.test(t)));
  assert.ok(raw.length < 6000, `the whole request is ${raw.length} characters`);
});

test('a request carries the last 6 turns, each cut to ~400 characters, and a short form', async () => {
  await server();
  const { channel, author } = await open('support', [['Opisz dokładnie, co się dzieje', 'x'.repeat(1000)]]);
  groq(...Array.from({ length: 5 }, (_, i) => say(`Odpowiedź ${i + 1}`)));
  for (let i = 1; i <= 4; i += 1) await write(channel, author, `Wiadomość numer ${i}: ${'bla '.repeat(150)}`);
  const calls = groq(say('Ostatnia odpowiedź'));
  await write(channel, author, 'ostatnie pytanie');
  const turns = calls[0].body.messages.slice(1).filter((m) => m.role !== 'system');
  const [form, ...history] = turns;
  assert.ok(form.content.length <= 650, `the form block has ${form.content.length} characters`);
  assert.ok(history.length <= 6, `${history.length} turns`);
  const all = history.map((m) => m.content).join('\n');
  assert.doesNotMatch(all, /Wiadomość numer 1:|Wiadomość numer 2:/, 'the oldest turns are left out');
  assert.match(all, /Wiadomość numer 4:/);
  for (const m of history) for (const part of m.content.split('\n\n')) assert.ok(part.length <= 420, `a turn of ${part.length} characters`);
  assert.equal(history.at(-1).content, 'ostatnie pytanie');
});

test('a reward ticket: the claim buttons right away even with the AI on – the AI gets the prize tools and refreshes the list', async () => {
  await server();
  const author = guild.addMember(uid(), [role('member')]);
  const gw = giveaway({ prize: 'Hammer+ na miesiąc', winners: [author.id], plusDays: 30 });
  const calls = groq(callTools(['moje_wygrane', {}, 'call_1']), callTools(['odbierz_nagrode', { giveawayId: gw.id, minecraftNick: 'Steve' }, 'call_2']), say('Gotowe! Kod masz wyżej.'));
  const { channel } = await open('reward', [['Który giveaway wygrałeś/aś?', 'Hammer+ na miesiąc'], ['Twój nick w Minecraft', 'Steve']], author);
  assert.equal(calls.length, 0);
  assert.ok(botTexts(channel).some((t) => t.startsWith(GREETINGS.reward)));
  assert.deepEqual(customIds(panelOf(channel).body), [`ai:claim:${gw.id}`, 'ai:human']);

  await write(channel, author, 'mogę odebrać nagrodę przez Ciebie?');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['moje_wygrane', 'odbierz_nagrode', 'wezwij_zespol'], 'a reward ticket: the prize tools');
  const second = calls[1].body.messages;
  const at = second.findIndex((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_1');
  assert.ok(at > 0);
  assert.equal(second[at].tool_calls[0].function.arguments, '{}');
  assert.deepEqual([second[at + 1].role, second[at + 1].tool_call_id, second[at + 1].name], ['tool', 'call_1', 'moje_wygrane']);
  const granted = toolMessages(calls[2]).at(-1);
  assert.match(granted.content, /Kod Hammer\+ \(30 dni\) dla konta Minecraft Steve/);
  assert.doesNotMatch(granted.content, /HP1\./, 'the code never goes to the model');
  assert.equal(gw.claims[author.id].status, 'granted');
  assert.equal(countTexts(channel, /Twoja nagroda: Hammer\+ 30 dni/), 1);
  assert.match(textOf(panelOf(channel).body), /Nagrody odebrane/, 'the buttons follow the claim');
  const again = await click(author, channel, `ai:claim:${gw.id}`);
  assert.match(textOf(lastResponse(again)), /została już odebrana/);
});

test('model rotation: a 429 on the first model → the same request goes to the next one, no message and no ping in the ticket', async () => {
  await server();
  const { channel, author } = await open('support');
  const calls = groq(fakes.limited(600), say('Odpowiada drugi model.'), say('Znowu drugi model.'));
  await write(channel, author, 'launcher się zawiesza przy starcie');
  assert.deepEqual(calls.map((c) => c.body.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.deepEqual(calls[1].body.messages, calls[0].body.messages, 'the very same request');
  assert.ok(botTexts(channel).some((t) => /Odpowiada drugi model/.test(t)));
  assert.equal(botTexts(channel).some((t) => /przerwę|Wołam zespół/.test(t)), false);
  assert.equal(assistant.paused(), null);
  assert.equal(aiOf(channel).active, true);

  await write(channel, author, 'a teraz?');
  assert.equal(calls[2].body.model, 'openai/gpt-oss-20b', 'the limited model is skipped until its reset');
  const status = await statusText(channel);
  assert.match(status, /⏸️ limit do \d\d:\d\d · `openai\/gpt-oss-120b`/);
  assert.match(status, /✅ działa · `openai\/gpt-oss-20b` · dziś: 2 zapytania, 1\s?880 tokenów/);
  assert.match(status, /✅ działa · `qwen\/qwen3-32b`/);
});

test('a model the provider does not know (404) is skipped silently for the rest of the run – one console warning', async (t) => {
  await server();
  const warns = t.mock.method(console, 'warn', () => {});
  const { channel, author } = await open('plus', [['Twój nick w Minecraft', 'Notch'], ['W czym możemy pomóc?', 'Jak aktywować kod?']]);
  const calls = groq(fakes.notFound(), say('Hammer+ → „Mam kod” → wklej → Aktywuj.'), say('Proszę bardzo!'));
  await write(channel, author, 'jak wpisać kod?');
  await write(channel, author, 'dzięki');
  assert.deepEqual(calls.map((c) => c.body.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
  assert.equal(warns.mock.calls.filter((c) => /openai\/gpt-oss-120b[\s\S]*nie działa na tym koncie/.test(String(c.arguments[0]))).length, 1);
  assert.equal(botTexts(channel).some((t) => /przerwę|Wołam zespół/.test(t)), false);
  assert.match(await statusText(channel), /❌ niedostępny · `openai\/gpt-oss-120b`/);
});

test('every model limited → one break notice that calls the team, other tickets told once, and the assistant comes back after it', async () => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'model-a, model-b' });
  assert.deepEqual(ai.models(), ['model-a', 'model-b']);
  const first = await open('support');
  const second = await open('bug');
  const calls = groq(limited(1), limited(1));
  await write(first.channel, first.author, 'nie działa mi launcher');
  assert.deepEqual(calls.map((c) => c.body.model), ['model-a', 'model-b']);
  assert.equal(assistant.paused().reason, 'limit');
  assert.equal(countTexts(first.channel, new RegExp(LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), 1, 'the exact break message, once');
  const notice = botMessages(first.channel).find((m) => textOf(m.body).includes(LIMIT_TEXT));
  assert.ok(notice.body.allowedMentions.roles.includes(role('support')), 'the team is pinged in the same message');
  assert.equal(countTexts(first.channel, /Wołam zespół/), 0, 'no second notice saying the same');
  assert.equal(aiOf(first.channel).stopped, 'break');
  assert.ok(ticketLog().some((t) => /skończył się darmowy limit/.test(t)));

  await write(second.channel, second.author, 'edytor HUD nie zapisuje pozycji');
  await write(second.channel, second.author, 'halo?');
  assert.equal(calls.length, 2, 'no requests during the break');
  assert.equal(countTexts(second.channel, /Przerwa asystenta AI/), 1, 'another ticket is told once');
  const reward = await open('reward');
  assert.ok(panelOf(reward.channel), 'a reward ticket opened in the break gets the buttons');
  assert.equal(botTexts(reward.channel).some((t) => t.startsWith(GREETINGS.reward)), false, 'no AI greeting during the break');

  await sleep(1100);
  assert.equal(assistant.paused(), null);
  const back = groq(say('Jestem z powrotem – w czym pomóc?'));
  await write(first.channel, first.author, 'jesteś?');
  assert.equal(back.length, 1);
  assert.equal(aiOf(first.channel).stopped, null, 'the break is over – it answers again');
  assert.ok(botTexts(first.channel).some((t) => /Jestem z powrotem/.test(t)));
  assert.equal(countTexts(first.channel, /Przerwa asystenta AI/), 1);
});

test('a per-minute limit on the last model that frees up within seconds is waited out once – no break, no ping', async () => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'openai/gpt-oss-120b' });
  openai.setShortWait(2000);
  try {
    const { channel, author } = await open('support');
    const calls = groq({ status: 429, headers: { 'retry-after': '0.05' }, body: { error: { message: 'Rate limit reached (tokens per minute)', code: 'rate_limit_exceeded' } } }, say('Cześć!'));
    await write(channel, author, 'pomocy');
    assert.equal(calls.length, 2);
    assert.equal(assistant.paused(), null);
    assert.equal(botTexts(channel).some((t) => /Wołam zespół|przerwę/.test(t)), false);
  } finally {
    openai.setShortWait(0);
  }
});

test('how long a break lasts: retry-after or the reset of the exhausted limit, never more than an hour', () => {
  assert.equal(openai.retryAfter(new Headers({ 'retry-after': '30' })), 30_000);
  assert.equal(openai.retryAfter(new Headers({ 'retry-after': '86400' })), 3_600_000);
  assert.equal(openai.retryAfter(new Headers({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m59.56s', 'x-ratelimit-remaining-requests': '12', 'x-ratelimit-reset-requests': '1s' })), 179_560);
  assert.equal(openai.retryAfter(new Headers()), 60_000);
  assert.equal(openai.parseDuration('1h2m'), 3_720_000);
  assert.equal(openai.parseDuration('350ms'), 350);
});

test('401 (a bad key): no other model is tried, a clear console message, a break until the restart, the ticket goes to the team', async (t) => {
  await server();
  const errors = t.mock.method(console, 'error', () => {});
  const { channel, author } = await open('support');
  const calls = groq({ status: 401, body: { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } } });
  await write(channel, author, 'pomocy');
  assert.equal(calls.length, 1, 'a bad key is the same for every model');
  assert.equal(assistant.paused().reason, 'auth');
  assert.equal(assistant.paused().until, Infinity);
  assert.ok(errors.mock.calls.some((c) => /GROQ_API_KEY/.test(c.arguments[0]) && /uruchom bota ponownie/.test(c.arguments[0])));
  assert.equal(countTexts(channel, /Przerwa asystenta AI/), 1);
  const status = await statusText(channel);
  assert.match(status, /ma przerwę do ponownego uruchomienia bota[\s\S]*klucz API został odrzucony/);
});

test('no model of the list works (404 each): tells the owner to set AI_MODEL, a break until the restart, the reward buttons still work', async (t) => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'llama-stary-model' });
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const author = guild.addMember(uid(), [role('member')]);
  const gw = giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 });
  const { channel } = await open('reward', [], author);
  const calls = groq(notFound());
  await write(channel, author, 'co mam zrobić?');
  assert.equal(calls[0].body.model, 'llama-stary-model');
  assert.equal(assistant.paused().reason, 'model');
  assert.ok(errors.mock.calls.some((c) => /console\.groq\.com\/docs\/models/.test(c.arguments[0]) && /AI_MODEL=/.test(c.arguments[0])));
  assert.deepEqual(customIds(panelOf(channel).body), [`ai:claim:${gw.id}`, 'ai:human'], 'the no-AI path still works');
  assert.equal(countTexts(channel, /^## 🎁 Twoje wygrane/), 1, 'the list is not posted twice');
});

test('AI_MODEL: a comma-separated list; models that cannot chat are dropped (said once); nothing left → the default chain', async (t) => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'meta-llama/llama-prompt-guard-2-86m, llama-3.3-70b-versatile ,whisper-large-v3,qwen/qwen3-32b' });
  const warns = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(ai.models(), ['llama-3.3-70b-versatile', 'qwen/qwen3-32b']);
  ai.models();
  assert.equal(warns.mock.calls.filter((c) => /llama-prompt-guard-2-86m[\s\S]*whisper-large-v3[\s\S]*nie prowadzą rozmów/.test(String(c.arguments[0]))).length, 1);

  useEnv({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'meta-llama/llama-prompt-guard-2-86m' });
  const { channel, author } = await open('support');
  const calls = groq({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'Cześć! W czym mogę pomóc?' }, finish_reason: 'stop' }] } });
  await write(channel, author, 'hej');
  assert.equal(calls[0].body.model, 'openai/gpt-oss-120b');
  assert.equal(warns.mock.calls.filter((c) => /llama-prompt-guard-2-86m[\s\S]*nie prowadzi rozmów[\s\S]*openai\/gpt-oss-120b/.test(String(c.arguments[0]))).length, 1);
  assert.equal(ai.model(), 'openai/gpt-oss-120b');
  assert.deepEqual(ai.models(), ai.DEFAULT_CHAINS.groq);
});

test('403 about the model (blocked for the account) is reported as a model problem, not as a bad key', async (t) => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'jakis/zablokowany-model' });
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const { channel, author } = await open('support');
  groq({ status: 403, body: { error: { message: 'The model `jakis/zablokowany-model` is blocked at the organization level.', type: 'permission_error', code: 'model_permission_blocked_org' } } });
  await write(channel, author, 'hej');
  assert.equal(assistant.paused().reason, 'model');
  assert.ok(errors.mock.calls.some((c) => /nie działa na Twoim koncie/.test(c.arguments[0]) && /AI_MODEL=/.test(c.arguments[0])));
  assert.ok(!errors.mock.calls.some((c) => /klucz został odrzucony/.test(c.arguments[0])));
});

test('qwen writes its reasoning into the answer – <think> blocks never reach the ticket', async () => {
  await server({ GROQ_API_KEY: 'gsk_test_key', AI_MODEL: 'qwen/qwen3-32b' });
  const { channel, author } = await open('support');
  groq((body) => chat({ content: '<think>\nUżytkownik pyta o FPS. Zastanówmy się…\n</think>\n\nWłącz Optymalizacja → Zoptymalizuj wszystko.' }, 'stop', body.model));
  await write(channel, author, 'mam mało fps');
  const answer = botMessages(channel).at(-1).content;
  assert.match(answer, /^Włącz Optymalizacja/);
  assert.doesNotMatch(answer, /think|Zastanówmy/);
});

test('broken tool JSON from a free model: an error tool result and another try – never a crash; Groq\'s tool_use_failed is retried', async () => {
  await server();
  const { channel, author } = await open('support');
  const calls = groq(callTools(['info_launchera', '{"nick": "ab', 'c1']), say('Przepraszam – spróbujmy jeszcze raz. Czego dotyczy problem?'));
  await write(channel, author, 'jaka jest najnowsza wersja?');
  assert.equal(calls.length, 2);
  const [toolMsg] = toolMessages(calls[1]);
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /poprawnym JSON/);
  assert.equal(calls[1].body.messages.find((m) => m.tool_calls)?.tool_calls[0].function.arguments, '{}');
  assert.ok(botTexts(channel).some((t) => /spróbujmy jeszcze raz/.test(t)));

  const retried = groq({ status: 400, body: { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code: 'tool_use_failed' } } }, say('Cześć!'));
  await write(channel, author, 'halo');
  assert.equal(retried.length, 2, 'one more try after tool_use_failed');
  assert.deepEqual(retried.map((c) => c.body.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-120b'], 'on the same model');
  assert.equal(aiOf(channel).active, true);
});

test('a tool this ticket does not offer cannot be run, even if the model names it', async () => {
  await server();
  const author = guild.addMember(uid(), [role('member')]);
  const gw = giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30 });
  const { channel } = await open('support', [], author);
  const calls = groq(callTools(['odbierz_nagrode', { giveawayId: gw.id, minecraftNick: 'Steve' }, 'x']), say('Nagrody odbiera się w tickecie „Odbierz nagrodę”.'));
  await write(channel, author, 'daj mi nagrodę');
  assert.match(toolMessages(calls[1])[0].content, /Nie ma narzędzia odbierz_nagrode w tym tickecie/);
  assert.equal(gw.claims, undefined);
});

test('AI_PROVIDER=openai: any OpenAI-compatible API, e.g. Gemini; auto picks Groq first, then Claude', async () => {
  await server({ AI_PROVIDER: 'openai', AI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', AI_API_KEY: 'gemini-test-key', AI_MODEL: 'gemini-2.5-flash' });
  const { channel, author } = await open('support');
  const calls = groq(say('Cześć z Gemini!'));
  await write(channel, author, 'hej');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer gemini-test-key');
  assert.equal(calls[0].body.model, 'gemini-2.5-flash');
  assert.equal(calls[0].body.reasoning_effort, undefined, 'only gpt-oss gets reasoning_effort');
  assert.match(ai.label(), /zgodne z OpenAI \(generativelanguage\.googleapis\.com\)/);

  useEnv({ AI_PROVIDER: 'openai', AI_BASE_URL: 'https://example.com/v1' });
  assert.equal(ai.problem(), 'openai-incomplete');
  assert.match(assistant.unavailableText(), /AI_BASE_URL.*AI_API_KEY.*AI_MODEL/);
  useEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.deepEqual([ai.provider(), ai.model(), ai.compact()], ['claude', 'claude-opus-5-5', false]);
  useEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', AI_MODEL: 'claude-opus-5-5, claude-sonnet-5-5' });
  assert.deepEqual(ai.models(), ['claude-opus-5-5'], 'Claude stays one model');
  useEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', GROQ_API_KEY: 'gsk_x' });
  assert.equal(ai.provider(), 'groq');
  useEnv({ AI_PROVIDER: 'gemini' });
  assert.equal(ai.problem(), 'bad-provider');
  useEnv({});
});

test('no key: a reward ticket lists only real, unclaimed wins; Hammer+ asks for the nick and issues the code like the AI does', async () => {
  await server({});
  assert.equal(ai.provider(), null);
  const author = guild.addMember(uid(), [role('member')]);
  const other = guild.addMember(uid(), [role('member')]);
  const now = Date.now();
  const plusWin = giveaway({ prize: 'Hammer+ 30 dni', winners: [author.id], plusDays: 30, endsAt: now - 60_000 });
  const nitroWin = giveaway({ prize: 'Discord Nitro', winners: [author.id], endsAt: now - 120_000 });
  giveaway({ prize: 'Hammer+ 7 dni', winners: [author.id], endsAt: now - 180_000, claims: { [author.id]: { status: 'granted', at: now - 100_000, nick: 'Stary' } } });
  const lost = giveaway({ prize: 'Hammer+ na zawsze', winners: [other.id], entries: [other.id, author.id], endsAt: now - 240_000 });
  giveaway({ prize: 'Hammer+ na rok', winners: [], entries: [author.id], ended: false, endsAt: now + 3_600_000 });

  const { channel } = await open('reward', [['Który giveaway wygrałeś/aś?', 'Hammer+'], ['Twój nick w Minecraft', 'Steve']], author);
  const panel = panelOf(channel);
  assert.deepEqual(customIds(panel.body), [`ai:claim:${plusWin.id}`, `ai:claim:${nitroWin.id}`, 'ai:human'], 'only the two real, unclaimed wins');
  assert.match(textOf(panel.body), /Odbierz: Hammer\+ 30 dni[\s\S]*Odbierz: Discord Nitro/);
  assert.equal(aiOf(channel).mode, 'noai');

  // Hammer+ → the nick form (the nick from the ticket form already filled in) → the code.
  const button = await click(author, channel, `ai:claim:${plusWin.id}`, { message: panel });
  const form = button.state.modals[0];
  assert.equal(form.custom_id, `ai:nick:${plusWin.id}`);
  assert.equal(form.components[0].component.value, 'Steve');
  const submit = await click(author, channel, `ai:nick:${plusWin.id}`, { kind: 'modal', fields: { nick: 'Steve' }, message: panel });
  assert.match(textOf(lastResponse(submit)), /Gotowe! Kod Hammer\+ dla konta `Steve`/);
  assert.ok(botTexts(channel).some((t) => /Twoja nagroda: Hammer\+ 30 dni/.test(t) && /HP1\./.test(t)));
  assert.match(textOf(guild.dms.filter((d) => d.to === author.id).at(-1).payload), /HP1\./);
  assert.equal(plusWin.claims[author.id].status, 'granted');
  assert.ok(guild.members.cache.get(author.id).roles.cache.some((r) => r.name === '💎 Hammer+'));
  assert.ok(ticketLog().some((t) => /Asystent AI wydał nagrodę/.test(t) && !/HP1\./.test(t)));
  assert.deepEqual(customIds(panel.body), [`ai:claim:${nitroWin.id}`, 'ai:human'], 'the list is refreshed');

  // Twice is refused – the button and the form.
  const codes = hammerplus.codes(guild.id).length;
  const again = await click(author, channel, `ai:claim:${plusWin.id}`);
  assert.match(textOf(lastResponse(again)), /została już odebrana/);
  const againForm = await click(author, channel, `ai:nick:${plusWin.id}`, { kind: 'modal', fields: { nick: 'Alex' } });
  assert.match(textOf(lastResponse(againForm)), /została już odebrana/);
  assert.equal(hammerplus.codes(guild.id).length, codes);

  // Forged custom IDs: a giveaway the author did not win, a button clicked by somebody else.
  const forged = await click(author, channel, `ai:claim:${lost.id}`);
  assert.match(textOf(lastResponse(forged)), /Nie wygrałeś\/aś tego giveawayu/);
  const forgedForm = await click(author, channel, `ai:nick:${lost.id}`, { kind: 'modal', fields: { nick: 'Haker' } });
  assert.match(textOf(lastResponse(forgedForm)), /Nie wygrałeś\/aś tego giveawayu/);
  const stranger = await click(other, channel, `ai:claim:${nitroWin.id}`);
  assert.match(textOf(lastResponse(stranger)), /tylko autor ticketu/);
  assert.equal(lost.claims, undefined);
  assert.equal(hammerplus.codes(guild.id).length, codes);

  // Nitro → reported, the team is called with the summary.
  const nitro = await click(author, channel, `ai:claim:${nitroWin.id}`);
  assert.match(textOf(lastResponse(nitro)), /Zgłosiłem nagrodę zespołowi/);
  assert.equal(nitroWin.claims[author.id].status, 'reported');
  const call = botMessages(channel).find((m) => /Wołam zespół/.test(textOf(m.body)));
  assert.match(textOf(call.body), /Discord Nitro/);
  assert.ok(call.body.allowedMentions.roles.includes(role('coowner')));
  assert.match(textOf(panel.body), /Nagrody odebrane/);
});

test('no key: no win on this account → a short note without a ping; „człowiek” calls the team', async () => {
  await server({});
  const { channel, author } = await open('reward', [['Który giveaway wygrałeś/aś?', 'Hammer+ 30 dni']]);
  const note = botMessages(channel).find((m) => /Nie znalazłem Twojej wygranej/.test(textOf(m.body)));
  assert.ok(note);
  assert.match(textOf(note.body), /zespół to sprawdzi/);
  assert.deepEqual(note.body.allowedMentions, { parse: [] });
  assert.equal(botTexts(channel).some((t) => /Wołam zespół/.test(t)), false);
  await write(channel, author, 'chcę rozmawiać z prawdziwym człowiekiem');
  assert.ok(botTexts(channel).some((t) => /Wołam zespół/.test(t)));
  await write(channel, author, 'admin!!');
  assert.equal(botTexts(channel).filter((t) => /Wołam zespół/.test(t)).length, 1, 'once per ticket');
});


test('the adapter: Anthropic blocks ↔ chat messages, finish reasons, defensive argument parsing', () => {
  const body = openai.toChat({
    model: 'openai/gpt-oss-120b',
    max_tokens: 8000,
    system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'moje_wygrane', description: 'd', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'system', content: 'KONTEKST' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Sprawdzam' }, { type: 'tool_use', id: 't1', name: 'moje_wygrane', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] },
    ],
  });
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'system', 'assistant', 'tool']);
  assert.equal(body.messages[1].content, 'a\n\nb');
  assert.equal(body.messages[3].content, 'Sprawdzam');
  assert.deepEqual(body.messages[4], { role: 'tool', tool_call_id: 't1', name: 'moje_wygrane', content: '{"ok":true}' });
  assert.equal(body.max_tokens, openai.MAX_OUTPUT);
  assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'moje_wygrane', description: 'd', parameters: { type: 'object', properties: {} } } });

  const msg = (finish, message) => openai.fromChat({ choices: [{ message, finish_reason: finish }] }, 'm');
  assert.equal(msg('length', { content: 'ucię' }).stop_reason, 'max_tokens');
  assert.equal(msg('content_filter', { content: '' }).stop_reason, 'refusal');
  assert.equal(msg('stop', { content: '<think>hmm</think>Cześć' }).content[0].text, 'Cześć');
  const call = msg('stop', { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'moje_wygrane', arguments: '[1,2]' } }] });
  assert.equal(call.stop_reason, 'tool_use', 'a tool call is a tool call even when the provider says "stop"');
  assert.equal(call.content[0].invalid_json, '[1,2]');
  assert.deepEqual(openai.parseArguments('{"a":"b"}'), { ok: true, value: { a: 'b' } });
  assert.deepEqual(openai.parseArguments(''), { ok: true, value: {} });
  assert.equal(openai.parseArguments('{"a":').ok, false);
});
