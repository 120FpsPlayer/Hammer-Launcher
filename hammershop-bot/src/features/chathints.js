'use strict';

/**
 * Chat hints (config.chatHints – on for the Hammer Launcher server): when someone in the chat asks one of the usual
 * questions – where to download the launcher, the game doesn't start, Hammer+, mods / FPS, signing in – the bot answers
 * once with a short pointer to the right channel. No AI: plain word patterns from the config.
 *
 *   matching   the message is simplified first: lower case, no Polish letters („pobrać” → „pobrac”, „ł” → „l”), a letter
 *              typed three or more times counts once („dzialaaa” → „dziala”), links, mentions and emojis out, single
 *              spaces with one at both ends, „?” on its own. A topic's patterns (regular expressions; {name} = a word
 *              group from chatHints.words, so the many spellings of „launcher” are written once) are checked on that. A
 *              topic answers only a message that also looks like a question or a call for help (chatHints.question) –
 *              unless it says "question": false because its patterns already need launcher / game words – and never
 *              one its "not" pattern matches („już działa”, another game…). The first topic that fits answers.
 *   not spammy once per person per topic per userCooldownMinutes, once per channel per topic per
 *              channelCooldownMinutes; never for the team, a bot, in a ticket, outside chatHints.channels, or on a
 *              message the chat filter takes down. The hint is a reply that pings nobody, with a „To nie to” button
 *              (dismissButton) – the person who asked, or the team, can take it away.
 *   texts      {#key} → that channel (#pobierz, #tickety…), {site} → the website's address (a line with it is left out
 *              while PUBLIC_URL is not set), {brand} → the server's name.
 */

const config = require('../lib/config');
const db = require('../lib/db');
const hooks = require('../lib/hooks');
const { env } = require('../env');
const { isStaff } = require('../lib/permissions');
const { COLORS } = require('../lib/theme');
const { replyError } = require('../lib/utils');
const { container, text, btn, row, v2 } = require('../lib/v2');

const settings = () => config.chatHints ?? {};
const MAX_LENGTH = 400; // a long message is a conversation, not a quick question

