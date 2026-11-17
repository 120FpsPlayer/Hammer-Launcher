'use strict';

/**
 * The team's own questions and answers for the AI assistant – hammershop-bot/wiedza-asystenta.md, written by hand:
 *
 *   - Jak zmienić wersję Minecrafta?
 *   	- W launcherze: Instancje → kliknij instancję → Edytuj → Wersja Minecrafta.
 *
 * Before every answer the assistant looks here for questions like the one in the ticket (find()) and sends the best few
 * with the request, so the model can give the team's answer in its own words (src/features/aiassistant.js).
 *
 * The file is edited in Notepad by people who never saw a parser, so reading it is forgiving: "-", "*", "•" or "1."
 * bullets; a tab or 2+ spaces in front of an answer; several questions one under another sharing one answer; an answer
 * over several indented lines; blank lines anywhere; CRLF; a BOM. Lines starting with # and <!-- comments --> are
 * skipped. It is read again whenever it changes (mtime / size) – no restart. A missing, broken or huge file means "no
 * entries" (said once in the console) – never an error in a ticket.
 *
 * Matching is plain word overlap, Polish-aware: lowercase, letters without diacritics (people type „jak pobrac”),
 * stop-words left out, and words with the same beginning count as one word (wersja / wersję / wersji).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'wiedza-asystenta.md');
const MAX_BYTES = 512 * 1024; // a knowledge file is a few KB – anything this big is a mistake (a pasted log?)
const MIN_SCORE = 0.5; // at least half of a stored question's words must be in the ticket

/**
 * What a new knowledge file starts with: only this comment, no entries. The file itself is not shipped in the bot's
 * package – the bot writes it on its first start (ensure()) – so unpacking a newer version over the bot's folder can
 * never overwrite the questions the team wrote.
 */
const TEMPLATE = `<!--
Wiedza asystenta AI – pytania i odpowiedzi zespołu. Asystent czyta ten plik przed każdą odpowiedzią w tickecie:
gdy pytanie w tickecie jest podobne do któregoś z poniższych, przekazuje odpowiedź własnymi słowami.
Zmiany działają od razu, bez ponownego uruchamiania bota. Ten komentarz na górze pliku
oraz linie zaczynające się od # są pomijane.

Format – pytanie jako punkt „- ”, pod nim odpowiedź jako punkt wcięty tabulatorem (albo dwiema spacjami):

- Jak zmienić wersję Minecrafta?
	- W launcherze: Instancje → kliknij instancję → Edytuj → Wersja Minecrafta.

Kilka pytań może mieć jedną odpowiedź (kilka punktów „- ” jeden pod drugim, odpowiedź pod ostatnim).
Odpowiedź może mieć kilka linii – każda kolejna też z wcięciem.
Wpisy dopisuj pod tym komentarzem.
-->
`;

let file = DEFAULT_FILE;
let cache = { key: null, entries: [], questions: 0, loadedAt: null, error: null, exists: false };
let warned = null;

/** Lowercase, no diacritics (ł too – NFD doesn't split it), only letters, digits and "+" (Hammer+). */
const fold = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();

// Words that say nothing about what the question is about (folded). "nie" too – „nie działa” is in half the questions.
const STOP = new Set(
  (
    'a aby ale albo ani bo by byc byl byla bylo cie ci co czy czyli dla do gdy gdzie go i ich ile im ja jak jaka jaki jakie jakis jako je jej jest jestem ' +
    'jesli juz ktora ktore ktory kiedy lub mam masz ma mi mie mnie moge mozna moj moja moje mu my na nad nam nas nic nie niz no o od oraz po pod ' +
    'przez przy sa sie skad tak tam tego tej ten to tu tutaj ty u w we wiec z za ze zeby czemu dlaczego mozesz prosze pomocy pomoz hej czesc siema ' +
    'dzieki dziekuje witam ok okej jakos coraz bardzo jeszcze teraz zawsze potem tylko troche cos ktos chce chcialbym chcialabym'
  ).split(' '),
);

/** The words of a text that carry meaning – folded, without stop-words and one-letter leftovers. */
function words(text) {
  return [...new Set(fold(text).split(' ').filter((w) => w.length > 1 && !STOP.has(w)))];
}

const prefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
/** Light stemming: the same word, or one with a long enough shared beginning (wersja / wersje / wersji, minecraft / minecrafta). */
function same(a, b) {
  if (a === b) return true;
  const p = prefix(a, b);
  return p >= 4 && p >= 0.7 * Math.min(a.length, b.length);
}

// ───────────── Reading the file ─────────────

