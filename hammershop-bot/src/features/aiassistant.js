'use strict';

/**
 * 🤖 AI assistant in tickets (Hammer Launcher server) – answers people before the team does. The AI is chosen in .env
 * (src/features/ai/client.js): Groq (free, the default with GROQ_API_KEY), Claude, or any OpenAI-compatible API.
 *
 *   - A ticket opens → the assistant reads the form (the person's question) and answers it right away, after the ticket
 *     card is posted – on the free providers too (one request per ticket). Nothing to answer (a form without a
 *     question on a free provider) → a fixed greeting for the ticket type, no API call; a „Odbierz nagrodę” ticket gets
 *     the claim buttons right away (on the free providers with the fixed greeting – the buttons do the work). The
 *     request fails, the free limit is out → the fixed greeting, and the author's first message is answered as usual.
 *   - Every message: „Cześć! Jestem asystentem AI Hammera.” on the first one only, the answer, the signature line with
 *     the server's logo emoji (src/features/ai/format.js). Never half an answer: cut-off answers keep their complete
 *     sentences, long ones are split into whole messages.
 *   - Before every answer it looks for similar questions in the team's knowledge – entries added with /wiedza and the
 *     optional wiedza-asystenta.md (src/features/ai/knowledge.js) – and sends the matches with the request, to be retold
 *     in the conversation.
 *   - The ticket's author writes → it answers (bursts are waited out – DEBOUNCE – and "typing…" is shown).
 *   - It can check giveaway wins and hand out the prize (Hammer+ codes at once, anything else goes to the team),
 *     tell the current launcher version / Hammer+ prices, and call the team (src/features/ai/tools.js).
 *   - Somebody asks for a person („człowiek”, „admin”…) → the bot calls the team itself, without the model
 *     (src/features/ai/human.js), says help is coming and the assistant goes quiet in that ticket.
 *   - It stops in a ticket once a staff member writes there (a human took over), after calling the team and after
 *     MAX_REPLIES answers. Staff turn it back on / off per ticket (buttons, /asystent ticket) and for the whole server
 *     (/asystent wlacz|wylacz – src/commands/assistant.js).
 *
 * No-AI mode – no key at all, or the assistant paused (free limit used up, key or model rejected): a „Odbierz nagrodę”
 * ticket lists the author's unclaimed wins with a claim button each (Hammer+ asks for the nick in a form and issues the
 * code like the AI does, anything else goes to the team), and asking for a person still calls the team. Other tickets
 * work as before the assistant existed. Only on the Hammer Launcher server (BOT_PROFILE=launcher).
 *
 * State: ticket.ai = { mode ('ai' | 'noai'), active, stopped ('staff' | 'escalated' | 'manual' | 'break' | null), replies,
 *   msgIds (its own messages), firstMsgId, answeredUpTo (the newest author message already answered), greeted, failures,
 *   escalatedAt, resumedAt, breakUntil (the break it told this ticket about), panelId (the prize list) }
 *   'break' = the assistant had a break while this ticket waited: the team was called, and once the break is over the
 *   assistant answers here again (unless a staff member wrote meanwhile).
 *   db.guild(id).aiAssistant = { enabled (false = off on the whole server), by, at }
 * Logs: what it does (prize handed out, team called, errors) goes to the ticket log – never the conversation.
 */

const path = require('node:path');
const { ButtonStyle, MessageFlags, ModalBuilder } = require('discord.js');
const config = require('../lib/config');
const db = require('../lib/db');
const hooks = require('../lib/hooks');
const profile = require('../lib/profile');
const perms = require('../lib/permissions');
const { COLORS } = require('../lib/theme');
const { btn, row, notice, container, text, v2 } = require('../lib/v2');
const { slash } = require('../lib/commandsPl');
const { UserError, logEmbed, sendLog, sendTicketLog, pad, truncate, reply, isStaff, ts } = require('../lib/utils');
const hammerplus = require('./hammerplus');
const ai = require('./ai/client');
const prizes = require('./ai/prizes');
const models = require('./ai/models');
const { SYSTEM_PROMPT, freePrompt, GREETINGS } = require('./ai/prompt');
const { TOOLS, toolsFor, runTool, brokenInput, REPORT_WHY } = require('./ai/tools');
const { ProviderError } = require('./ai/openai');
const { asksForHuman } = require('./ai/human');
const format = require('./ai/format');
const knowledge = require('./ai/knowledge');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'; // Claude: refusal fallbacks – a declined request is retried on another model
const EFFORT = 'low'; // chat / support – Opus 5.5 always thinks, effort keeps it short (gpt-oss on Groq: reasoning_effort)
const MAX_ITERATIONS = 6; // model calls per answer (tool round trips)
const MAX_REPLIES = 25; // per ticket – then the team takes over
const HOURLY_CAP = 20; // answers per author per hour, across tickets
const MAX_FAILURES = 2; // failed answers in a row before the team is called
const BREAKS = ['limit', 'auth', 'model', 'config', 'billing']; // errors that pause the assistant for every ticket
// An answer with nothing to post (cut off before its first full sentence, or empty): asked once more, for a shorter one.
const SHORTER = 'Twoja poprzednia odpowiedź nie zmieściła się w limicie albo była pusta. Odpowiedz jeszcze raz, krócej: najwyżej 3–4 zdania albo 3 kroki.';
const KEY_PAUSE_MS = 3_600_000; // no credits on Claude: no new calls for an hour
const MAX_PAUSE_MS = 3_600_000; // a free limit: as long as the provider says, at most an hour
const LIMIT_TEXT = 'Asystent AI ma teraz przerwę – skończył się darmowy limit. Zawołałem zespół, ktoś zaraz odpisze.';
const NICK = /^[A-Za-z0-9_]{1,16}$/;
const ESCALATE_AGAIN_MS = 10 * 60_000;

const timing = { debounce: 4000, open: 2500, typing: 8000 };

// ───────────── Switches ─────────────

let pause = null; // { until (ms – Infinity: until the bot is restarted), reason: 'limit' | 'auth' | 'model' | 'config' | 'billing' }

/** The assistant's break – null when there is none (or it is over). */
const paused = () => (pause && Date.now() < pause.until ? pause : null);
/** ms: how long (a free limit: at most an hour); Infinity: until a restart (a key or model only .env can fix). */
function pauseFor(reason, ms) {
  const until = ms === Infinity ? Infinity : Date.now() + Math.min(Math.max(ms, 1000), MAX_PAUSE_MS);
  if (!paused()) pause = { since: Date.now(), until, reason };
  else if (pause.until < until) pause = { ...pause, until, reason }; // the same break, only longer
  return pause;
}
const forever = (p) => p?.until === Infinity;
const PAUSE_REASONS = {
  limit: 'skończył się darmowy limit dostawcy AI',
  auth: 'klucz API został odrzucony – popraw go w .env i uruchom bota ponownie',
  model: 'żaden model z listy nie działa na tym koncie – popraw AI_MODEL w .env i uruchom bota ponownie',
  config: 'klucz API albo model został odrzucony – popraw .env i uruchom bota ponownie',
  billing: 'brak środków na koncie Anthropic',
};

const globallyOn = (guildId) => db.guild(guildId).aiAssistant?.enabled !== false;
/** The assistant can run on this bot at all: launcher server, a configured AI (or a test's client), no break. */
const available = () => profile.launcher && ai.configured() && !paused();
const activeIn = (guildId) => available() && globallyOn(guildId);
const eligible = (type) => Boolean(type) && !type.shopOnly && type.id !== 'order';

function setGlobal(guild, enabled, actor) {
  const g = db.guild(guild.id);
  g.aiAssistant = { ...(g.aiAssistant ?? {}), enabled: Boolean(enabled), by: actor?.id ?? null, at: Date.now() };
  db.save();
  sendLog(guild, {
    embeds: [logEmbed(enabled ? COLORS.success : COLORS.muted, enabled ? '🤖 Asystent AI włączony' : '🔕 Asystent AI wyłączony', actor?.user ?? actor).setDescription(`${actor ?? 'Ktoś'} ${enabled ? 'włącza' : 'wyłącza'} asystenta AI w ticketach na całym serwerze.`)],
  }).catch(() => null);
}

