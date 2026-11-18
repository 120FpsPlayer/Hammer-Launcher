'use strict';

/**
 * How the AI assistant's messages look in a ticket – the owner's format:
 *
 *   Cześć! Jestem asystentem AI Hammera.        ← only the first message in a ticket
 *
 *   (the answer)
 *   -# <logo> Asystent AI · napisz „człowiek”, a zawołam zespół      ← later messages: "-# <logo> Asystent AI"
 *
 * The bot adds the introduction and the signature itself, so a greeting, "jestem asystentem AI…" or a sign-off the model
 * still writes is taken out (tidy). The rest is about never posting half an answer: complete() keeps only finished
 * sentences of an answer the provider cut off, split() breaks a long answer into whole messages instead of "…".
 */

const { e } = require('../../lib/theme');

const INTRO = 'Cześć! Jestem asystentem AI Hammera.';
const HINT = 'napisz „człowiek”, a zawołam zespół';
const BODY_MAX = 1800; // + the introduction and the signature (a custom emoji is up to ~55 characters) stays under Discord's 2000
const MAX_PARTS = 3;

/**
 * "-# <:hs_logo:123> Asystent AI" – the server's logo emoji (🔨 until /zbuduj uploads it). The same on every message:
 * the first one also has the „Zawołaj zespół” and „Wyłącz asystenta” buttons, which say it better than a line of text.
 */
const signature = (guild) => `-# ${e(guild, 'logo')} Asystent AI`;

/** A signature line – this bot's, an older footer („-# 🤖 Asystent AI – może się pomylić…”) or one a model imitates. */
const SIGNATURE = /^-#\s*(?:<a?:\w+:\d+>|\S{1,8})?\s*Asystent AI\b/i;

/** A posted message → the answer alone (for the history the model sees): no introduction, no signature lines. */
function strip(content) {
  const lines = String(content ?? '').split('\n');
  if (lines[0]?.trim() === INTRO) lines.shift();
  return lines
    .filter((line) => !SIGNATURE.test(line.trim()))
    .join('\n')
    .trim();
}

// A greeting at the very start ("Cześć!", "Hej Kuba,", "Siema 👋"), and the model introducing itself.
const GREETING = /^(?:cześć|czesc|hej(?:ka|o)?|siema(?:nko)?|witaj(?:cie)?|witam|dzień dobry|dzien dobry|elo|hello|hi|yo)(?:\s+[\p{L}\d_]{2,32})?\s*[!,.:;]+[ \t]*(?:\p{Extended_Pictographic}\uFE0F?[ \t]*)*\n*|^(?:cześć|czesc|hej|siema|witaj|witam)[ \t]*(?:\p{Extended_Pictographic}\uFE0F?[ \t]*)+\n*/iu;
const SELF = /^(?:jestem|tu|tutaj|z tej strony|nazywam się|mówi)\s[^.!?\n]{0,60}?\basystent\w*\b[^.!?\n]{0,80}[.!?]+[ \t]*\n*/iu;
// A sign-off on the last line: „Pozdrawiam”, „— Asystent AI”, „🤖 Asystent AI Hammera”, a "-#" line.
const SIGN_OFF = /^(?:(?:[-—–]+|\p{Extended_Pictographic}\uFE0F?)\s*)*(?:pozdrawiam(?:y)?[,!.]?\s*)?(?:(?:tw[oó]j|wasz)\s+)?(?:asystent(?:\s+AI)?(?:\s+(?:zespołu\s+)?Hammer\w*(?:\s+Launchera)?)?)?\s*[.!]?$/iu;

/** The model's text → what is posted: without its own greeting, introduction or sign-off (the bot adds those). */
function tidy(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = t;
    t = t.replace(GREETING, '').replace(SELF, '').trim();
    if (t === before) break;
  }
  const lines = t.split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (last && !last.startsWith('-#') && !(SIGN_OFF.test(last) && /pozdrawiam|asystent/i.test(last))) break;
    lines.pop();
  }
  t = lines.join('\n').trim();
  return t.charAt(0).toLocaleUpperCase('pl-PL') + t.slice(1);
}

const ENDS = /(?:[.!?…)]|\p{Extended_Pictographic}\uFE0F?)["”»']?$/u;

/** Where the last full sentence of a line ends (after its ".", "!", "?" or "…") – -1 when none. "1. " starting a step is not one. */
function sentenceEnd(line) {
  let end = -1;
  for (const m of line.matchAll(/[.!?…]["”»)]?(?=\s)/g)) if (!/^\s*(?:[-*•]\s*)?\d{1,3}$/.test(line.slice(0, m.index))) end = m.index + m[0].length;
  return end;
}

/**
 * An answer the provider cut off (max_tokens) → only its complete part: up to the last finished sentence, or without the
 * unfinished last line (the line before it was finished by its line break – a list item needs no full stop). A line
 * that only leads into what was cut ("Zrób po kolei:") goes too. '' when not even one sentence is complete – then there
 * is nothing safe to post.
 */
function complete(text) {
  let t = String(text ?? '').trimEnd();
  if (ENDS.test(t)) return t;
  while (t) {
    const nl = t.lastIndexOf('\n');
    const end = sentenceEnd(t.slice(nl + 1));
    if (end > 0) return t.slice(0, nl + 1 + end).trimEnd();
    if (nl < 0) return '';
    t = t.slice(0, nl).trimEnd();
    if (!t.endsWith(':')) return t;
  }
  return '';
}

/** Where to cut a text that is too long: a blank line, a line break, a sentence end, a space – the latest that fits. */
function cutAt(text, max) {
  const window = text.slice(0, max + 1);
  const options = [
    [window.lastIndexOf('\n\n'), 0.4],
    [window.lastIndexOf('\n'), 0.4],
    [Math.max(...['. ', '! ', '? ', '… '].map((s) => window.lastIndexOf(s))) + 1, 0.3],
    [window.lastIndexOf(' '), 0.2],
  ];
  for (const [at, min] of options) if (at > max * min) return at;
  return max;
}

/** A long answer → whole messages of at most `max` characters, cut between paragraphs, lines or sentences. */
function split(text, max = BODY_MAX) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest.length > max && parts.length < MAX_PARTS - 1) {
    const at = cutAt(rest, max);
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  // More than MAX_PARTS messages would flood the ticket: the last one keeps its complete sentences.
  if (rest.length > max) rest = complete(rest.slice(0, max)) || rest.slice(0, cutAt(rest, max)).trim();
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

module.exports = { INTRO, HINT, BODY_MAX, signature, strip, tidy, complete, split };