const BULLET = /^([ \t]*)([-*•+–]|\d{1,3}[.)])[ \t]+(.*)$/;
/** A tab, or 2+ spaces, in front of a line – an answer (or its next line), not a question. */
const indented = (lead) => lead.includes('\t') || lead.length >= 2;
const plain = (text) => text.replace(/\*\*|__|`/g, '').trim(); // **bold** and `code` from Markdown editors
/** An answer bullet as it is shown in a list: numbered steps keep their number, any other bullet becomes "- ". */
const item = (marker, text) => (/\d/.test(marker) ? `${marker} ${text}` : `- ${text}`);

/** The file's text → { entries: [{ questions: [...], answer }], unanswered }. Never throws; lines it can't place are skipped. */
function read(raw) {
  const text = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ''); // comments, even one that is never closed
  const entries = [];
  let unanswered = 0; // questions with no answer under them – a hint for /asystent status that the format is off
  let questions = []; // the questions waiting for their answer
  let answer = []; // lines of the answer being read
  let first = null; // the first answer bullet – turned into a list item once a second one comes
  let bullets = 0;
  const flush = () => {
    const lines = answer.map((l) => l.trim()).filter(Boolean);
    if (questions.length && lines.length) entries.push({ questions: questions.map(plain), answer: lines.join('\n') });
    else unanswered += questions.length;
    questions = [];
    answer = [];
    first = null;
    bullets = 0;
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue; // blank lines never end an entry
    if (/^\s*(#|\/\/)/.test(line)) continue;
    const lead = line.match(/^[ \t]*/)[0];
    const m = line.match(BULLET);
    if (m && !indented(lead)) {
      // A question. After an answer it starts the next entry; right after another question it shares the answer.
      if (answer.length) flush();
      if (plain(m[3])) questions.push(m[3].trim());
      continue;
    }
    if (!questions.length || !indented(lead)) {
      flush(); // a line that belongs to no entry (a heading without #, a sentence at the start of a line)
      continue;
    }
    if (m) {
      bullets += 1;
      if (bullets === 1) first = { at: answer.length, marker: m[2], text: m[3].trim() };
      if (bullets === 2) answer[first.at] = item(first.marker, first.text);
      answer.push(bullets > 1 ? item(m[2], m[3].trim()) : m[3].trim());
    } else answer.push(line.trim()); // the answer goes on – or an answer written without its own bullet
  }
  flush();
  return { entries, unanswered };
}

/** The file's text → [{ questions: [...], answer }]. */
const parse = (raw) => read(raw).entries;

/** The entries as the file is now – read again only when it changed. */
function load() {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { key: null, entries: [], questions: 0, loadedAt: Date.now(), error: null, exists: false };
    return cache;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (key === cache.key) return cache;
  try {
    if (stat.size > MAX_BYTES) throw new Error(`plik ma ${Math.round(stat.size / 1024)} KB – to za dużo (najwyżej ${MAX_BYTES / 1024} KB)`);
    const { entries, unanswered } = read(fs.readFileSync(file, 'utf8'));
    cache = { key, entries, unanswered, questions: entries.reduce((n, e) => n + e.questions.length, 0), loadedAt: Date.now(), error: null, exists: true };
    warned = null;
  } catch (err) {
    // Keep what was read before – a half-saved file must not wipe the knowledge in the middle of the day.
    cache = { ...cache, key, error: String(err?.message ?? err), exists: true };
    if (warned !== cache.error) {
      warned = cache.error;
      console.warn(`🤖 Asystent AI: nie udało się odczytać ${path.basename(file)} (${cache.error}) – odpowiada bez nowych wpisów z tego pliku.`);
    }
  }
  return cache;
}

const entries = () => load().entries;

/**
 * The entries whose questions are most like `query` → [{ question, answer, score }], best first: at most `limit`, each
 * with a score ≥ MIN_SCORE (the share of the stored question's words found in the query) and at least two shared words
 * (one, when the stored question has only one).
 */
function find(query, { limit = 3 } = {}) {
  const asked = words(query);
  if (!asked.length) return [];
  const found = [];
  for (const entry of entries()) {
    let best = null;
    for (const question of entry.questions) {
      const own = words(question);
      if (!own.length) continue;
      const hits = own.filter((w) => asked.some((a) => same(w, a))).length;
      const score = hits / own.length;
      if (hits < Math.min(2, own.length) || score < MIN_SCORE) continue;
      if (!best || score > best.score || (score === best.score && hits > best.hits)) best = { question, answer: entry.answer, score, hits };
    }
    if (best) found.push(best);
  }
  return found
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, limit)
    .map(({ question, answer, score }) => ({ question, answer, score }));
}

/**
 * The part of the request with the matches – the team's own answers and what to do with them – at most `max`
 * characters (the free plans count every token). Empty when nothing matched.
 */
function promptBlock(matches, max = 1200) {
  if (!matches?.length) return '';
  const head = 'Odpowiedzi zespołu z bazy wiedzy, podobne do pytania w tickecie:';
  const tail =
    'Jeśli któraś pasuje do tego, o co pyta autor, oprzyj na niej odpowiedź: powiedz to samo własnymi słowami, naturalnie i krótko, dopasowane do tej rozmowy – nie wklejaj jej słowo w słowo i nie zaprzeczaj jej. Jeśli żadna nie pasuje, pomiń je.';
  const room = Math.max(200, max - head.length - tail.length - 4);
  const per = Math.floor(room / matches.length);
  const items = matches.map((m, i) => {
    const item = `${i + 1}. Pytanie: ${m.question}\nOdpowiedź zespołu: ${m.answer}`;
    return item.length > per ? `${item.slice(0, per - 1)}…` : item;
  });
  return `${head}\n${items.join('\n')}\n${tail}`;
}

/** For /asystent status: is the file there, how many questions it has, when it was read. */
function stats() {
  const c = load();
  return { file: path.basename(file), exists: c.exists, entries: c.entries.length, questions: c.questions, unanswered: c.unanswered ?? 0, loadedAt: c.loadedAt, error: c.error };
}

/** Tests: another file (null = the default one); the next read starts from scratch. */
/** Writes the empty knowledge file (TEMPLATE) when there is none – an existing file is never touched. → true when written */
function ensure() {
  try {
    fs.writeFileSync(file, TEMPLATE, { flag: 'wx' }); // wx: only when the file does not exist yet
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') console.warn(`🤖 Asystent AI: nie udało się utworzyć ${path.basename(file)} (${err?.message ?? err}).`);
    return false;
  }
}

function setFile(next) {
  file = next ?? DEFAULT_FILE;
  cache = { key: null, entries: [], questions: 0, loadedAt: null, error: null, exists: false };
  warned = null;
}

module.exports = { DEFAULT_FILE, MIN_SCORE, TEMPLATE, fold, words, same, parse, entries, find, promptBlock, stats, ensure, setFile };