const PROBLEMS = {
  'no-key':
    'Asystent AI jest wyłączony – w pliku `.env` nie ma klucza. Darmowy klucz: `GROQ_API_KEY` z console.groq.com (README → „Asystent AI w ticketach”). Do tego czasu nagrody z giveawayów odbiera się przyciskami w tickecie.',
  'no-groq-key': '`AI_PROVIDER=groq`, ale w pliku `.env` brakuje `GROQ_API_KEY` (console.groq.com → API Keys).',
  'no-claude-key': '`AI_PROVIDER=claude`, ale w pliku `.env` brakuje `ANTHROPIC_API_KEY`.',
  'no-sdk': 'Brakuje pakietu `@anthropic-ai/sdk` – uruchom `npm install` w folderze bota i uruchom go ponownie.',
  'openai-incomplete': '`AI_PROVIDER=openai` potrzebuje w pliku `.env` trzech wartości: `AI_BASE_URL`, `AI_API_KEY` i `AI_MODEL`.',
  'bad-provider': '`AI_PROVIDER` w pliku `.env` ma nieznaną wartość – wpisz `auto`, `groq`, `claude` albo `openai`.',
};

/** Why it can't run at all (the setup) – for /asystent (Polish), null when it can. A break is pauseText(). */
function unavailableText() {
  if (!profile.launcher) return 'Asystent AI działa tylko na serwerze Hammer Launcher (`BOT_PROFILE=launcher`).';
  const p = ai.problem();
  return p ? PROBLEMS[p] ?? p : null;
}

/** "Asystent AI ma przerwę do 18:00 (za 20 minut) – skończył się darmowy limit…" – null without a break. */
function pauseText() {
  const p = paused();
  if (!p) return null;
  const until = forever(p) ? 'do ponownego uruchomienia bota' : `do ${ts(p.until, 't')} (${ts(p.until, 'R')})`;
  return `Asystent AI ma przerwę ${until} – ${PAUSE_REASONS[p.reason] ?? p.reason}. W tym czasie tickety działają bez AI.`;
}

// ───────────── Ticket state ─────────────

function patchAi(channelId, patch) {
  const t = db.getTicket(channelId);
  if (!t) return null;
  return db.updateTicket(channelId, { ai: { ...(t.ai ?? {}), ...patch } });
}

/**
 * A staff member was active after the assistant was (re)started: wrote, sent a /reply snippet (the bot posts it on their
 * behalf) or claimed the ticket – tickets.js keeps that time in ticket.staffActivityAt. The last two lines are for tickets
 * from before that field existed.
 */
function humanTookOver(t) {
  if (!t) return false;
  // staffActivityAt only grows; switching the assistant on remembers the mark it saw – anything after it is new.
  if (t.staffActivityAt !== undefined) return t.staffActivityAt > (t.ai?.resumedAfter ?? 0);
  const since = t.ai?.resumedAt ?? 0;
  if (t.firstResponseAt && t.firstResponseAt > since) return true;
  return Boolean(t.claimedBy && !t.ai?.resumedAt);
}

/** Staff have this ticket: they wrote, claimed it or switched the assistant off. */
const staffHave = (t) => ['staff', 'manual'].includes(t?.ai?.stopped) || humanTookOver(t);

/** The ticket as it is now, if the assistant may still post its own answer there – else null (closed, staff took over). */
function stillAnswering(channel) {
  const t = db.getTicket(channel.id);
  if (!t || t.status !== 'open') return null;
  if (humanTookOver(t) && !['staff', 'manual'].includes(t.ai?.stopped)) stop(channel, 'staff');
  return t.ai?.active && !staffHave(t) ? db.getTicket(channel.id) : null;
}

const channels = new Map(); // channelId → { timer, running, again }
const pending = new Set();
const state = (id) => {
  if (!channels.has(id)) channels.set(id, { timer: null, running: false, again: false });
  return channels.get(id);
};

function clearTimer(channelId) {
  const s = channels.get(channelId);
  if (s?.timer) clearTimeout(s.timer);
  if (s) {
    s.timer = null;
    s.again = false;
  }
}

function stop(channel, why) {
  clearTimer(channel.id);
  patchAi(channel.id, { active: false, stopped: why });
}

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

/** Answers after `delay` ms – a new message in the meantime moves it again; during an answer, one more follows it. */
function schedule(channel, delay) {
  const s = state(channel.id);
  if (s.running) {
    s.again = true;
    return;
  }
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    track(run(channel));
  }, delay);
  s.timer.unref?.();
}

const repliesTo = new Map(); // author ID → timestamps of answers in the last hour
function recentReplies(userId, now = Date.now()) {
  const list = (repliesTo.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  repliesTo.set(userId, list);
  return list.length;
}
const noteReply = (userId) => repliesTo.set(userId, [...(repliesTo.get(userId) ?? []), Date.now()]);

// ───────────── The conversation ─────────────

/** No pings from the model's text (allowedMentions is empty anyway) and nothing that looks like one. */
const clean = (text) =>
  String(text ?? '')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** One Discord message as text for the model: content plus the names of its files (the model can't open them). */
function describe(m, max) {
  let text = String(m.content ?? '').trim();
  const files = [...(m.attachments?.values?.() ?? [])].map((a) => a.name).filter(Boolean);
  if (files.length) text += `${text ? '\n' : ''}[załącznik: ${files.join(', ')} – nie widzisz jego treści]`;
  if (!text && m.stickers?.size) text = '[naklejka]';
  return truncate(text, max);
}

function formBlock(ticket, type, max) {
  const lines = [`[Ticket #${pad(ticket.number)} · ${type?.label ?? ticket.typeId} · autor: ${ticket.ownerName ?? 'nieznany'}]`];
  const answers = (ticket.answers ?? []).filter((a) => a?.label);
  if (answers.length) lines.push('Formularz ticketu:', ...answers.map((a) => `${a.label}: ${String(a.value ?? '').trim() || '—'}`));
  else lines.push('Ticket otwarty bez formularza.');
  return truncate(lines.join('\n'), max);
}

/**
 * The bot's own context for this answer – a system message after the history, so the cached prefix stays the same.
 * known: the knowledge file's block for this question ('' when nothing matched).
 */
function contextMessage(ticket, type, first, known = '') {
  const today = new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'full' });
  const lines = [`Kontekst od bota: ticket typu ${type?.id ?? ticket.typeId} („${type?.label ?? ticket.typeId}”). Dziś jest ${today}.`];
  if (first) {
    lines.push(
      'To Twoja pierwsza odpowiedź w tym tickecie – powitanie i podpis doda bot. Od razu odpowiedz na pytanie albo problem z formularza. Jeśli w formularzu nie ma pytania, napisz jednym zdaniem, w czym możesz pomóc, i zapytaj o to, czego brakuje.',
    );
  }
  if (known) lines.push('', known);
  return { role: 'system', content: lines.join('\n') };
}

/** The form's answers as one text – what the person asks when the ticket opens (for the knowledge file). */
const formText = (ticket) => (ticket.answers ?? []).map((a) => String(a?.value ?? '').trim()).filter(Boolean).join('\n');

/** Is there anything to answer in the form? A nick or a lone number is not a question. */
const hasQuestion = (ticket) => (ticket.answers ?? []).some((a) => !/nick/i.test(a?.label ?? '') && /\p{L}{3,}/u.test(String(a?.value ?? '')));

/**
 * The messages for the API: the form first, then the channel oldest → newest (the assistant's own messages as its
 * turns), and the author's messages it hasn't answered yet at the end. null when there is nothing to answer.
 * The knowledge file is searched with what is being answered: the unanswered messages – and the form at the start.
 */