/** The text the patterns are checked on – see the top of this file. */
function simplify(input) {
  const s = String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<a?:\w+:\d+>|<(?:@[!&]?|#)\d+>|<t:\d+(?::\w)?>/g, ' ') // custom emojis, mentions, timestamps
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // ą → a, ż → z
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/[?]+/g, ' ? ')
    .replace(/[^a-z0-9?+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${s} `;
}

// ── The config, compiled once per change ──
const warned = new Set();
function warnOnce(where, err) {
  if (warned.has(where)) return;
  warned.add(where);
  console.warn(`[podpowiedzi] config.chatHints → ${where}: zły wzorzec (${err.message}) – pomijam go.`);
}

let compiled = null;
let compiledFor = null;
function rules() {
  const cfg = settings();
  const key = JSON.stringify([cfg.question, cfg.words, cfg.topics]);
  if (compiled && compiledFor === key) return compiled;
  const words = cfg.words ?? {};
  // {name} → (?:the word group); a group may use another one (three levels deep is plenty).
  const expand = (src) => {
    let out = String(src ?? '');
    for (let i = 0; i < 3; i += 1) out = out.replace(/\{([a-z][a-z0-9_]*)\}/gi, (token, name) => (Object.hasOwn(words, name) ? `(?:${words[name]})` : token));
    return out;
  };
  const rx = (src, where) => {
    if (!src) return null;
    try {
      return new RegExp(expand(src));
    } catch (err) {
      warnOnce(where, err);
      return null;
    }
  };
  compiled = {
    question: rx(cfg.question, 'question'),
    topics: (Array.isArray(cfg.topics) ? cfg.topics : []).map((t, i) => {
      const id = String(t?.id ?? `temat-${i + 1}`);
      return {
        id,
        text: String(t?.text ?? '').trim(),
        patterns: (Array.isArray(t?.patterns) ? t.patterns : []).map((p, j) => rx(p, `topics[${id}].patterns[${j}]`)).filter(Boolean),
        not: rx(t?.not, `topics[${id}].not`),
        question: t?.question !== false,
      };
    }).filter((t) => t.text && t.patterns.length),
  };
  compiledFor = key;
  return compiled;
}

/** The topic a message asks about → { id, text, … } or null. */
function match(content) {
  const s = simplify(content);
  if (s.trim().length < 4) return null;
  const { question, topics } = rules();
  const asks = Boolean(question?.test(s));
  return topics.find((t) => (asks || !t.question) && !t.not?.test(s) && t.patterns.some((p) => p.test(s))) ?? null;
}

// ── The answer ──
/** "📥 pobierz" (the layout's name) → "#pobierz" – for a channel the server doesn't have. */
function layoutName(key) {
  const { CATEGORIES } = require('../builder/layout');
  const ch = CATEGORIES.flatMap((c) => c.channels).find((c) => c.key === key);
  return `#${ch ? ch.name.replace(/^\S+\s+/, '') : key}`;
}

/** A topic's text with {#channel}, {site} and {brand} filled in. */
function fill(guild, template) {
  const site = /^https?:\/\//.test(env.web.publicUrl) && env.web.enabled ? env.web.publicUrl : '';
  return String(template)
    .split('\n')
    .filter((line) => site || !line.includes('{site}'))
    .join('\n')
    .replace(/\{#([A-Za-z0-9_]+)\}/g, (token, key) => (db.channelId(guild.id, key) ? `<#${db.channelId(guild.id, key)}>` : layoutName(key)))
    .replace(/\{site\}/g, `<${site}>`) // <…>: a link without a big preview under the hint
    .replace(/\{brand\}/g, config.brand.name);
}

function hintPayload(message, topic) {
  const c = container(COLORS.brand);
  c.addTextDisplayComponents(text(`${fill(message.guild, topic.text)}\n-# 🤖 Automatyczna podpowiedź`));
  if (settings().dismissButton !== false) c.addActionRowComponents(row(btn(`hint:no:${message.author.id}`, 'To nie to', '✖️')));
  // A reply to the question that notifies nobody – not even the person who asked.
  return { ...v2(c), allowedMentions: { parse: [], repliedUser: false }, reply: { messageReference: message.id, failIfNotExists: false } };
}

// ── Who already got which hint ──
const byPerson = new Map(); // "guild:user:topic" → when
const byChannel = new Map(); // "channel:topic" → when
const minutes = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback) * 60_000;
const within = (map, key, ms, now) => map.has(key) && now - map.get(key) < ms;
function prune(map, ms, now) {
  if (map.size < 2000) return;
  for (const [key, at] of map) if (now - at >= ms) map.delete(key);
}

/** The channels hints are given in: the keys from chatHints.channels (#czat → 'chat'), or plain channel IDs. */
const channelIds = (guild) => (settings().channels ?? []).map((k) => db.channelId(guild.id, k) ?? String(k));

/** A message in the chat → the topic it got a hint for, or null. now: for the tests. */
async function onMessage(message, { now = Date.now() } = {}) {
  const cfg = settings();
  if (!cfg.enabled || !message?.guild || message.author?.bot || message.webhookId || message.system) return null;
  const content = String(message.content ?? '');
  if (!content.trim() || content.length > MAX_LENGTH) return null;
  if (!channelIds(message.guild).includes(message.channel?.id) || db.getTicket(message.channel.id)) return null;
  const topic = match(content);
  if (!topic) return null;
  const personKey = `${message.guild.id}:${message.author.id}:${topic.id}`;
  const channelKey = `${message.channel.id}:${topic.id}`;
  const personMs = minutes(cfg.userCooldownMinutes, 30);
  const channelMs = minutes(cfg.channelCooldownMinutes, 2);
  if (within(byPerson, personKey, personMs, now) || within(byChannel, channelKey, channelMs, now)) return null;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isStaff(member)) return null;
  // The chat filter takes this message down (it runs first) – no hint under a message that is gone.
  if (config.chatFilter?.enabled !== false && require('./chatfilter').verdict(message)) return null;
  prune(byPerson, personMs, now);
  prune(byChannel, channelMs, now);
  byPerson.set(personKey, now);
  byChannel.set(channelKey, now);
  const sent = await message.channel.send(hintPayload(message, topic)).catch((err) => {
    console.warn('[podpowiedzi]', err.message);
    return null;
  });
  return sent ? topic.id : null;
}

/** „To nie to”: the person who asked (or the team) takes the hint away. */
async function onButton(interaction, action, args) {
  if (action !== 'no') return null;
  if (interaction.user.id !== args[0] && !isStaff(interaction.member)) return replyError(interaction, 'Tę podpowiedź może schować tylko osoba, która pytała.');
  await interaction.deferUpdate().catch(() => null);
  await interaction.message?.delete().catch(() => null);
  return true;
}

hooks.on('messageCreate', (message) => onMessage(message).catch((err) => console.warn('[podpowiedzi]', err.message)));
hooks.route('hint', { button: onButton });

module.exports = { simplify, match, fill, onMessage, onButton, hintPayload, _reset: () => (byPerson.clear(), byChannel.clear()) };
