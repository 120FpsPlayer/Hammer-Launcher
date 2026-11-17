'use strict';

/**
 * The team's own questions and answers for the AI assistant. Two sources, searched together:
 *
 * 1. Entries added on Discord with /wiedza (src/commands/knowledge.js) – kept in the bot's data (data/db.json, per
 *    server, in the automatic backups), so an update, a hosting panel's editor or a lost tab can't break them. Each
 *    entry has a few ways of asking (question variants) and one answer.
 * 2. Optionally hammershop-bot/wiedza-asystenta.md, written by hand – what the team wrote before the command existed:
 *
 *   - Jak zmienić wersję Minecrafta?
 *   	- W launcherze: Instancje → kliknij instancję → Edytuj → Wersja Minecrafta.
 *
 * Before every answer the assistant looks for questions like the one in the ticket (find()) and sends the best few
 * with the request, so the model can give the team's answer in its own words (src/features/aiassistant.js).
 *
 * The file is edited in Notepad by people who never saw a parser, so reading it is forgiving: "-", "*", "•" or "1."
 * bullets; a tab or 2+ spaces in front of an answer; several questions one under another sharing one answer; an answer
 * over several indented lines; blank lines anywhere; CRLF; a BOM. Lines starting with # and <!-- comments --> are
 * skipped. It is read again whenever it changes (mtime / size) – no restart. A missing, broken or huge file means "no
 * entries" (said once in the console) – never an error in a ticket.
 *
 * Matching is word overlap, Polish-aware: lowercase, letters without diacritics (people type „jak pobrac”), stop-words
 * left out, words with the same beginning count as one word (wersja / wersję / wersji), a few true synonyms are one
 * word (pobrać / ściągnąć), and one typo in a longer word is forgiven (launher). Every variant of an entry is scored on
 * its own. Guards against matching an unrelated ticket: words every ticket here has (launcher, gra, działa…) and the
 * everyday verbs of a question (zmienić, dodać…) weigh half and can't make a match alone, and a typo never counts unless
 * another word matched exactly.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../../lib/db');
const { UserError } = require('../../lib/utils');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'wiedza-asystenta.md');
const MAX_BYTES = 512 * 1024; // a knowledge file is a few KB – anything this big is a mistake (a pasted log?)
const MIN_SCORE = 0.5; // at least half of a stored question's words must be in the ticket
// "Clearly fits": three quarters of the stored question is in the ticket (and at least two words of it) – the model is
// then told to answer from that entry instead of only being shown it.
const STRONG_SCORE = 0.75;

/**
 * Limits of the entries added with /wiedza – enough for every question a launcher's team gets, small enough that the
 * search stays instant and an answer still fits the free plans' request (the block in promptBlock() is capped anyway).
 */
const LIMITS = { entries: 300, variants: 10, question: 200, questions: 1000, answer: 1500 };

/**
 * What a new knowledge file starts with: only this comment, no entries. The file itself is not shipped in the bot's
 * package – the bot writes it on its first start (ensure()) – so unpacking a newer version over the bot's folder can
 * never overwrite the questions the team wrote.
 */