function buildConversation(guild, ticket, type, history, budget = ai.budget()) {
  const s = ticket.ai ?? {};
  const mine = new Set(s.msgIds ?? []);
  const botId = guild.client?.user?.id;
  const answered = s.answeredUpTo ? BigInt(s.answeredUpTo) : null;
  const older = [];
  const fresh = [];
  let newestOwnerId = null;
  for (const m of history) {
    if (!m?.author || m.id === ticket.controlMessageId) continue;
    if (m.author.bot || m.author.id === botId) {
      const text = mine.has(m.id) ? format.strip(m.content) : '';
      if (text) older.push({ role: 'assistant', text });
      continue;
    }
    const text = describe(m, budget.messageChars);
    if (!text) continue;
    if (m.author.id === ticket.ownerId) {
      newestOwnerId = m.id;
      (answered === null || BigInt(m.id) > answered ? fresh : older).push({ role: 'user', text });
      continue;
    }
    const member = m.member ?? guild.members.cache.get(m.author.id);
    const name = member?.displayName ?? m.author.username ?? 'ktoś';
    older.push({ role: 'user', text: `[${isStaff(member, type) ? 'Zespół' : 'Inna osoba w tickecie'} – ${name}]: ${text}` });
  }
  const opening = !s.greeted;
  if (!fresh.length && !opening) return null;
  // Only the newest turns (the free providers get a few): every unanswered author message, then older ones up to it.
  const kept = fresh.slice(-budget.history);
  const recent = older.slice(Math.max(0, older.length - (budget.history - kept.length)));
  const turns = [{ role: 'user', text: formBlock(ticket, type, budget.formChars) }, ...recent, ...kept];
  const messages = [];
  for (const turn of turns) {
    const last = messages[messages.length - 1];
    if (last?.role === turn.role) last.content.push({ type: 'text', text: turn.text });
    else messages.push({ role: turn.role, content: [{ type: 'text', text: turn.text }] });
  }
  if (messages[messages.length - 1].role !== 'user') return null;
  const query = [opening ? formText(ticket) : '', ...fresh.map((t) => t.text)].filter(Boolean).join('\n');
  const matches = knowledge.find(query, { guildId: guild.id }); // /wiedza entries and the optional file
  messages.push(contextMessage(ticket, type, !(s.msgIds ?? []).length, knowledge.promptBlock(matches, budget.knowledgeChars)));
  return { messages, newestOwnerId, matches };
}

/**
 * The request. Claude: the full prompt and every tool, frozen, so they are read from its cache after the first call.
 * The free providers: the short prompt and only the tools this ticket type needs (the adapter drops the Claude-only
 * fields – betas, fallbacks, cache_control, output_config – and maps effort to gpt-oss's reasoning_effort).
 */
function request(messages, type = null) {
  const compact = ai.compact();
  return {
    model: ai.model(),
    max_tokens: ai.budget().maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: EFFORT },
    cache_control: { type: 'ephemeral' }, // the growing conversation
    system: [{ type: 'text', text: compact ? freePrompt(type?.id) : SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], // tools + system prompt
    tools: compact ? toolsFor(type?.id) : TOOLS,
    tool_choice: { type: 'auto' },
    messages,
  };
}

/**
 * Content to send back on the next call. After a fallback (another model took over mid-answer) the blocks before the
 * last `fallback` block are dropped except text – the fallback block itself stays where it was.
 */
function echoable(content) {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback');
  if (boundary === -1) return content;
  return content.filter((b, i) => i >= boundary || b.type === 'text' || b.type === 'fallback');
}

const textOf = (content) =>
  content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

/**
 * The tool loop → { kind: 'text', text, usedTools, trimmed } | { kind: 'cut' } (nothing usable) | { kind: 'refusal' }
 * | { kind: 'escalated' } (a tool called the team – nothing more is said) | { kind: 'limit' } (too many steps).
 *
 * An answer cut off by max_tokens is never posted as it came – it would end in the middle of a sentence. Its complete
 * sentences are kept (trimmed: true); when not even one is complete, the model is asked once more for a shorter answer
 * (one extra request – the free plans count every one, and the bigger budget makes this rare).
 */
async function converse(messages, ctx) {
  const client = ai.client();
  let usedTools = false;
  let retried = false;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const params = request(messages, ctx.type);
    ctx.allowed = new Set(params.tools.map((t) => t.name)); // a tool this ticket doesn't offer can't be run
    const response = await client.beta.messages.create(params);
    models.noteUsage(response.model ?? params.model, response.usage); // today's requests and tokens per model
    const content = echoable(response.content ?? []);
    const stopReason = response.stop_reason;
    if (stopReason === 'refusal') return { kind: 'refusal' };
    const uses = content.filter((b) => b.type === 'tool_use');
    if (stopReason === 'tool_use' && uses.length) {
      usedTools = true;
      messages.push({ role: 'assistant', content });
      const results = [];
      for (const use of uses) {
        const r = use.invalid_json !== undefined ? brokenInput() : await runTool(use.name, use.input, ctx);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: r.content, ...(r.isError && { is_error: true }) });
      }
      messages.push({ role: 'user', content: results }); // all results of one turn in one message
      if (ctx.escalated) return { kind: 'escalated' };
      continue;
    }
    if (stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content });
      continue;
    }
    const text = textOf(content);
    const cut = stopReason === 'max_tokens'; // a cut-off tool call is never run – it isn't a tool_use stop
    // Text before a cut-off tool call ("Sprawdzam…") promises something that won't happen – not worth posting.
    const whole = !cut ? text : uses.length ? '' : format.complete(text);
    if (whole) return { kind: 'text', text: whole, usedTools, trimmed: whole !== text };
    if (!cut && usedTools) return { kind: 'text', text: '', usedTools }; // a tool already did the talking
    // Nothing to send: cut before the first full sentence, or a free model that only "thought".
    if (retried) return { kind: 'cut' };
    retried = true;
    messages.push({ role: 'system', content: SHORTER });
  }
  return { kind: 'limit' };
}

// ───────────── Answering ─────────────

/**
 * An assistant message in the ticket, in the owner's format: the first one in a ticket starts with the introduction and
 * carries the hint and the two buttons; every one ends with the signature (format.js). The model's own greeting or
 * sign-off is taken out. An answer too long for one message goes out as two (or three) whole messages – the
 * introduction on the first, the signature and buttons on the last. counted: false for the fixed greeting (it isn't an
 * answer from the model). → the last message sent, null when there was nothing to send.
 */
async function sendReply(channel, text, { counted = true } = {}) {
  const ticket = db.getTicket(channel.id);
  const s = ticket?.ai ?? {};
  const first = !(s.msgIds ?? []).length;
  const raw = clean(text);
  if (!raw) return null;
  // An answer that was nothing but a greeting ("Cześć!"): the first message says the type's greeting instead (the bot
  // introduces itself already), a later one keeps what the model wrote.
  const body = format.tidy(raw) || (first ? GREETINGS[ticket?.typeId] ?? GREETINGS.default : raw);
  const parts = format.split(body);
  const sent = [];
  try {
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      sent.push(
        await channel.send({
          content: `${first && i === 0 ? `${format.INTRO}\n\n` : ''}${part}${last ? `\n${format.signature(channel.guild, first)}` : ''}`,
          allowedMentions: { parse: [] },
          components: first && last ? [row(btn('ai:human', 'Zawołaj zespół', '🙋'), btn('ai:off', 'Wyłącz asystenta', '🔕'))] : [],
        }),
      );
    }
  } finally {
    // Even when a later part failed, the parts that got out are the assistant's (the history shows them as its turns).
    if (sent.length) {
      const now = db.getTicket(channel.id)?.ai ?? {};
      const ids = sent.map((m) => m.id);
      patchAi(channel.id, { msgIds: [...(now.msgIds ?? []), ...ids].slice(-40), replies: (now.replies ?? 0) + (counted ? 1 : 0), firstMsgId: now.firstMsgId ?? ids[0], lastReplyAt: Date.now() });
    }
  }
  return sent.at(-1) ?? null;
}

/** The fixed first message for this ticket type (no API call) – and the ticket counts as greeted. */
async function greet(channel, type) {
  const msg = await sendReply(channel, GREETINGS[type?.id] ?? GREETINGS.default, { counted: false }).catch((err) => (console.warn('[asystent] powitanie:', err.message), null));
  patchAi(channel.id, { greeted: true });
  return msg;
}

