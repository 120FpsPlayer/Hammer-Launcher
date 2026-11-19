'use strict';

/**
 * Text that comes from outside the launcher (the shop's news and messages, release notes) on its way to the
 * window: plain text only, cut to a length. Control characters and the characters that turn the direction of a
 * text around never get through.
 */

// (control characters, and the marks that change the direction of the text)
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * At most `max` characters, counted the way they are seen: an emoji (two UTF-16 units) is never cut in half into „�”.
 * `more` ends a text that was cut with „…” (still within `max`).
 */
function cut(text, max, more = false) {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return more ? `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…` : chars.slice(0, max).join('');
}

/** One line of plain text, at most `max` characters – '' when the value is not text. */
function line(value, max) {
  return typeof value === 'string' ? cut(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max).trim() : '';
}

/**
 * A few paragraphs of plain text: line breaks stay (never more than one empty line in a row), the rest as in line().
 * `more`: a text that was cut ends with „…” (release notes – the owner can write more than the launcher shows).
 */
function block(value, max, { more = false } = {}) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_BUT_NEWLINE, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cut(text, max, more).trim();
}

/** An https address as the URL parser reads it – null for anything else (other schemes, a login in the address). */
function httpsUrl(value, max = 600) {
  if (typeof value !== 'string' || !value || value.length > max || /\s/.test(value.trim())) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

module.exports = { line, block, httpsUrl };