const TEMPLATE = `<!--
Najprościej: pytania i odpowiedzi dodawaj na Discordzie komendą /wiedza dodaj (lista: /wiedza lista,
sprawdzenie: /wiedza test). Ten plik jest nieobowiązkowy – asystent czyta oba źródła.

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

/**
 * True synonyms, folded to one word before comparing (by the word's beginning: ściągnąć / ściągam / ściągnięcie). Only
 * words that always mean the same here – a loose one („wywala” is a crash or a kick) would match tickets about
 * something else; other phrasings are what an entry's question variants are for.
 */
const SYNONYMS = [
  [['pobra', 'pobier', 'pobior', 'sciag', 'download'], 'pobrac'],
  [['instal', 'zainstal'], 'instalacja'],
];
const EXACT_SYNONYMS = new Map([
  ['mc', 'minecraft'],
  ['h+', 'hammer+'],
  ['hammerplus', 'hammer+'],
  ['ramu', 'ram'],
  ['ramem', 'ram'],
]);

function canonical(word) {
  if (EXACT_SYNONYMS.has(word)) return EXACT_SYNONYMS.get(word);
  for (const [stems, to] of SYNONYMS) if (stems.some((s) => word.startsWith(s))) return to;
  return word;
}

/** The words of a text that carry meaning – folded, without stop-words and one-letter leftovers, synonyms as one word. */
function words(text) {
  const folded = fold(text).replace(/\bhammer ?(?:\+|plus)/g, 'hammer+'); // "Hammer plus", "hammer +"
  return [...new Set(folded.split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(canonical))];
}

const prefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
// Polish endings of short nouns (folded): mody / modów / modami, logi / logów, kod / kody, ban / bana. Not „o” – logo is
// not logi – and not „ie” (ram / ramię).
const ENDINGS = new Set(['', 'a', 'e', 'i', 'u', 'y', 'ow', 'om', 'ami', 'ach', 'em']);

/**
 * Light stemming: the same word, one with a long enough shared beginning (wersja / wersje / wersji, minecraft /
 * minecrafta), or a short word with another ending (mody / modów – czat / czas stay apart).
 */
function same(a, b) {
  if (a === b) return true;
  const p = prefix(a, b);
  if (p >= 4 && p >= 0.7 * Math.min(a.length, b.length)) return true;
  return p >= 3 && ENDINGS.has(a.slice(p)) && ENDINGS.has(b.slice(p));
}

/** a and b differ by exactly one letter typed wrong, missing, added or two swapped (Damerau, ≤ 1) – or not at all. */
function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const i = prefix(a, b);
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * One typo in a longer word (launher / launcher, minceraft / minecrafta, instlacja). Only words of 6+ letters (short
 * ones are too often other words one letter apart: wejść / wyjść) that start with the same three letters (Polish
 * prefixes change the meaning: wyłączyć / włączyć), letters only (1.21.4 vs 1.21.5 is not a typo). The longer word may
 * go on with another ending (a typo in the stem: launher → launchera).
 */
function typo(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 6 || s.slice(0, 3) !== l.slice(0, 3) || !/^[a-z]+$/.test(s) || !/^[a-z]+$/.test(l)) return false;
  return oneEdit(s, l) || [s.length - 1, s.length, s.length + 1].some((n) => n >= 6 && n < l.length && oneEdit(s, l.slice(0, n)));
}

// Words that don't say what a question is about – they weigh half and can't make a match on their own, so „launcher nie
// działa” doesn't pull in every stored question that mentions the launcher, and „jak zmienić nick” doesn't get the answer
// to „Jak zmienić wersję Minecrafta?”. Two kinds: what nearly every ticket on a launcher server has (folded beginnings,
// and the forms of „gra” whole – too short for a beginning), and the everyday verbs of a how-to question (their common
// forms whole – a beginning like „doda” would also catch „dodatki”, which is a topic).
const COMMON_STEMS = ['launcher', 'minecraf', 'hammer', 'dzial', 'problem', 'pytani'];
const COMMON_WORDS = new Set(
  (
    'gra gry grze gre grac gram grania granie gierka gierki gierke sprawa sprawie sprawy sprawe ' +
    'zmienic zmienie zmienia zmieniam zmienilem zmienilam zmiana zmiany zmiane zmianie dodac dodam dodaje dodalem dodalam ' +
    'dodanie dodaniu usunac usune usuwam usunalem usunelam usuniecie ustawic ustawie ustawiam ustawilem zrobic zrobie robie ' +
    'zrobilem wlaczyc wlacze wlacza wlaczam wlaczylem wylaczyc wylacze wylacza wylaczam wylaczylem uruchomic uruchomie ' +
    'uruchamiam uruchamia odpalic odpalam naprawic naprawie sprawdzic sprawdze zobaczyc znalezc znajde znajduje wyslac wysle ' +
    'wysylam wpisac wpisze wpisuje dac daje dostac dostane dostalem miec uzyc uzywac uzywam wejsc wejde wchodze kliknac ' +
    'klikam kliknalem'
  ).split(' '),
);
const weak = (w) => COMMON_WORDS.has(w) || COMMON_STEMS.some((s) => w.startsWith(s));

/**
 * How well one stored question (its words: own) fits the words of a ticket (asked) → { score, hits, ok, strong,
 * missing } (missing: its words the ticket doesn't have).
 * score: the stored question's words found in the ticket, by weight (weak words count half). ok – the assistant uses
 * it: score ≥ MIN_SCORE, two words found (one when the question has one), at least one of them exactly (not only by a
 * typo) and – when the question has any – at least one that is not a weak word.
 */
function compare(own, asked) {
  let total = 0;
  let got = 0;
  let hits = 0;
  let exact = 0;
  let rare = 0;
  let rareOwn = 0;
  const missing = [];
  for (const w of own) {
    const weight = weak(w) ? 0.5 : 1;
    total += weight;
    if (weight === 1) rareOwn += 1;
    const kind = asked.some((a) => same(w, a)) ? 'word' : asked.some((a) => typo(w, a)) ? 'typo' : null;
    if (!kind) {
      missing.push(w);
      continue;
    }
    hits += 1;
    got += weight;
    if (kind === 'word') exact += 1;
    if (weight === 1) rare += 1;
  }
  const score = total ? got / total : 0;
  const ok = hits >= Math.min(2, own.length) && score >= MIN_SCORE && exact >= 1 && (rareOwn ? rare >= 1 : own.length >= 2);
  return { score, hits, ok, strong: ok && hits >= 2 && score >= STRONG_SCORE, missing };
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

/** The file's entries ([{ questions, answer }]) – read again only when it changed. */
const entries = () => load().entries;

// ───────────── Entries added with /wiedza (the bot's data) ─────────────

/** This server's entries from the command: [{ id, questions, answer, by, at, editedBy, editedAt, uses, usedAt }]. */
const own = (guildId) => (guildId ? db.guild(guildId).knowledge.entries : []);
const get = (guildId, id) => own(guildId).find((e) => e.id === id) ?? null;

/** "- Jak pobrać launcher?\n2) Skąd go pobrać?" → one question variant per line, bullets and numbering dropped, repeats once. */
function splitQuestions(raw) {
  const seen = new Set();
  const out = [];
  for (const line of String(raw ?? '').split(/\r\n|\r|\n/)) {
    const text = line.replace(/^\s*(?:[-*•+–]|\d{1,3}[.)])\s+/, '').replace(/\s+/g, ' ').trim();
    const key = fold(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
/** What the matcher sees in a question – two questions with the same words are the same question to it. */
const key = (question) => words(question).sort().join(' ');

/**
 * The form's two fields → { questions, answer, notes } ready to save – or a UserError that says what to fix. id: the
 * entry being edited (its own questions are no duplicates). notes: hints that don't stop saving.
 */
function check(guildId, { questions: rawQuestions, answer: rawAnswer }, id = null) {
  const { slash } = require('../../lib/commandsPl'); // here – only the messages need it
  const questions = splitQuestions(rawQuestions);
  const answer = String(rawAnswer ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!questions.length) throw new UserError('Wpisz pytanie – chociaż jedno.');
  if (questions.length > LIMITS.variants) throw new UserError(`Najwyżej ${LIMITS.variants} wersji pytania w jednym wpisie (masz ${questions.length}). Resztę dodaj jako osobny wpis.`);
  if (questions.join('\n').length > LIMITS.questions) throw new UserError(`Pytania są za długie – razem najwyżej ${LIMITS.questions} znaków.`);
  const long = questions.find((q) => q.length > LIMITS.question);
  if (long) throw new UserError(`Pytanie „${cut(long, 60)}” jest za długie – najwyżej ${LIMITS.question} znaków. Każdą wersję pytania wpisz w osobnej linii.`);
  for (const q of questions) {
    const w = words(q);
    if (!w.length) throw new UserError(`„${cut(q, 80)}” to same ogólne słowa – asystent nie rozpozna po nich, o co chodzi. Napisz całe pytanie, np. „Jak zmienić wersję Minecrafta?”.`);
    if (w.length === 1 && weak(w[0])) throw new UserError(`„${cut(q, 80)}” to za mało – samo takie słowo pasuje do prawie każdego ticketu. Napisz całe pytanie, np. „Jak zaktualizować launcher?”.`);
  }
  if (!answer) throw new UserError('Wpisz odpowiedź.');
  if (answer.length > LIMITS.answer) throw new UserError(`Odpowiedź jest za długa (${answer.length} znaków) – najwyżej ${LIMITS.answer}. Napisz ją krócej albo podziel na dwa wpisy.`);
  // The same question in two entries would make them fight over one ticket.
  const mine = new Map(questions.map((q) => [key(q), q]));
  for (const e of own(guildId)) {
    if (e.id === id) continue;
    const twin = e.questions.find((q) => mine.has(key(q)));
    if (!twin) continue;
    const q = mine.get(key(twin));
    const what = fold(q) === fold(twin) ? `Pytanie „${cut(q, 80)}” jest już` : `Pytanie „${cut(q, 80)}” asystent rozumie tak samo jak „${cut(twin, 80)}”`;
    throw new UserError(`${what} we wpisie #${e.id}. Popraw tamten wpis: \`${slash('knowledge edit')} numer:${e.id}\`.`);
  }
  const notes = questions
    .filter((q) => words(q).length === 1)
    .map((q) => `„${cut(q, 60)}” ma tylko jedno ważne słowo – asystent użyje tej odpowiedzi w każdym tickecie, w którym ono padnie. Jeśli to za szeroko, napisz całe pytanie.`);
  return { questions, answer, notes };
}