/** "typing…" while the model works – started only when there really is something to answer. */
function startTyping(channel) {
  const typing = () => channel.sendTyping?.()?.catch?.(() => null);
  typing();
  const interval = setInterval(typing, timing.typing);
  interval.unref?.();
  return () => clearInterval(interval);
}

async function answer(channel) {
  const guild = channel.guild;
  const ticket = db.getTicket(channel.id);
  if (!ticket || ticket.status !== 'open' || !ticket.ai?.active) return;
  if (humanTookOver(ticket)) return stop(channel, 'staff');
  if (!activeIn(guild.id)) return paused() && globallyOn(guild.id) ? takeBreak(channel) : undefined; // a break began meanwhile
  const type = config.getType(ticket.typeId);
  const budget = ai.budget();
  // More than the turns kept: the ticket's own cards and notices are in the channel too.
  const list = await channel.messages.fetch({ limit: Math.min(50, budget.history * 3) }).catch(() => null);
  const convo = buildConversation(guild, ticket, type, list ? [...list.values()].reverse() : [], budget);
  if (!convo) return;
  if ((ticket.ai.replies ?? 0) >= MAX_REPLIES) return escalate(channel, { reason: `Asystent AI wykorzystał limit ${MAX_REPLIES} odpowiedzi w tym tickecie.`, source: 'limit' });
  if (recentReplies(ticket.ownerId) >= HOURLY_CAP) return escalate(channel, { reason: `Autor dostał już ${HOURLY_CAP} odpowiedzi asystenta w ciągu godziny.`, source: 'limit' });

  const ctx = { guild, channel, ticket, type, ownerId: ticket.ownerId, botId: guild.client?.user?.id ?? null, escalated: false };
  ctx.escalate = async (reason, opts = {}) => {
    ctx.escalated = true;
    // A prize to hand out always reaches the team – each prize in its own notice, even right after another one.
    await escalate(channel, { reason, source: opts.prize ? 'prize' : 'ai', force: Boolean(opts.prize) });
    if (opts.prize) await refreshPanel(channel);
  };
  ctx.deliverCode = async (granted) => {
    const dm = await deliverCode(channel, ticket, granted);
    await refreshPanel(channel); // the claim buttons above follow
    return dm;
  };

  let outcome;
  const s = state(channel.id);
  // The opening answer (the form, nothing said yet): when it can't be had, the fixed greeting instead of an error.
  const opening = !ticket.ai.greeted && !(ticket.ai.msgIds ?? []).length;
  s.stopTyping = startTyping(channel);
  try {
    outcome = await converse(convo.messages, ctx);
  } catch (err) {
    s.stopTyping?.();
    return opening ? openingFailed(channel, err) : failed(channel, err);
  }
  s.stopTyping?.();
  const answered = () => patchAi(channel.id, { answeredUpTo: convo.newestOwnerId ?? ticket.ai.answeredUpTo ?? null, greeted: true, failures: 0 });
  if (outcome.kind === 'cut') return opening ? openingFailed(channel, null) : failed(channel, null); // nothing usable – those messages stay unanswered
  if (outcome.trimmed) console.warn(`[asystent] odpowiedź uciął limit tokenów dostawcy – w tickecie #${pad(ticket.number)} wysyłam tylko jej pełne zdania.`);
  if (outcome.kind === 'escalated') return answered(); // the team was called (and said so) from inside the tool loop
  // Every other outcome posts something: only when the ticket is still open and no staff member took over meanwhile.
  if (!stillAnswering(channel)) return;
  if (outcome.kind === 'refusal' || outcome.kind === 'limit') {
    answered();
    const reason = outcome.kind === 'refusal' ? 'Asystent AI nie może pomóc w tej sprawie – potrzebny ktoś z zespołu.' : 'Asystent AI nie poradził sobie z odpowiedzią.';
    return escalate(channel, { reason, source: outcome.kind === 'refusal' ? 'refusal' : 'error' });
  }
  if (!outcome.text) return answered(); // a tool already did the talking (e.g. posted the code)
  if (await sendReply(channel, outcome.text)) {
    answered(); // only now – a reply that never got out leaves the messages unanswered
    noteReply(ticket.ownerId);
    knowledge.noteUsed(guild.id, convo.matches); // /wiedza lista shows which entries are used at all
  }
}

async function run(channel) {
  const s = state(channel.id);
  s.running = true;
  try {
    await answer(channel);
  } catch (err) {
    console.error('[asystent]', err);
  } finally {
    s.running = false;
    s.stopTyping?.();
    const ticket = db.getTicket(channel.id);
    if (ticket?.status !== 'open') channels.delete(channel.id); // closed or deleted meanwhile – nothing left to do here
    else if (s.again) {
      s.again = false;
      schedule(channel, timing.debounce);
    }
  }
}

// ───────────── Errors ─────────────

/**
 * 'transient' (try again) | 'limit' (a free plan's limit – a break) | 'auth' (key rejected) | 'model' (unknown model) |
 * 'config' (Claude: key / model) | 'billing' (Claude: no credits) | 'request' (400 – a bug) | 'bug'.
 */
function classify(err) {
  if (err instanceof ProviderError) {
    return { 'rate-limit': 'limit', auth: 'auth', model: 'model', 'bad-request': 'request', 'too-large': 'request' }[err.kind] ?? 'transient';
  }
  const A = ai.Anthropic();
  if (!err || !A) return 'bug';
  if (err instanceof A.AuthenticationError || err instanceof A.PermissionDeniedError || err instanceof A.NotFoundError) return 'config';
  if (err instanceof A.BadRequestError) return 'request';
  if (err instanceof A.RateLimitError || err instanceof A.InternalServerError || err instanceof A.APIConnectionError) return 'transient';
  if (err instanceof A.APIError) return err.type === 'billing_error' || err.status === 402 ? 'billing' : 'transient';
  return 'bug';
}

const errorText = (err) => (err ? truncate(`${err.constructor?.name ?? 'Error'}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message ?? ''}`, 300) : 'odpowiedź ucięta (max_tokens)');

/** "18:05" – or „ponownego uruchomienia bota” for a break only .env and a restart can end. */
const untilText = (p) => (forever(p) ? 'ponownego uruchomienia bota' : new Date(p?.until ?? Date.now()).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }));

/** One clear console line for the owner when the assistant has to take a break. */
function announcePause(kind, err) {
  const who = ai.label();
  const until = untilText(paused());
  const keyVar = ai.KEY_VARS[ai.provider()] ?? 'klucz';
  const chain = ai.models();
  const names = chain.length > 1 ? `żaden z modeli (${chain.join(', ')})` : `model „${chain[0] ?? ai.model()}”`;
  const lines = {
    limit:
      chain.length > 1
        ? `🤖 Asystent AI (${who}): wszystkie modele (${chain.join(', ')}) wyczerpały darmowy limit – przerwa do ${until}. W tym czasie tickety działają bez AI (nagrody przyciskami, „człowiek” woła zespół).`
        : `🤖 Asystent AI (${who}): skończył się darmowy limit – przerwa do ${until}. W tym czasie tickety działają bez AI (nagrody przyciskami, „człowiek” woła zespół).`,
    auth: `🤖 Asystent AI (${who}): klucz został odrzucony (HTTP ${err?.status ?? '?'}) – sprawdź ${keyVar} w .env i uruchom bota ponownie. Asystent wstrzymany do ${until}.`,
    model:
      ai.provider() === 'groq'
        ? `🤖 Asystent AI (Groq): ${names} nie działa na Twoim koncie (nie istnieje, został wycofany albo jest wyłączony w ustawieniach Groq). Wybierz aktualne modele z https://console.groq.com/docs/models i wpisz je w .env jako AI_MODEL=… (kilka po przecinku), potem uruchom bota ponownie. Asystent wstrzymany do ${until}.`
        : `🤖 Asystent AI (${who}): dostawca nie zna modelu „${ai.model()}” – popraw AI_MODEL w .env i uruchom bota ponownie. Asystent wstrzymany do ${until}.`,
    config: `🤖 Asystent AI: Claude API odrzuciło klucz ANTHROPIC_API_KEY albo nie zna modelu AI_MODEL – popraw .env i uruchom bota ponownie. Asystent wstrzymany do ${until}.`,
    billing: `🤖 Asystent AI: brak środków na koncie Anthropic (console.anthropic.com → Billing) – asystent wstrzymany do ${until}.`,
  };
  console.error(lines[kind]);
}

