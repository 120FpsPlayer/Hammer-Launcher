'use strict';

/**
 * #📋 plany on the Hammer Launcher server: what the team is doing now and what comes next. The admin panel's „Plany”
 * tab edits the list (src/web/admin.js, kept in data/web.json – src/web/store.js) and the bot keeps one card on the
 * channel up to date (src/features/roadmap.js). This file is what both need: the sections, the limits and the text of
 * the list – so the panel refuses an item the card would have no room for.
 */

const { escapeMarkdown } = require('discord.js');

/** In the card's order. An empty section is left out of the card. */
const SECTIONS = Object.freeze([
  Object.freeze({ id: 'now', title: '🔨 Teraz robimy' }),
  Object.freeze({ id: 'next', title: '🚀 W następnej wersji' }),
  Object.freeze({ id: 'later', title: '💡 Później' }),
  Object.freeze({ id: 'done', title: '✅ Ostatnio zrobione' }),
]);
const SECTION_IDS = SECTIONS.map((s) => s.id);
const LIMITS = Object.freeze({ title: 80, note: 140, items: 20 });
/**
 * A Components V2 message carries at most 4000 characters of text. The card's own words (heading, footer with a channel
 * mention and a date) take under 300 – the list gets the rest, with room to spare.
 */
const LIST_BUDGET = 3600;

/** Text from the panel shown as typed: nothing in it works as Discord markdown (headings, lists, links, bold…). */
const plain = (value) => escapeMarkdown(String(value ?? ''), { heading: true, bulletedList: true, numberedList: true, maskedLink: true });

const itemLine = (item) => `- **${plain(item.title)}**${item.note ? ` – ${plain(item.note)}` : ''}`;

/** The list as the card shows it: [{ id, title, text }] – one entry per section that has items, in SECTIONS order. */
function sections(items = []) {
  return SECTIONS.map((s) => {
    const own = items.filter((item) => item.section === s.id);
    return own.length ? { id: s.id, title: s.title, text: `### ${s.title}\n${own.map(itemLine).join('\n')}` } : null;
  }).filter(Boolean);
}

/** The list's part of the card – the sections one under another. */
const listText = (items) => sections(items).map((s) => s.text).join('\n');

/** Does the list fit on the card (one Discord message)? */
const fits = (items) => items.length <= LIMITS.items && listText(items).length <= LIST_BUDGET;

module.exports = { SECTIONS, SECTION_IDS, LIMITS, LIST_BUDGET, sections, listText, fits, plain };