/** A UserError when the server has LIMITS.entries entries already – said before the form opens and again on saving. */
function assertRoom(guildId) {
  if (own(guildId).length < LIMITS.entries) return;
  const { slash } = require('../../lib/commandsPl');
  throw new UserError(`Baza wiedzy ma już ${LIMITS.entries} wpisów – to limit. Usuń te, których nikt już nie potrzebuje (\`${slash('knowledge remove')}\`), albo połącz podobne w jeden wpis.`);
}

/** A new entry → { entry, notes }. by: who added it (user ID). */
function add(guildId, fields, by = null) {
  assertRoom(guildId);
  const kb = db.guild(guildId).knowledge;
  const { questions, answer, notes } = check(guildId, fields);
  // Numbers are never reused – #12 in an old log is always the same entry.
  kb.seq = Math.max(kb.seq ?? 0, ...kb.entries.map((e) => e.id)) + 1;
  const entry = { id: kb.seq, questions, answer, by, at: Date.now(), editedBy: null, editedAt: null, uses: 0, usedAt: null };
  kb.entries.push(entry);
  db.save();
  return { entry, notes };
}

/** The entry with new questions and answer → { entry, notes }. */
function update(guildId, id, fields, by = null) {
  const entry = get(guildId, id);
  if (!entry) throw new UserError(`Nie ma już wpisu #${id} – ktoś go usunął w międzyczasie.`);
  const { questions, answer, notes } = check(guildId, fields, id);
  Object.assign(entry, { questions, answer, editedBy: by, editedAt: Date.now() });
  db.save();
  return { entry, notes };
}