/** How long a break lasts: a free limit as long as the provider says; a key or model only .env fixes – until a restart. */
const breakLength = (kind, err) => (kind === 'limit' ? err?.retryAfterMs ?? 60_000 : kind === 'billing' ? KEY_PAUSE_MS : Infinity);

/**
 * What every failed request does, whichever answer it was for: classify it, start a break for every ticket when it is
 * one (said once in the console), and a line in the ticket log. attempt: the ticket log's "Próba" text. → { kind, breaks }
 */
async function noteFailure(channel, err, attempt) {
  const kind = err ? classify(err) : 'transient';
  const breaks = BREAKS.includes(kind);
  const fresh = breaks && !paused(); // the first ticket that runs into it says so in the console
  if (breaks) pauseFor(kind, breakLength(kind, err));
  if (fresh) announcePause(kind, err);
  else if (!breaks && kind !== 'transient') console.error('[asystent] błąd odpowiedzi:', err);
  else if (!breaks) console.warn('[asystent] chwilowy błąd:', errorText(err));

  const ticket = db.getTicket(channel.id);
  await sendTicketLog(channel.guild, {
    embeds: [
      logEmbed(COLORS.danger, kind === 'limit' ? '⏸️ Asystent AI: skończył się darmowy limit' : '⚠️ Asystent AI: błąd').addFields(
        { name: 'Ticket', value: `${channel} (\`#${pad(ticket?.number ?? 0)}\`)`, inline: true },
        { name: breaks ? 'Przerwa do' : 'Próba', value: breaks ? (forever(paused()) ? 'ponownego uruchomienia bota' : ts(paused()?.until ?? Date.now(), 'f')) : attempt, inline: true },
        { name: 'Błąd', value: errorText(err) },
      ),
    ],
  });
  return { kind, breaks };
}

async function failed(channel, err) {
  const failures = (db.getTicket(channel.id)?.ai?.failures ?? 0) + 1;
  if (db.getTicket(channel.id)?.status === 'open') patchAi(channel.id, { failures });
  const { kind, breaks } = await noteFailure(channel, err, `${failures} z ${MAX_FAILURES}`);
  // The break is for every ticket; what is said here only if the ticket is still open and no staff member took over.
  if (!stillAnswering(channel)) return;
  if (breaks) return takeBreak(channel, kind);
  if (kind === 'transient' && failures < MAX_FAILURES) {
    await channel
      .send({ content: `⚠️ Mam chwilowy problem z odpowiedzią. Napisz proszę jeszcze raz za chwilę – albo napisz „człowiek”, a zawołam zespół.\n${format.signature(channel.guild)}`, allowedMentions: { parse: [] } })
      .catch(() => null);
    return;
  }
  await escalate(channel, { reason: 'Asystent AI ma problem techniczny i nie może teraz odpowiedzieć.', source: 'error' });
}

/**
 * The opening answer couldn't be had (an error, every model's free limit used up, nothing usable): the ticket gets the
 * fixed greeting instead – no error notice and no ping for a ticket that has just opened. The break, if it is one,
 * starts as usual: the author's first message then gets the break notice (which calls the team) – or, once the break
 * is over, an answer.
 */
async function openingFailed(channel, err) {
  await noteFailure(channel, err, 'odpowiedź na formularz przy otwarciu ticketu');
  const ticket = stillAnswering(channel);
  if (!ticket || ticket.ai?.greeted) return;
  await greet(channel, config.getType(ticket.typeId));
  if (ticket.typeId === 'reward' && !db.getTicket(channel.id)?.ai?.panelId) await showRewardPanel(channel); // the greeting points to it
}

/**
 * The assistant has a break (every model's free limit used up, a rejected key or model) while a ticket waits for it:
 * one notice in the ticket that also calls the team, and in a „Odbierz nagrodę” ticket the claim buttons, so a winner
 * doesn't have to wait. Once per ticket per break; when the break is over, the assistant answers there again.
 */
async function takeBreak(channel, kind = paused()?.reason) {
  const ticket = db.getTicket(channel.id);
  const p = paused();
  const stopped = ticket?.ai?.stopped;
  if (!ticket || ticket.status !== 'open' || (stopped && stopped !== 'break')) return;
  if (humanTookOver(ticket)) return stop(channel, 'staff'); // staff are here – they don't need the break notice
  if (stopped === 'break' && p && ticket.ai.breakSince === p.since) return; // told already about this break
  patchAi(channel.id, { breakSince: p?.since ?? Date.now() });
  await escalate(channel, {
    reason: kind === 'limit' ? 'Skończył się darmowy limit asystenta AI.' : 'Asystent AI ma przerwę (problem z kluczem albo modelem AI).',
    source: kind === 'limit' ? 'free-limit' : 'error',
    stopAs: 'break',
    force: true,
    lead: kind === 'limit' ? LIMIT_TEXT : 'Asystent AI ma teraz przerwę – po stronie bota jest problem techniczny. Zawołałem zespół, ktoś zaraz odpisze.',
  });
  if (ticket.typeId === 'reward' && !db.getTicket(channel.id)?.ai?.panelId) await showRewardPanel(channel);
}

// ───────────── Calling the team ─────────────

const SOURCES = {
  ai: 'decyzja asystenta',
  keyword: 'autor poprosił o człowieka',
  button: 'przycisk „Zawołaj zespół”',
  prize: 'nagroda do wydania ręcznie',
  refusal: 'asystent nie mógł pomóc',
  limit: 'limit odpowiedzi',
  'free-limit': 'skończył się darmowy limit AI',
  error: 'błąd asystenta',
};

/** The founder, co-owner and support roles plus the ticket type's own staff roles – who gets the ping. */
function pingRoles(guild, type) {
  const keys = ['founder', 'coowner', 'support', ...(type?.staffRoles ?? [])];
  const ids = [...keys.map((k) => db.roleId(guild.id, k)), ...(type?.staffRoleIds ?? [])].filter((id) => id && guild.roles.cache.has(id));
  const list = ids.length ? ids : perms.alertRoleIds(guild.id, type).filter((id) => guild.roles.cache.has(id));
  return [...new Set(list)];
}

/** "Calling the team": a ping in the ticket, "help is coming", the assistant off here. → false when the team was just called. */
/**
 * stopAs: 'escalated' (the team takes it from here) or 'break' (the assistant comes back after its break).
 * lead: the notice's own text instead of the usual one (the break notice). force: post even if the team was just called.
 */
