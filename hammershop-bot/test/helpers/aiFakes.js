'use strict';

/**
 * Shared pieces of the AI assistant tests on the free providers: a built Hammer Launcher server, a fake Groq (fetch –
 * nothing leaves the computer), a fake Mojang, and helpers to open tickets, write in them and click buttons.
 * Set process.env.HS_TEST_PROFILE = 'launcher' before requiring this file.
 */

const crypto = require('node:crypto');
const { db } = require('./setup');
const { FakeGuild } = require('./fakeDiscord');
const { createInteraction, textOf } = require('./fakeInteraction');
const { buildServer } = require('../../src/builder/executor');
const { env } = require('../../src/env');
const config = require('../../src/lib/config');
const hooks = require('../../src/lib/hooks');
const tickets = require('../../src/tickets/tickets');
const handle = require('../../src/handlers/interactions');
const loadCommands = require('../../src/commands');
const hammerplus = require('../../src/features/hammerplus');
const assistant = require('../../src/features/aiassistant');
const openai = require('../../src/features/ai/openai');
const knowledge = require('../../src/features/ai/knowledge');

/** The knowledge file of the assistant tests – in this test file's own temporary data folder (absent until written). */
const KNOWLEDGE_FILE = require('node:path').join(process.env.HS_DATA_DIR, 'wiedza-asystenta.md');

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY'];
for (const key of ENV_KEYS) delete process.env[key];

env.plusPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
assistant.timing.debounce = 5;
assistant.timing.open = 5;
openai.setRetryDelay(0);
openai.setShortWait(0); // every 429 counts here – the short wait has its own test
const commands = loadCommands();
const LIMIT_TEXT = 'Asystent AI ma teraz przerwę – skończył się darmowy limit. Zawołałem zespół, ktoś zaraz odpisze.';

hammerplus.setFetch(async (url) => {
  const name = decodeURIComponent(String(url).split('/').pop());
  return { ok: true, status: 200, json: async () => ({ id: crypto.createHash('md5').update(name).digest('hex'), name }) };
});

const ctx = { guild: null };
let n = 933000000000000000n;
const uid = () => String(++n);
const role = (key) => db.roleId(ctx.guild.id, key);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Which keys .env has in this test – everything else is removed. */
function useEnv(values = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

/** The server (built once per test file), a clean assistant, the given .env keys, and no AI request allowed by default. */
async function server(values = { GROQ_API_KEY: 'gsk_test_key' }) {
  if (!ctx.guild) {
    ctx.guild = new FakeGuild();
    await buildServer({ guild: ctx.guild, mode: 'add', invokerId: ctx.guild.ownerId });
  }
  assistant.setClient(null);
  assistant._reset();
  // The owner's own wiedza-asystenta.md never changes what a test sends – a knowledge test writes its own file here.
  knowledge.setFile(KNOWLEDGE_FILE);
  db.guild(ctx.guild.id).aiAssistant = { enabled: true };
  useEnv(values);
  openai.setFetch(async (url, init) => {
    throw new Error(`unexpected AI request: ${url} ${init?.body?.slice?.(0, 80)}`);
  });
  return ctx.guild;
}

/**
 * A fake Groq: answers from the script in order. An entry is a chat/completions answer ({ body }), an error
 * ({ status, headers, body }) or a function (request body) → one of those.
 */
function groq(...script) {
  const calls = [];
  openai.setFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    let next = script.shift();
    if (typeof next === 'function') next = next(body);
    if (!next) throw new Error(`fake Groq: nothing more in the script (model ${body.model})`);
    const { status = 200, headers = {}, body: answer } = next;
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
  return calls;
}
const chat = (message, finish = 'stop', model = 'openai/gpt-oss-120b') => ({
  body: { id: 'chatcmpl-x', model, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 900, completion_tokens: 40 } },
});
/** A plain answer – from whichever model was asked. */
const say = (content) => (body) => chat({ content }, 'stop', body.model);
const callTools = (...calls) => (body) => chat({ content: null, tool_calls: calls.map(([name, args, id]) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })) }, 'tool_calls', body.model);
const limited = (seconds = 600) => ({ status: 429, headers: { 'retry-after': String(seconds) }, body: { error: { message: 'Rate limit reached for model', type: 'tokens', code: 'rate_limit_exceeded' } } });
const notFound = () => ({ status: 404, body: { error: { message: 'The model does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } } });

async function open(typeId, answers = [], author = ctx.guild.addMember(uid(), [role('member')])) {
  const channel = await tickets.openTicket(author, config.getType(typeId), answers.map(([label, value]) => ({ label, value })));
  await assistant.settle();
  return { author, channel };
}

/** Somebody writes in the ticket (the bot sees it through the messageCreate hook, after the ticket tracking). */
async function write(channel, member, text, { wait = true } = {}) {
  const msg = channel.userMessage(member.id, text);
  msg.member = member;
  tickets.trackMessage(msg);
  await hooks.emit('messageCreate', msg);
  if (wait) await assistant.settle();
  return msg;
}

const aiOf = (channel) => db.getTicket(channel.id).ai;
const botMessages = (channel) => channel.messageList.filter((m) => m.author.id === ctx.guild.client.user.id);
const botTexts = (channel) => botMessages(channel).map((m) => textOf(m.body));
const panelOf = (channel) => botMessages(channel).find((m) => /^(## 🎁 Twoje wygrane|### ✅ Nagrody odebrane|### 🔍 Nie znalazłem Twojej wygranej)/.test(textOf(m.body)));
const ticketLog = () => ctx.guild.channels.cache.get(db.channelId(ctx.guild.id, 'ticketLogs')).messageList.map((m) => textOf(m.body));
const toolMessages = (call) => call.body.messages.filter((m) => m.role === 'tool');
const countTexts = (channel, re) => botTexts(channel).filter((t) => re.test(t)).length;

function giveaway({ prize, winners, entries = winners, plusDays = null, endsAt = Date.now() - 60_000, ended = true, claims }) {
  const id = crypto.randomBytes(4).toString('hex');
  const gw = { id, guildId: ctx.guild.id, channelId: '1', messageId: null, prize, description: null, winnersCount: winners.length || 1, endsAt, hostId: ctx.guild.ownerId, requiredRoleId: null, buyersOnly: false, minInvites: null, plusDays, entries, winners, ended, createdAt: endsAt - 86_400_000, ...(claims && { claims }) };
  db.guild(ctx.guild.id).giveaways[id] = gw;
  return gw;
}

/** A click, a form or a slash command through the bot's real interaction router (errors come back as the user sees them). */
async function click(member, channel, customId, { kind = 'button', fields, message } = {}) {
  const interaction = createInteraction({ guild: ctx.guild, member, kind, customId, channel, fields, message });
  await handle(interaction, commands);
  return interaction;
}
async function command(member, channel, subcommand, options = {}) {
  const interaction = createInteraction({ guild: ctx.guild, member, kind: 'command', commandName: 'assistant', subcommand, options, channel });
  await handle(interaction, commands);
  return interaction;
}

module.exports = {
  ctx, uid, role, sleep, useEnv, server, groq, chat, say, callTools, limited, notFound, open, write, aiOf, botMessages, botTexts, panelOf,
  ticketLog, toolMessages, countTexts, giveaway, click, command, LIMIT_TEXT, commands, KNOWLEDGE_FILE,
};