/** → the removed entry, or null when there was none. */
function remove(guildId, id) {
  const kb = db.guild(guildId).knowledge;
  const entry = get(guildId, id);
  if (!entry) return null;
  kb.entries = kb.entries.filter((e) => e !== entry);
  db.save();
  return entry;
}

/** The assistant sent an answer with these matches – so /wiedza lista can say which entries are used at all. */
function noteUsed(guildId, matches) {
  let changed = false;
  for (const m of matches ?? []) {
    const entry = m.source === 'command' ? get(guildId, m.id) : null;
    if (!entry) continue;
    entry.uses = (entry.uses ?? 0) + 1;
    entry.usedAt = Date.now();
    changed = true;
  }
  if (changed) db.save();
}

/** Both sources as one list: the command's entries first (newest knowledge of the team), then the file's. */
function all(guildId = null) {
  return [
    ...own(guildId).map((e) => ({ source: 'command', id: e.id, questions: e.questions, answer: e.answer })),
    ...entries().map((e, i) => ({ source: 'file', id: null, n: i + 1, questions: e.questions, answer: e.answer })),
  ];
}

// ───────────── Search ─────────────

const better = (a, b) => a.ok - b.ok || a.score - b.score || a.hits - b.hits;

/** A question's words as it spells them (folded word → as written: wersje → wersję) – to show which ones a ticket lacks. */
function spelled(question) {
  const map = new Map();
  for (const raw of String(question).match(/[\p{L}\p{N}+]+/gu) ?? []) {
    const w = words(raw)[0];
    if (w && !map.has(w)) map.set(w, raw);
  }
  return map;
}

/**
 * Every entry that shares a word with `query`, with its best-fitting question variant → [{ entry, question, score,
 * hits, ok, strong, missing }], those the assistant uses (ok) first, then by score. For find() and /wiedza test.
 * missing: the variant's words (as written) that the query lacks.
 */
function rank(query, { guildId = null } = {}) {
  const asked = words(query);
  if (!asked.length) return [];
  const found = [];
  for (const entry of all(guildId)) {
    let best = null;
    for (const question of entry.questions) {
      const ownWords = words(question);
      if (!ownWords.length) continue;
      const r = compare(ownWords, asked);
      if (r.hits && (!best || better(r, best) > 0)) best = { ...r, question };
    }
    if (!best) continue;
    const spelling = spelled(best.question);
    found.push({ ...best, missing: best.missing.map((w) => spelling.get(w) ?? w), entry });
  }
  return found.sort((a, b) => better(b, a)); // stable: on a tie the command's entry stays before the file's
}