async function escalate(channel, { reason = '', source = 'ai', force = false, stopAs = 'escalated', lead = null, quiet = false } = {}) {
  const guild = channel.guild;
  const ticket = db.getTicket(channel.id);
  if (!ticket) return false;
  clearTimer(channel.id);
  const handOff = source === 'prize'; // a prize to hand out must reach the team whatever else happened
  const asked = source === 'keyword' || source === 'button'; // the author asked for a person themselves
  if (ticket.status !== 'open') {
    if (handOff) await logEscalation(channel, ticket, source, reason); // closed meanwhile – at least the log knows
    return false;
  }
  // Staff took over (wrote, claimed, switched the assistant off): the assistant's own calls stay silent and never
  // overwrite that – only a prize hand-off or the author's own request still gets through.
  const staffHere = staffHave(ticket);
  if (staffHere && !handOff && !asked) return false;
  const before = ticket.ai ?? {};
  const again = before.escalatedAt && Date.now() - before.escalatedAt < ESCALATE_AGAIN_MS;
  patchAi(channel.id, { ...(!staffHere && { active: false, stopped: stopAs }), escalatedAt: again && !force ? before.escalatedAt : Date.now() });
  if (again && !force) {
    // The team was called a moment ago – no second ping, but the author still gets an answer.
    if (!quiet) await channel.send(notice(COLORS.muted, '🙋 Zespół jest już powiadomiony – ktoś zaraz tu odpisze.')).catch(() => null);
    return false;
  }

  const type = config.getType(ticket.typeId);
  const roles = pingRoles(guild, type);
  const users = ticket.claimedBy ? [ticket.claimedBy] : [];
  const who = [...users.map((id) => `<@${id}>`), ...roles.map((id) => `<@&${id}>`)].join(' ') || 'Zespół';
  const why = truncate(clean(reason).replace(/\n+/g, ' '), 300);
  const aiWasHere = before.mode !== 'noai' || before.active; // in a ticket without AI there is nothing to switch back on
  const canResume = aiWasHere && stopAs !== 'break' && !unavailableText();
  const body = lead
    ? `### ⏸️ Przerwa asystenta AI\n${lead}\n-# 🔔 ${who}`
    : `### 🙋 Wołam zespół\n${who} – <@${ticket.ownerId}> potrzebuje pomocy.\n${why ? `> ${why}\n` : ''}Zawołałem zespół – ktoś odpisze tutaj, gdy tylko będzie dostępny. 🧡` +
      (aiWasHere ? '\n-# 🤖 Asystent AI nie odpowiada już w tym tickecie.' : '');
  await channel
    .send(notice(lead ? COLORS.muted : COLORS.warning, body, { mentions: { roles, users }, buttons: canResume ? [btn('ai:on', 'Włącz asystenta ponownie', '🤖')] : [] }))
    .catch((err) => console.warn('[asystent] nie udało się zawołać zespołu:', err.message));
  await logEscalation(channel, ticket, source, why);
  return true;
}

async function logEscalation(channel, ticket, source, reason) {
  const owner = await channel.guild.client.users.fetch(ticket.ownerId).catch(() => null);
  await sendTicketLog(channel.guild, {
    embeds: [
      logEmbed(COLORS.warning, '🙋 Asystent AI wezwał zespół', owner).addFields(
        { name: 'Ticket', value: `${channel} (\`#${pad(ticket.number)}\`)`, inline: true },
        { name: 'Autor', value: `<@${ticket.ownerId}>`, inline: true },
        { name: 'Dlaczego', value: SOURCES[source] ?? source, inline: true },
        { name: 'Powód', value: truncate(clean(reason).replace(/\n+/g, ' '), 300) || '—' },
      ),
    ],
  });
}

// ───────────── Prizes ─────────────

/**
 * A Hammer+ code from a giveaway: by DM, in the ticket (saying whether the DM got through), the 💎 role, and a line in
 * the ticket log (never the code). → true when the DM got through.
 */
async function deliverCode(channel, ticket, { code, record, days, gw }) {
  const guild = channel.guild;
  const howTo = 'Wpisz go w Hammer Launcherze: **Hammer+ → „Mam kod”** → wklej → **Aktywuj**.';
  const where = `-# Kod działa tylko na koncie Minecraft \`${record.nick}\` · ważny ${hammerplus.validity(record.exp)}`;
  const owner = await guild.client.users.fetch(ticket.ownerId).catch(() => null);
  const dm = Boolean(
    await owner
      ?.send?.(notice(COLORS.success, `## 🎁 Hammer+ z giveawayu na ${guild.name}\nGratulacje! Nagroda z giveawayu **${gw.prize}** – Twój kod:\n\`\`\`\n${code}\n\`\`\`\n${howTo}\n${where}`))
      ?.then?.(() => true, () => false),
  );
  if (gw.claims?.[ticket.ownerId]) {
    gw.claims[ticket.ownerId].dm = dm; // „where is my code?” later says where it really went
    db.save();
  }
  const copy = dm ? ' · wysłaliśmy go też w wiadomości prywatnej.' : '\n⚠️ Nie udało się wysłać kodu w wiadomości prywatnej (masz zamknięte DM) – **zachowaj go z tego ticketu**.';
  // The prize is already written down as claimed – a failed post must not look like "nothing happened" to the model.
  await channel
    .send(
      notice(COLORS.success, `## 🎁 Twoja nagroda: Hammer+ ${prizes.plusLength(days)}\n<@${ticket.ownerId}>, gratulacje wygranej w giveawayu **${gw.prize}**! Oto Twój kod:\n\`\`\`\n${code}\n\`\`\`\n${howTo}\n${where}${copy}`, {
        mentions: { users: [ticket.ownerId] },
      }),
    )
    .catch((err) => console.warn('[asystent] nie udało się wysłać kodu Hammer+ w tickecie:', err.message));
  const role = await require('./plusrole').sync(guild, ticket.ownerId).catch(() => 'failed');
  await sendTicketLog(guild, {
    embeds: [
      logEmbed(COLORS.success, '🎁 Asystent AI wydał nagrodę', owner).addFields(
        { name: 'Ticket', value: `${channel} (\`#${pad(ticket.number)}\`)`, inline: true },
        { name: 'Zwycięzca', value: `<@${ticket.ownerId}>`, inline: true },
        { name: 'Giveaway', value: truncate(`${gw.prize} (\`${gw.id}\`)`, 1024), inline: true },
        { name: 'Hammer+', value: `\`${record.nick}\` · ${hammerplus.validity(record.exp)} · ID \`${record.id}\``, inline: true },
        { name: 'Ranga 💎', value: role === 'added' || role === 'kept' ? 'nadana' : role === 'not-member' ? 'nie ma go na serwerze' : '—', inline: true },
        { name: 'DM z kodem', value: dm ? 'wysłany' : 'nie doszedł (zamknięte DM) – kod jest tylko w tickecie', inline: true },
      ),
    ],
  });
  return dm;
}

// ───────────── No-AI mode: prizes with buttons ─────────────

const PRIZE_ERRORS = {
  'not-found': 'Tego giveawayu już nie ma.',
  'not-ended': 'Ten giveaway jeszcze trwa – zwycięzców bot wylosuje, gdy skończy się czas.',
  'not-winner': 'Nie wygrałeś/aś tego giveawayu, więc nie możesz odebrać tej nagrody.',
  busy: 'Ta nagroda jest właśnie wydawana – poczekaj chwilę.',
  rerolled: 'Po ponownym losowaniu ta nagroda przeszła na inną osobę, więc nie możesz już jej odebrać. Jeśli to pomyłka, kliknij „Zawołaj zespół”.',
};

/** channelId: the ticket asking – so „where is the code” points to the right place. */
function prizeError(r, channelId = null) {
  if (r.result !== 'already') return PRIZE_ERRORS[r.result] ?? 'Nie udało się odebrać nagrody.';
  if (r.claim.status !== 'granted') return 'Ta nagroda jest już zgłoszona zespołowi – wyda ją ręcznie.';
  const where = !r.claim.ticket ? 'w tickecie, w którym ją odebrano' : r.claim.ticket === channelId ? 'wyżej w tym tickecie' : `w tickecie <#${r.claim.ticket}>`;
  return `Ta nagroda została już odebrana – kod Hammer+ dla konta \`${r.claim.nick}\` jest ${where}${r.claim.dm ? ' i w Twoich wiadomościach prywatnych' : ''}.`;
}

/** The author's unclaimed wins, a claim button each (prizes.js decides what can be claimed). after: right after a claim. */
function rewardPanel(guild, ticket, { after = false } = {}) {
  const list = prizes.claimable(guild.id, ticket.ownerId).slice(0, 10);
  if (!list.length) {
    return after
      ? notice(COLORS.success, '### ✅ Nagrody odebrane\nKody i zgłoszenia znajdziesz wyżej w tym tickecie.')
      : notice(COLORS.muted, '### 🔍 Nie znalazłem Twojej wygranej\nNa tym koncie Discord nie ma nieodebranej nagrody z giveawayu. Jeśli to pomyłka, zespół to sprawdzi i odpisze tutaj.');
  }
  const lines = list.map((gw) => {
    const prize = prizes.prizeOf(gw);
    const late = Date.now() > prizes.claimDeadline(gw, ticket.ownerId);
    const how = late ? 'minęło 48 h – o wydaniu zdecyduje zespół' : prize.kind === 'plus' ? `kod Hammer+ od razu (${prizes.plusLength(prize.days)})` : 'wyda zespół';
    return `> 🎁 **${gw.prize}** · ${how}`;
  });
  const c = container(COLORS.brand);
  c.addTextDisplayComponents(
    text(`## 🎁 Twoje wygrane\n${lines.join('\n')}\n-# Kliknij przycisk przy nagrodzie. Hammer+ wydajemy od razu – podasz tylko nick Minecraft (Java Edition). Inne nagrody wyda zespół.`),
  );
  const buttons = [...list.map((gw) => btn(`ai:claim:${gw.id}`, truncate(`Odbierz: ${gw.prize}`, 80), '🎁', ButtonStyle.Success)), btn('ai:human', 'Zawołaj zespół', '🙋')];
  for (let i = 0; i < buttons.length; i += 5) c.addActionRowComponents(row(...buttons.slice(i, i + 5)));
  return v2(c);
}

async function showRewardPanel(channel) {
  const ticket = db.getTicket(channel.id);
  if (!ticket) return null;
  const msg = await channel.send(rewardPanel(channel.guild, ticket)).catch((err) => (console.warn('[asystent] lista nagród:', err.message), null));
  if (msg) patchAi(channel.id, { panelId: msg.id });
  return msg;
}

async function refreshPanel(channel) {
  const ticket = db.getTicket(channel.id);
  const msg = ticket?.ai?.panelId ? await channel.messages.fetch(ticket.ai.panelId).catch(() => null) : null;
  await msg?.edit(rewardPanel(channel.guild, ticket, { after: true })).catch(() => null);
}

/** The ticket a claim button / form belongs to – only its author (the winner) may use it. */
function claimTicket(interaction) {
  const ticket = db.getTicket(interaction.channel?.id);
  if (!ticket) throw new UserError('To działa tylko w tickecie.');
  if (ticket.status !== 'open') throw new UserError('Ten ticket jest zamknięty.');
  if (interaction.user.id !== ticket.ownerId) throw new UserError('Nagrodę może odebrać tylko autor ticketu – osoba, która wygrała.');
  return ticket;
}

function nickForm(gwId, ticket) {
  const known = String((ticket.answers ?? []).find((a) => /nick/i.test(a?.label ?? ''))?.value ?? '').trim();
  const { labeledInput } = require('../tickets/tickets'); // here – tickets.js loads features itself
  return new ModalBuilder()
    .setCustomId(`ai:nick:${gwId}`)
    .setTitle('🎁 Odbierz Hammer+')
    .addLabelComponents(
      labeledInput(
        { id: 'nick', label: 'Twój nick w Minecraft (Java Edition)', description: 'Kod Hammer+ zadziała tylko na tym koncie.', style: 'short', placeholder: 'Np. Notch', maxLength: 16 },
        { value: NICK.test(known) ? known : undefined },
      ),
    );
}

/** „Odbierz: …” – a Hammer+ asks for the nick first, any other prize goes to the team at once. */
async function claimButton(interaction, gwId) {
  const ticket = claimTicket(interaction);
  const check = prizes.precheck({ guildId: interaction.guild.id, userId: ticket.ownerId, giveawayId: gwId });
  if (check.result !== 'ok') throw new UserError(prizeError(check, interaction.channel?.id));
  if (check.needsNick) return interaction.showModal(nickForm(check.gw.id, ticket));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return finishClaim(interaction, ticket, check.gw.id, null);
}

async function nickSubmit(interaction, gwId) {
  const ticket = claimTicket(interaction);
  const nick = String(interaction.fields.getTextInputValue('nick') ?? '').trim();
  if (!NICK.test(nick)) throw new UserError('Nick Minecraft ma najwyżej 16 znaków: litery, cyfry i podkreślenie (_).');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // asking Mojang can take a few seconds
  return finishClaim(interaction, ticket, gwId, nick);
}

/** The same hand-out as the AI's odbierz_nagrode: every check in prizes.claim, the code like deliverCode does it. */
async function finishClaim(interaction, ticket, gwId, nick) {
  const channel = interaction.channel;
  const r = await prizes.claim({ guildId: interaction.guild.id, userId: ticket.ownerId, giveawayId: gwId, nick, botId: interaction.client?.user?.id ?? null, channelId: channel.id });
  if (r.result === 'granted') {
    const dm = await deliverCode(channel, ticket, r);
    await refreshPanel(channel);
    return reply(interaction, dm ? `Gotowe! Kod Hammer+ dla konta \`${r.record.nick}\` jest w tickecie i w Twoich wiadomościach prywatnych.` : `Gotowe! Kod Hammer+ dla konta \`${r.record.nick}\` jest w tickecie – wiadomość prywatna nie doszła, więc zachowaj go stamtąd.`);
  }
  if (r.result === 'reported') {
    await escalate(channel, { reason: `Nagroda do wydania ręcznie: „${r.gw.prize}” (giveaway ${r.gw.id}) – ${REPORT_WHY[r.why] ?? r.why}.`, source: 'prize', force: true });
    await refreshPanel(channel);
    return reply(interaction, 'Zgłosiłem nagrodę zespołowi – wyda ją ręcznie. Zespół został zawołany do ticketu.');
  }
  if (r.result === 'bad-nick') throw new UserError(r.error);
  if (r.result === 'need-nick') throw new UserError('Do tej nagrody potrzebny jest nick Minecraft – kliknij przycisk jeszcze raz.');
  throw new UserError(prizeError(r, channel.id));
}

// ───────────── Staff switches ─────────────

/** Staff turn the assistant on / off in one ticket (button or /asystent ticket). */
async function setTicket(channel, on, actor) {
  const ticket = db.getTicket(channel.id);
  if (!ticket) throw new UserError('Tego można użyć tylko na kanale ticketu.');
  if (ticket.status !== 'open') throw new UserError('Ten ticket jest zamknięty.');
  const by = actor?.toString?.() ?? 'zespół';
  if (on) {
    const why = unavailableText() ?? pauseText();
    if (why) throw new UserError(why);
    if (!globallyOn(channel.guild.id)) throw new UserError(`Asystent jest wyłączony na całym serwerze – najpierw \`${slash('assistant on')}\`.`);
    if (!eligible(config.getType(ticket.typeId))) throw new UserError('W tym rodzaju ticketu asystent nie działa.');
    if (ticket.ai?.active) throw new UserError('Asystent już odpowiada w tym tickecie.');
    // Only what the author writes from now on is new – older messages were answered by the team.
    const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    patchAi(channel.id, { mode: 'ai', active: true, stopped: null, failures: 0, resumedAt: Date.now(), resumedAfter: ticket.staffActivityAt ?? 0, escalatedAt: null, greeted: true, answeredUpTo: latest?.first?.()?.id ?? ticket.ai?.answeredUpTo ?? null, replies: 0 });
  } else {
    // Off also while it has a break or waits for the AI to come back – otherwise it would start answering by itself.
    const couldAnswer = ticket.ai?.active || ticket.ai?.stopped === 'break' || (ticket.ai?.mode === 'noai' && !ticket.ai?.stopped);
    if (!couldAnswer) throw new UserError('Asystent nie odpowiada w tym tickecie.');
    stop(channel, 'manual');
  }
  await channel.send(notice(on ? COLORS.brand : COLORS.muted, on ? `🤖 Asystent AI znów odpowiada w tym tickecie – włącza go ${by}.` : `🔕 Asystent AI nie odpowiada już w tym tickecie – wyłącza go ${by}.`)).catch(() => null);
  await sendTicketLog(channel.guild, {
    embeds: [logEmbed(on ? COLORS.brand : COLORS.muted, on ? '🤖 Asystent AI włączony w tickecie' : '🔕 Asystent AI wyłączony w tickecie', actor?.user ?? actor).setDescription(`${by} · ${channel} (\`#${pad(ticket.number)}\`)`)],
  });
}