/**
 * The entries whose questions are most like `query` → [{ question, answer, score, strong, source, id }], best first:
 * at most `limit`, only those that fit (compare()). strong on the first one: it clearly fits – unless another entry
 * fits just as well, then the model chooses.
 */
function find(query, { limit = 3, guildId = null } = {}) {
  const matches = rank(query, { guildId })
    .filter((r) => r.ok)
    .slice(0, limit)
    .map((r) => ({ question: r.question, answer: r.entry.answer, score: r.score, strong: r.strong, source: r.entry.source, id: r.entry.id }));
  if (matches[0]?.strong && matches[1]?.strong && matches[1].score >= matches[0].score) matches[0].strong = false;
  return matches;
}

/**
 * The part of the request with the matches – the team's own answers and what to do with them – at most `max`
 * characters (the free plans count every token). Empty when nothing matched. When the first one clearly fits, the model
 * is told to answer from it (and that one gets most of the room); otherwise it decides whether any fits.
 */
function promptBlock(matches, max = 1200) {
  if (!matches?.length) return '';
  const strong = Boolean(matches[0].strong);
  const head = 'Odpowiedzi zespołu z bazy wiedzy, podobne do pytania w tickecie:';
  const tail = strong
    ? `Odpowiedź 1 wyraźnie pasuje do pytania w tickecie – odpowiedz na jej podstawie: powiedz to samo własnymi słowami, naturalnie i krótko, dopasowane do tej rozmowy – nie wklejaj jej słowo w słowo i nie zaprzeczaj jej. Nie dodawaj kroków, których w niej nie ma, chyba że autor pyta o coś więcej.${matches.length > 1 ? ' Pozostałe wykorzystaj tylko, jeśli też pasują.' : ''}`
    : 'Jeśli któraś pasuje do tego, o co pyta autor, oprzyj na niej odpowiedź: powiedz to samo własnymi słowami, naturalnie i krótko, dopasowane do tej rozmowy – nie wklejaj jej słowo w słowo i nie zaprzeczaj jej. Jeśli żadna nie pasuje, pomiń je.';
  const room = Math.max(200, max - head.length - tail.length - 4);
  const texts = matches.map((m, i) => `${i + 1}. Pytanie: ${m.question}\nOdpowiedź zespołu: ${m.answer}`);
  const sizes = texts.map(() => Math.floor(room / texts.length));
  if (strong && texts.length > 1) {
    // The answer to give gets what it needs; the others share the rest (at least a short look each).
    sizes[0] = Math.min(texts[0].length, Math.max(sizes[0], room - 160 * (texts.length - 1)));
    const rest = Math.floor((room - sizes[0]) / (texts.length - 1));
    for (let i = 1; i < sizes.length; i += 1) sizes[i] = rest;
  }
  const items = texts.map((t, i) => cut(t, sizes[i]));
  return `${head}\n${items.join('\n')}\n${tail}`;
}

/**
 * For /asystent status: is the file there, how many questions it has, when it was read – and command: this server's
 * entries from /wiedza.
 */
function stats(guildId = null) {
  const c = load();
  const mine = own(guildId);
  const command = { entries: mine.length, questions: mine.reduce((n, e) => n + e.questions.length, 0), max: LIMITS.entries };
  return { file: path.basename(file), exists: c.exists, entries: c.entries.length, questions: c.questions, unanswered: c.unanswered ?? 0, loadedAt: c.loadedAt, error: c.error, command };
}

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

/** Tests: another file (null = the default one); the next read starts from scratch. */
function setFile(next) {
  file = next ?? DEFAULT_FILE;
  cache = { key: null, entries: [], questions: 0, loadedAt: null, error: null, exists: false };
  warned = null;
}

module.exports = {
  DEFAULT_FILE,
  MIN_SCORE,
  STRONG_SCORE,
  LIMITS,
  TEMPLATE,
  fold,
  words,
  same,
  typo,
  compare,
  parse,
  entries,
  own,
  get,
  splitQuestions,
  check,
  assertRoom,
  add,
  update,
  remove,
  noteUsed,
  all,
  rank,
  find,
  promptBlock,
  stats,
  ensure,
  setFile,
};