/** For /asystent status. */
function status(guild, channel = null) {
  const open = db.tickets((t) => t.guildId === guild.id && t.status === 'open');
  const ticket = channel ? db.getTicket(channel.id) : null;
  return {
    problem: unavailableText(),
    provider: ai.provider(),
    providerLabel: ai.label(),
    pause: paused(),
    pauseText: pauseText(),
    model: ai.model(),
    chain: ai.problem() ? [] : models.describe(ai.models()),
    global: globallyOn(guild.id),
    activeTickets: open.filter((t) => t.ai?.active).length,
    ticket: ticket ? { open: ticket.status === 'open', ...(ticket.ai ?? {}) } : null,
    maxReplies: MAX_REPLIES,
    knowledge: knowledge.stats(guild.id),
  };
}

// ───────────── Events ─────────────

hooks.on('ticketOpened', async ({ guild, channel, ticket, type }) => {
  if (!guild || !channel || !ticket || !profile.launcher || !eligible(type)) return;
  if (activeIn(guild.id)) {
    const compact = ai.compact();
    patchAi(channel.id, { mode: 'ai', active: true, stopped: null, replies: 0, msgIds: [], failures: 0, greeted: false, answeredUpTo: null, since: Date.now() });
    // Free providers spend a request only where there is a question: a „Odbierz nagrodę” ticket has its claim buttons
    // (they cost nothing and never get it wrong), a form without a question gets the fixed greeting.
    if (compact && (type.id === 'reward' || !hasQuestion(ticket))) {
      await greet(channel, type);
      if (type.id === 'reward') await showRewardPanel(channel);
      return;
    }
    return schedule(channel, timing.open); // the form is the first question – answered right away
  }
  // No-AI mode (no key, a break, or switched off): prizes with buttons, „człowiek” still calls the team.
  patchAi(channel.id, { mode: 'noai', active: false, stopped: null, since: Date.now() });
  if (type.id === 'reward') await showRewardPanel(channel);
});

async function onMessage(message) {
  if (!message.guild || !message.author || message.author.bot) return;
  const ticket = db.getTicket(message.channel?.id);
  if (!ticket?.ai || ticket.status !== 'open') return;
  // stopped: a human took over, the team was called or staff switched it off – the bot stays out of it. Only a break
  // ('break') ends by itself.
  const stopped = ticket.ai.stopped;
  if (stopped && stopped !== 'break') return;
  const channel = message.channel;
  if (message.author.id !== ticket.ownerId) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (isStaff(member, config.getType(ticket.typeId))) stop(channel, 'staff'); // a human took over
    return;
  }
  if (humanTookOver(ticket)) return stop(channel, 'staff');
  if (asksForHuman(message.content)) {
    // With or without AI; called a moment ago (e.g. by the break notice) → no second ping, but an answer.
    await escalate(channel, { reason: 'Autor ticketu prosi o rozmowę z kimś z zespołu.', source: 'keyword' });
    return;
  }
  if (!ticket.ai.active) {
    if (!activeIn(message.guild.id)) return; // no AI (yet), or the break goes on – the team was told already
    // The break is over, or the AI came back (a ticket opened without it): answer from here on.
    patchAi(channel.id, { mode: 'ai', active: true, stopped: null, failures: 0, greeted: true, escalatedAt: null }); // a fresh start: the break's ping doesn't count against the next call
    return schedule(channel, timing.debounce);
  }
  if (activeIn(message.guild.id)) return schedule(channel, timing.debounce);
  if (paused() && globallyOn(message.guild.id)) await takeBreak(channel); // it answered here before – say why it doesn't now
}
hooks.on('messageCreate', (message) => onMessage(message).catch((err) => console.warn('[asystent]', err.message)));

// A closed or deleted ticket: no waiting answer, no "typing…"; an answer already on its way is dropped (stillAnswering).
hooks.on('ticketClosed', ({ channel, ticket }) => {
  const s = channels.get(channel?.id);
  if (s) {
    clearTimer(channel.id);
    s.stopTyping?.();
    if (!s.running) channels.delete(channel.id);
  }
  if (ticket?.ownerId && !recentReplies(ticket.ownerId)) repliesTo.delete(ticket.ownerId); // nothing left to count
});

hooks.route('ai', {
  async button(interaction, action, args = []) {
    if (action === 'claim') return claimButton(interaction, args[0]);
    const ticket = db.getTicket(interaction.channel?.id);
    if (!ticket) throw new UserError('To działa tylko w tickecie.');
    const staff = isStaff(interaction.member, config.getType(ticket.typeId));
    if (action === 'human') {
      if (interaction.user.id !== ticket.ownerId && !staff) throw new UserError('Ten przycisk jest dla autora ticketu.');
      if (ticket.status !== 'open') throw new UserError('Ten ticket jest zamknięty.');
      if (ticket.ai?.stopped === 'staff') return reply(interaction, 'Ktoś z zespołu już zajmuje się Twoim ticketem – odpowie tutaj.');
      const called = await escalate(interaction.channel, { reason: 'Autor ticketu kliknął „Zawołaj zespół”.', source: 'button', quiet: true });
      return reply(interaction, called ? 'Zespół został zawołany – zaraz ktoś Ci pomoże.' : 'Zespół jest już powiadomiony – zaraz ktoś Ci pomoże.');
    }
    if (action !== 'on' && action !== 'off') return null;
    if (!staff) throw new UserError('Asystenta w tickecie może włączyć albo wyłączyć tylko zespół.');
    await setTicket(interaction.channel, action === 'on', interaction.member);
    return reply(interaction, action === 'on' ? 'Asystent AI znów odpowiada w tym tickecie.' : 'Asystent AI wyłączony w tym tickecie.');
  },
  async modal(interaction, action, args = []) {
    if (action === 'nick') return nickSubmit(interaction, args[0]);
    return null;
  },
});

hooks.on('ready', () => {
  if (!profile.launcher) return;
  // The team's questions and answers come from /wiedza; the file is an optional extra – an empty one on the first start
  // (it is not in the bot's package – an update never overwrites what the team wrote there).
  if (knowledge.ensure()) console.log(`🤖 Asystent AI: utworzono pusty plik ${path.basename(knowledge.DEFAULT_FILE)} (nieobowiązkowy) – pytania i odpowiedzi zespołu najprościej dodasz komendą /wiedza dodaj.`);
  const p = ai.problem();
  if (p === 'no-key') {
    console.warn('🤖 Asystent AI: brak klucza w .env – asystent w ticketach jest wyłączony. Nagrody z giveawayów odbiera się przyciskami, a „człowiek” woła zespół. Darmowy klucz: GROQ_API_KEY z console.groq.com (README → „Asystent AI w ticketach”).');
  } else if (p) console.warn(`🤖 Asystent AI jest wyłączony: ${PROBLEMS[p].replace(/`/g, '')}`);
  else if (ai.provider() === 'claude') console.log(`🤖 Asystent AI w ticketach: ${ai.label()} · model ${ai.model()} · odmowy obsługuje model zapasowy.`);
  else console.log(`🤖 Asystent AI w ticketach: ${ai.label()} · modele po kolei (gdy jednemu skończy się limit, odpowiada następny): ${ai.models().join(', ')}.`);
});

// ───────────── Tests ─────────────

/** Waits until no answer is scheduled or running. */
async function settle() {
  for (let i = 0; i < 100; i += 1) {
    const waiting = [...channels.values()].some((s) => s.timer || s.running);
    if (!waiting && !pending.size) return;
    await Promise.all([...pending]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(timing.debounce, timing.open) + 2));
  }
}

/** Tests: how many tickets have an answer waiting or running. */
const _waiting = () => [...channels.values()].filter((s) => s.timer || s.running).length;

function _reset() {
  for (const id of channels.keys()) clearTimer(id);
  channels.clear();
  repliesTo.clear();
  pause = null;
  models.reset();
}

module.exports = {
  setClient: ai.setClient,
  available,
  paused,
  pauseText,
  rewardPanel,
  activeIn,
  globallyOn,
  setGlobal,
  setTicket,
  status,
  escalate,
  unavailableText,
  buildConversation,
  request,
  echoable,
  classify,
  settle,
  timing,
  _reset,
  _waiting,
  MAX_REPLIES,
  HOURLY_CAP,
};
