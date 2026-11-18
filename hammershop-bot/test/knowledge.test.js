'use strict';

// 📚 /wiedza – the team's questions and answers for the AI assistant, added on Discord and kept in the bot's data:
// the command (who may use it, the form, the list, editing, removing, the test), the limits, the optional
// wiedza-asystenta.md merged in, the more forgiving (but careful) matching, and what goes into the request. The AI is a
// fake (a scripted fetch) and so is Discord – nothing leaves the computer.
process.env.HS_TEST_PROFILE = 'launcher';

const fakes = require('./helpers/aiFakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { db } = require('./helpers/setup');
const { createInteraction, textOf, lastResponse, customIds } = require('./helpers/fakeInteraction');
const handle = require('../src/handlers/interactions');
const loadCommands = require('../src/commands');
const knowledge = require('../src/features/ai/knowledge');
const { localizeCommand } = require('../src/lib/commandsPl');

const { uid, role, groq, say, open, write, commands, KNOWLEDGE_FILE } = fakes;

let stamp = Date.now() / 1000 - 1000;
/** Writes the test's knowledge file; a new mtime every time, so it is read again. */
function knowledgeFile(text) {
  fs.writeFileSync(KNOWLEDGE_FILE, text);
  stamp += 10;
  fs.utimesSync(KNOWLEDGE_FILE, stamp, stamp);
}

/** The built server, a working (fake) assistant, no entries from the command and no file. */
async function fresh(env) {
  const guild = await fakes.server(env);
  db.guild(guild.id).knowledge = { seq: 0, entries: [] };
  if (fs.existsSync(KNOWLEDGE_FILE)) fs.rmSync(KNOWLEDGE_FILE);
  return guild;
}

const owner = () => fakes.ctx.guild.members.cache.get(fakes.ctx.guild.ownerId);
const support = () => fakes.ctx.guild.addMember(uid(), [role('support')]);
const member = () => fakes.ctx.guild.addMember(uid(), [role('member')]);

async function wiedza(who, subcommand, options = {}) {
  const interaction = createInteraction({ guild: fakes.ctx.guild, member: who, kind: 'command', commandName: 'knowledge', subcommand, options });
  await handle(interaction, commands);
  return interaction;
}
const submit = (who, customId, questions, answer) => fakes.click(who, null, customId, { kind: 'modal', fields: { questions, answer } });
const click = (who, customId) => fakes.click(who, null, customId);
const serverLog = () => fakes.ctx.guild.channels.cache.get(db.channelId(fakes.ctx.guild.id, 'serverLogs')).messageList;
const entries = () => db.guild(fakes.ctx.guild.id).knowledge.entries;
const add = (questions, answer) => knowledge.add(fakes.ctx.guild.id, { questions, answer }).entry;

// ───────────── The command ─────────────

test('/wiedza: the Hammer Launcher server\'s command, in Polish, hidden from members; only the team can use it', async () => {
  await fresh();
  assert.ok(commands.has('knowledge'));
  assert.ok(loadCommands.LAUNCHER_ONLY.has('knowledge'), 'the shop server never gets it (test/commands-pl.test.js runs as the shop)');
  const json = localizeCommand(commands.get('knowledge').data.toJSON());
  assert.equal(json.name, 'wiedza');
  assert.deepEqual(json.options.map((o) => o.name), ['dodaj', 'lista', 'edytuj', 'usun', 'test']);
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ModerateMembers));

  const someone = member();
  add('Jak pobrać launcher?', 'Tylko z hammerclient.com.');
  for (const [sub, options] of [['add'], ['list'], ['test', { question: 'jak pobrac launcher' }], ['edit', { number: 1 }], ['remove', { number: 1 }]]) {
    const i = await wiedza(someone, sub, options);
    assert.match(textOf(lastResponse(i)), /tylko zespół/, sub);
    assert.equal(i.state.modals.length, 0);
  }
  for (const id of ['kb:page:1:next', 'kb:remove:1', 'kb:keep:1']) assert.match(textOf(lastResponse(await click(someone, id))), /tylko zespół/, id);
  assert.match(textOf(lastResponse(await submit(someone, 'kb:add', 'Jak zmienić skina?', 'Konto → Skin.'))), /tylko zespół/);
  assert.equal(entries().length, 1, 'nothing added or removed by a member');

  // Support (the launcher server's staff role) can.
  const i = await wiedza(support(), 'add');
  assert.equal(i.state.modals[0].custom_id, 'kb:add');
});

test('/wiedza dodaj: a form with the question (variants, one per line) and the answer → saved, confirmed with its number, logged without pings', async () => {
  const guild = await fresh();
  const staff = support();
  const form = (await wiedza(staff, 'add')).state.modals[0];
  assert.equal(form.title, 'Nowy wpis w bazie wiedzy');
  assert.deepEqual(form.components.map((c) => [c.label, c.component.custom_id, c.component.max_length]), [['Pytanie', 'questions', 1000], ['Odpowiedź', 'answer', 1500]]);

  const before = serverLog().length;
  const done = await submit(staff, 'kb:add', '- Jak pobrać launcher?\r\n\r\n2) Skąd pobrać Hammer Launcher?\njak pobrac launcher', '  Tylko z hammerclient.com – zaloguj się przez Discorda.\n\n\n\nNie pobieraj go z linków od obcych.  ');
  const text = textOf(lastResponse(done));
  assert.match(text, /✅ Dodano wpis #1 do bazy wiedzy[\s\S]*korzysta z niego od razu[\s\S]*\/wiedza test/);
  assert.match(text, /• Jak pobrać launcher\?\n• Skąd pobrać Hammer Launcher\?/);
  assert.ok(lastResponse(done).flags & 64, 'ephemeral');
  assert.deepEqual(entries()[0].questions, ['Jak pobrać launcher?', 'Skąd pobrać Hammer Launcher?'], 'bullets and numbers dropped, a repeat (without diacritics) kept once');
  assert.equal(entries()[0].answer, 'Tylko z hammerclient.com – zaloguj się przez Discorda.\n\nNie pobieraj go z linków od obcych.');
  assert.equal(entries()[0].by, staff.id);
  assert.equal(knowledge.find('skad moge sciagnac ten launcher', { guildId: guild.id })[0].id, 1, 'used at once');

  const log = serverLog().slice(before);
  assert.equal(log.length, 1);
  assert.match(textOf(log[0].body), /📚 Baza wiedzy: nowy wpis #1[\s\S]*Dodane przez <@\d+>[\s\S]*Jak pobrać launcher/);
  assert.deepEqual(log[0].body.allowedMentions, { parse: [] }, 'no pings');

  // One meaningful word is allowed – with a warning that it matches a lot.
  const wide = textOf(lastResponse(await submit(staff, 'kb:add', 'Optifine', 'Launcher ma własną optymalizację – Optifine nie jest potrzebny.')));
  assert.match(wide, /Dodano wpis #2[\s\S]*⚠️ „Optifine” ma tylko jedno ważne słowo/);
});

test('/wiedza dodaj: limits and mistakes get a clear message – and the typed text comes back, so nothing is lost', async () => {
  const guild = await fresh();
  const staff = owner();
  add('Jak pobrać launcher?', 'Tylko z hammerclient.com.');
  const fails = async (questions, answer, re) => {
    const i = await submit(staff, 'kb:add', questions, answer);
    const text = textOf(lastResponse(i));
    assert.match(text, re);
    assert.match(text, /Twój tekst – skopiuj go, żeby nie przepadł[\s\S]*Pytanie[\s\S]*Odpowiedź/);
    assert.equal(entries().length, 1, `${questions}: nothing saved`);
    return text;
  };
  await fails('Co to jest?', 'Tak.', /same ogólne słowa/);
  await fails('Launcher', 'Tak.', /to za mało – samo takie słowo pasuje do prawie każdego ticketu/);
  await fails('Jak to zrobić?', 'Tak.', /to za mało/);
  await fails(Array.from({ length: 11 }, (_, i) => `Pytanie o rzecz numer ${i}`).join('\n'), 'Tak.', /Najwyżej 10 wersji pytania/);
  await fails(`Jak ${'bardzo '.repeat(40)}długie pytanie?`, 'Tak.', /jest za długie – najwyżej 200 znaków/);
  await fails('Jak zmienić skina?', 'x'.repeat(1501), /Odpowiedź jest za długa \(1501 znaków\) – najwyżej 1500/);
  await fails('Jak zmienić skina?', '   ', /Wpisz odpowiedź/);
  await fails('Jak pobrać launcher?', 'Inna odpowiedź.', /Pytanie „Jak pobrać launcher\?” jest już we wpisie #1\. Popraw tamten wpis: `\/wiedza edytuj numer:1`/);
  const kept = await fails('Skąd pobrać ten launcher?', 'Inna odpowiedź, której szkoda.', /asystent rozumie tak samo jak „Jak pobrać launcher\?” we wpisie #1/);
  assert.match(kept, /Inna odpowiedź, której szkoda\./);

  // 300 entries: the form doesn't even open, and a form opened before can't add the 301st.
  db.guild(guild.id).knowledge = { seq: 300, entries: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, questions: [`Pytanie o rzecz ${i + 1}`], answer: 'Tak.' })) };
  const full = await wiedza(staff, 'add');
  assert.equal(full.state.modals.length, 0);
  assert.match(textOf(lastResponse(full)), /Baza wiedzy ma już 300 wpisów – to limit\. Usuń te, których nikt już nie potrzebuje \(`\/wiedza usun`\)/);
  assert.match(textOf(lastResponse(await submit(staff, 'kb:add', 'Jak zmienić skina?', 'Konto → Skin.'))), /300 wpisów – to limit/);
  assert.equal(entries().length, 300);
});

test('/wiedza lista: numbered pages with buttons – the file\'s entries too, marked „z pliku”; how often each entry was used', async () => {
  const guild = await fresh();
  const staff = support();
  const topics = ['skina', 'język', 'motyw', 'pamięć', 'folder gry', 'serwer', 'konto', 'shadery', 'rozdzielczość', 'skróty klawiszowe'];
  topics.forEach((topic, i) => add(`Jak ustawić ${topic} w launcherze?`, `Ustawienia → zakładka ${i + 1}.\nPotem Zapisz.`));
  db.guild(guild.id).knowledge.entries[0].uses = 3;
  db.guild(guild.id).knowledge.entries[0].usedAt = Date.now() - 3_600_000;
  knowledgeFile('- Jak zmienić wersję Minecrafta?\n\t- Menu instancji → Edytuj.\n- Czy Hammer+ daje przewagę?\n- Czy Hammer+ to cheat?\n\t- Nie – tylko wygląd.\n');

  const first = lastResponse(await wiedza(staff, 'list'));
  const page1 = textOf(first);
  assert.match(page1, /📚 Baza wiedzy asystenta \(12 wpisów\)/);
  assert.match(page1, /\*\*#1\*\* Jak ustawić skina w launcherze\?\n> Ustawienia → zakładka 1\. Potem Zapisz\.\n-# asystent dostał go do odpowiedzi: 3× · ostatnio <t:\d+:R>/);
  assert.match(page1, /\*\*#2\*\*[\s\S]*-# asystent jeszcze ani razu go nie dostał/);
  assert.match(page1, /#8\*\*/);
  assert.doesNotMatch(page1, /#9\*\*|z pliku\*\*/);
  assert.equal(first.embeds[0].toJSON().footer.text, 'Strona 1/2 · z komendy: 10/300 · z pliku: 2 (zmieniasz je w wiedza-asystenta.md)');
  assert.deepEqual(customIds(first), ['kb:page:-1:prev', 'kb:page:1:next']);
  assert.equal(first.components[0].toJSON().components[0].disabled, true, 'no page before the first');

  const next = await click(staff, 'kb:page:1:next');
  const page2 = next.state.updates[0];
  const text2 = textOf(page2);
  assert.match(text2, /#9\*\*[\s\S]*#10\*\*[\s\S]*📄 \*\*z pliku\*\* Jak zmienić wersję Minecrafta\?\n> Menu instancji → Edytuj\.[\s\S]*📄 \*\*z pliku\*\* Czy Hammer\+ daje przewagę\? \*\(\+1 inne pytanie\)\*/);
  assert.equal(page2.embeds[0].toJSON().footer.text.startsWith('Strona 2/2'), true);
  assert.equal(page2.components[0].toJSON().components[1].disabled, true, 'no page after the last');

  // A page past the end (an old message after removals) shows the last one; an empty base says how to start.
  assert.match(textOf((await click(staff, 'kb:page:7:next')).state.updates[0]), /Strona 2\/2|#10/);
  await fresh();
  const empty = lastResponse(await wiedza(staff, 'list'));
  assert.match(textOf(empty), /Baza jest pusta[\s\S]*`\/wiedza dodaj`/);
  assert.deepEqual(customIds(empty), [], 'one page – no buttons');
});

test('/wiedza edytuj: the same form, filled in – the changes are saved and logged; a missing number says where the numbers are', async () => {
  const guild = await fresh();
  const staff = support();
  add('Jak pobrać launcher?\nSkąd pobrać launcher?', 'Z hammerclient.com.');
  add('Jak zmienić skina?', 'Konto → Skin.');

  const form = (await wiedza(staff, 'edit', { number: 1 })).state.modals[0];
  assert.equal(form.custom_id, 'kb:edit:1');
  assert.equal(form.title, 'Baza wiedzy – wpis #1');
  assert.deepEqual(form.components.map((c) => c.component.value), ['Jak pobrać launcher?\nSkąd pobrać launcher?', 'Z hammerclient.com.']);

  const done = await submit(staff, 'kb:edit:1', 'Jak pobrać launcher?\nSkąd pobrać launcher?\nGdzie jest instalator launchera?', 'Tylko z hammerclient.com – nigdy z linków od obcych.');
  assert.match(textOf(lastResponse(done)), /✏️ Zapisano zmiany we wpisie #1[\s\S]*Zmiany działają od razu/);
  const entry = knowledge.get(guild.id, 1);
  assert.equal(entry.questions.length, 3, 'its own questions are no duplicates');
  assert.equal(entry.answer, 'Tylko z hammerclient.com – nigdy z linków od obcych.');
  assert.equal(entry.editedBy, staff.id);
  assert.match(textOf(serverLog().at(-1).body), /✏️ Baza wiedzy: zmieniony wpis #1[\s\S]*Zmienione przez/);

  assert.match(textOf(lastResponse(await submit(staff, 'kb:edit:1', 'Jak zmienić skina?', 'X'))), /jest już we wpisie #2/);
  assert.match(textOf(lastResponse(await wiedza(staff, 'edit', { number: 9 }))), /Nie ma wpisu #9\. Numery wpisów pokazuje `\/wiedza lista`/);
  knowledge.remove(guild.id, 2);
  assert.match(textOf(lastResponse(await submit(staff, 'kb:edit:2', 'Jak zmienić skina?', 'X'))), /Nie ma już wpisu #2 – ktoś go usunął/);

  // The number option suggests the entries (newest first) and filters by number or question.
  add('Jak zmienić wersję Minecrafta?', 'Edytuj instancję.');
  const auto = async (focused) => {
    const i = createInteraction({ guild, member: staff, kind: 'autocomplete', commandName: 'knowledge', subcommand: 'edit', focused, focusedOption: 'number' });
    await handle(i, commands);
    return i.state.responded;
  };
  assert.deepEqual(await auto(''), [{ name: '#3 · Jak zmienić wersję Minecrafta?', value: 3 }, { name: '#1 · Jak pobrać launcher?', value: 1 }]);
  assert.deepEqual((await auto('wersje')).map((c) => c.value), [3], 'without diacritics');
  assert.deepEqual(await (async () => {
    const i = createInteraction({ guild, member: member(), kind: 'autocomplete', commandName: 'knowledge', subcommand: 'edit', focused: '', focusedOption: 'number' });
    await handle(i, commands);
    return i.state.responded;
  })(), [], 'members see nothing');
});

test('/wiedza usun: asks first – „Anuluj” keeps the entry, „Usuń” removes it (and logs it); numbers are never reused', async () => {
  const guild = await fresh();
  const staff = support();
  add('Jak pobrać launcher?', 'Z hammerclient.com.');
  add('Jak zmienić skina?', 'Konto → Skin.');

  const ask = lastResponse(await wiedza(staff, 'remove', { number: 2 }));
  assert.match(textOf(ask), /🗑️ Usunąć wpis #2\?[\s\S]*Tego nie da się cofnąć[\s\S]*Jak zmienić skina\?/);
  assert.deepEqual(customIds(ask), ['kb:remove:2', 'kb:keep:2']);
  assert.equal(entries().length, 2, 'nothing removed before the click');

  const keep = await click(staff, 'kb:keep:2');
  assert.match(textOf(keep.state.updates[0]), /Nic nie usunięto – wpis #2 zostaje/);
  assert.deepEqual(keep.state.updates[0].components, []);
  assert.equal(entries().length, 2);

  const removed = await click(staff, 'kb:remove:2');
  assert.match(textOf(removed.state.updates[0]), /Usunięto wpis \*\*#2\*\* – asystent już z niego nie korzysta/);
  assert.deepEqual(entries().map((e) => e.id), [1]);
  assert.equal(knowledge.find('jak zmienic skina', { guildId: guild.id }).length, 0, 'no longer used');
  assert.match(textOf(serverLog().at(-1).body), /🗑️ Baza wiedzy: usunięty wpis #2[\s\S]*Usunięte przez[\s\S]*Jak zmienić skina/);
  assert.match(textOf((await click(staff, 'kb:remove:2')).state.updates[0]), /Wpisu #2 już nie ma/);

  assert.equal(add('Jak zalogować się kontem Microsoft?', 'Konto → Zaloguj.').id, 3, '#2 stays the removed one in the logs');
});

test('/wiedza test: which entries the assistant would use, best first, labelled pasuje / słabo / nie pasuje with the score – and when it doesn\'t answer at all', async () => {
  const guild = await fresh();
  const staff = support();
  add('Jak pobrać launcher?\nSkąd pobrać Hammer Launcher?', 'Tylko z hammerclient.com.');
  add('Gra crashuje po dodaniu modów', 'Wyłącz nowe mody.');
  add('Jak zmienić wersję Minecrafta?', 'Edytuj instancję.');
  knowledgeFile('- Jak zmienić skina?\n\t- Konto → Skin.\n');
  const result = async (question) => textOf(lastResponse(await wiedza(staff, 'test', { question })));

  const clear = await result('skad moge sciagnac ten launcher?');
  assert.match(clear, /Pytanie:\*\* „skad moge sciagnac ten launcher\?”[\s\S]*Asystent dostanie tę odpowiedź:\*\*\n🟢 \*\*pasuje\*\* · 100% · \*\*#1\*\* „Jak pobrać launcher\?”\n> Tylko z hammerclient\.com\.[\s\S]*Odpowie na podstawie pierwszej/);
  assert.doesNotMatch(clear, /nie odpowiada|wyłączony/);

  const weak = await result('crashuje mi po dodaniu shaderow');
  assert.match(weak, /🟡 \*\*słabo\*\* · 50% · \*\*#2\*\* „Gra crashuje po dodaniu modów” · brakuje: Gra, modów/);

  const near = await result('jak zmienić nick w minecrafcie?');
  assert.match(near, /Żaden wpis nie pasuje wprost\.\*\*[\s\S]*Blisko, ale nie na górze:\*\*\n🔴 \*\*nie pasuje\*\* · 50% · \*\*#3\*\* „Jak zmienić wersję Minecrafta\?” · brakuje: wersję/);

  assert.match(await result('jak zmienic skina?'), /🟢 \*\*pasuje\*\* · 100% · 📄 z pliku „Jak zmienić skina\?”/, 'the file is searched too');
  assert.match(await result('ile kosztuje nitro'), /Żaden wpis nie pasuje/);

  // Switched off on the server, or no key: the team learns that nobody gets these answers now.
  db.guild(guild.id).aiAssistant = { enabled: false };
  assert.match(await result('jak pobrac launcher'), /⚠️ \*\*Asystent jest wyłączony na serwerze\*\* – nikt nie dostanie tych odpowiedzi, dopóki nie włączysz go przez `\/asystent wlacz`/);
  await fakes.server({});
  assert.match(await result('jak pobrac launcher'), /⚠️ \*\*Asystent teraz w ogóle nie odpowiada w ticketach\.\*\* Asystent AI jest wyłączony – w pliku `\.env` nie ma klucza[\s\S]*🟢 \*\*pasuje\*\*/);
});

// ───────────── Storage ─────────────

test('storage: entries live in the bot\'s data (data/db.json – in the backups) and survive a restart', async () => {
  const guild = await fresh();
  add('Jak pobrać launcher?', 'Z hammerclient.com.');
  db.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.HS_DATA_DIR, 'db.json'), 'utf8'));
  assert.deepEqual(saved.guilds[guild.id].knowledge.entries.map((e) => [e.id, e.questions, e.answer]), [[1, ['Jak pobrać launcher?'], 'Z hammerclient.com.']]);
  // A restart: everything read again from the file.
  db._reset();
  db.load();
  assert.equal(knowledge.find('jak pobrac launcher', { guildId: guild.id })[0].answer, 'Z hammerclient.com.');
  assert.equal(knowledge.stats(guild.id).command.entries, 1);
});

test('the file stays an optional extra: merged into the search, the command\'s entry first on a tie; /asystent status shows both counts', async () => {
  const guild = await fresh();
  const staff = owner();
  const status = async () => textOf(lastResponse(await fakes.command(staff, null, 'status')));
  assert.match(await status(), /Baza wiedzy[\s\S]*⚪ z komendy `\/wiedza`: brak wpisów – dodaj pierwszy przez `\/wiedza dodaj`\n⚪ z pliku: brak pliku `wiedza-asystenta\.md` – nie jest potrzebny/);

  knowledgeFile('- Jak pobrać launcher?\n\t- Z pliku: hammerclient.com.\n- Jak zmienić skina?\n\t- Konto → Skin.\n');
  add('Jak pobrać launcher?\nSkąd pobrać launcher?', 'Z komendy: hammerclient.com.');
  add('Jak zmienić wersję Minecrafta?', 'Edytuj instancję.');
  const found = knowledge.find('jak pobrac launcher', { guildId: guild.id });
  assert.deepEqual(found.map((m) => [m.source, m.answer]), [['command', 'Z komendy: hammerclient.com.'], ['file', 'Z pliku: hammerclient.com.']]);
  assert.equal(knowledge.find('jak zmienic skina', { guildId: guild.id })[0].source, 'file');
  assert.equal(knowledge.find('jak zmienic skina').length, 1, 'without a server only the file');
  assert.match(await status(), /📝 z komendy `\/wiedza`: 2 wpisy \(3 pytania\) · limit 300\n📄 z pliku: ✅ `wiedza-asystenta\.md` · 2 pytania \(2 odpowiedzi\)/);
  // A file whose answers lost their indent (a hosting panel's editor) – the hint points at the command.
  knowledgeFile('- Jak pobrać launcher?\n- Z pliku: hammerclient.com.\n');
  assert.match(await status(), /2 pytania bez odpowiedzi pod spodem \(sprawdź wcięcia albo dodaj je przez `\/wiedza dodaj`\)/);
});

// ───────────── Matching ─────────────

/** A realistic base: the questions a launcher's team gets, each with a second way of asking where it has one. */
const BASE = {
  version: ['Jak zmienić wersję Minecrafta?\nJak zmienić wersję gry w instancji?', 'Instancje → Edytuj → Wersja Minecrafta.'],
  download: ['Jak pobrać launcher?\nSkąd pobrać Hammer Launcher?', 'Tylko z hammerclient.com.'],
  code: ['Jak aktywować kod Hammer+?\nGdzie wpisać kod Hammer+?', 'Hammer+ → Mam kod → Aktywuj.'],
  mods: ['Gra crashuje po dodaniu modów\nMinecraft wyłącza się po instalacji modów', 'Wyłącz nowe mody, potem Napraw instancję.'],
  smartscreen: ['Windows blokuje instalację launchera (SmartScreen)\nWindows nie pozwala uruchomić instalatora', 'Więcej informacji → Uruchom mimo to.'],
  ram: ['Jak przydzielić więcej RAM-u dla Minecrafta?\nJak zwiększyć pamięć dla gry?', 'Optymalizacja → Pamięć.'],
  logs: ['Jak wysłać logi z launchera?\nGdzie znajdę logi gry?', 'Konsola → Wyślij logi.'],
  skin: ['Jak zmienić skina?\nGdzie ustawić skórkę postaci?', 'Konto → Skin.'],
  mac: ['Czy launcher działa na Macu?\nCzy jest wersja na macOS?', 'Na razie tylko Windows.'],
  server: ['Jak dodać serwer do listy w launcherze?', 'Serwery → Dodaj serwer.'],
  price: ['Ile kosztuje Hammer+?\nJaka jest cena Hammer+?', 'Cennik jest na hammerclient.com.'],
  uninstall: ['Jak odinstalować launcher?', 'Ustawienia systemu → Aplikacje.'],
  login: ['Jak zalogować się kontem Microsoft?', 'Konto → Zaloguj przez Microsoft.'],
  fps: ['Mam mało FPS w grze\nGra się tnie i laguje', 'Optymalizacja → Zoptymalizuj wszystko.'],
};

async function base() {
  const guild = await fresh();
  const names = {};
  for (const [name, [questions, answer]] of Object.entries(BASE)) names[add(questions, answer).id] = name;
  return (query) => {
    const best = knowledge.find(query, { guildId: guild.id })[0];
    return best ? names[best.id] : null;
  };
}

test('matching: other wording, no diacritics, synonyms, a missing word or a typo still find the right entry', async () => {
  const best = await base();
  const pairs = [
    ['jak zmienic wersje minecrafta', 'version'],
    ['chcę zmienić wersję gry na 1.20.1 w mojej instancji', 'version'],
    ['skad moge sciagnac ten launcher?', 'download'], // ściągnąć = pobrać
    ['gdzie wpisac kod hammer plus', 'code'], // „Hammer plus” = Hammer+
    ['jak aktywowac kod do hammer+', 'code'],
    ['minecraft crashuje mi jak dodam mody', 'mods'],
    ['gra sie crashuje po zainstalowaniu modow', 'mods'],
    ['minceraft wylacza sie po instalacji modow', 'mods'], // a typo
    ['windows smartscreen blokuje instalacje', 'smartscreen'],
    ['Jak zainstalowac launcher, bo windows nie pozwala uruchomic instalatora', 'smartscreen'],
    ['jak dac wiecej ramu dla minecrafta', 'ram'], // a word missing („przydzielić”)
    ['gdzie sa logi z gry?', 'logs'],
    ['jak wyslac logi z launhera', 'logs'], // a typo
    ['jak zmienic skina w launcherze', 'skin'],
    ['czy ten launcher bedzie dzialal na macu', 'mac'],
    ['jak dodac serwer do launchera', 'server'], // a word missing („listy”)
    ['ile kosztuje hammer plus', 'price'],
    ['jak odinstlowac launcher', 'uninstall'], // a typo in one of two words
    ['nie moge sie zalogowac kontem microsoft', 'login'],
    ['mam strasznie malo fps', 'fps'],
  ];
  const wrong = pairs.filter(([query, want]) => best(query) !== want).map(([query, want]) => `${query} → ${best(query)} (should be ${want})`);
  assert.deepEqual(wrong, []);
});

test('matching: unrelated tickets match nothing – common words, everyday verbs and one shared word are not enough', async () => {
  const best = await base();
  const unrelated = [
    'launcher nie dziala',
    'ile kosztuje nitro?',
    'mam problem z grą',
    'gra mi się wyłącza na serwerze hypixel',
    'jak wyłączyć hammer+?',
    'chcę zgłosić błąd w launcherze',
    'kiedy będzie nowa wersja launchera?',
    'jak zmienić nick w minecrafcie?', // „zmienić” + „Minecraft” – but not the version
    'jak usunąć konto?',
    'czy launcher jest darmowy?',
    'dostałem bana na serwerze',
    'jak zmienić język w launcherze?',
    'wywala mnie z serwera co 5 minut',
    'kod rabatowy nie działa w sklepie',
    'ile ramu ma mój komputer?',
    'gdzie pobrać shadery?',
    'jak wysłać zdjęcie w tickecie?',
    'mam mało miejsca na dysku',
    'nie mogę wejść na serwer, wersja się nie zgadza',
  ];
  assert.deepEqual(unrelated.filter((q) => best(q)).map((q) => `${q} → ${best(q)}`), []);
});

test('matching: a typo is forgiven only where it is safe', () => {
  const t = (a, b) => knowledge.typo(a, b);
  assert.equal(t('launher', 'launcher'), true);
  assert.equal(t('launher', 'launchera'), true, 'a typo in the stem, another ending');
  assert.equal(t('minceraft', 'minecrafta'), true, 'two letters swapped');
  assert.equal(t('optfine', 'optifine'), true);
  assert.equal(t('wylaczyc', 'wlaczyc'), false, 'wyłączyć is not włączyć');
  assert.equal(t('wejsc', 'wyjsc'), false, 'short words: too often other words');
  assert.equal(t('instancja', 'instalacja'), false, 'two letters apart');
  assert.equal(t('skiny', 'skina'), false, 'short');
  // Short words with another Polish ending are the same word – other short words are not.
  assert.deepEqual([['mody', 'modow'], ['logi', 'logow'], ['kod', 'kody'], ['czat', 'czas'], ['logo', 'logi']].map(([a, b]) => knowledge.same(a, b)), [true, true, true, false, false]);
  // A typo alone never makes a match – another word must fit exactly.
  assert.equal(knowledge.compare(['odinstalowac', 'launcher'], ['odinstlowac', 'lancher']).ok, false);
});

// ───────────── The request ─────────────

test('the request: a clear match tells the model to answer from it (still in its own words); a weak one leaves it to the model; the block stays capped', async () => {
  const guild = await fresh();
  add('Gra zamyka się po kliknięciu Graj', 'Najpierw menu instancji → Napraw instancję, potem wyłącz nowe mody.');
  add('Jak aktywować kod Hammer+?', 'Hammer+ → Mam kod → wklej → Aktywuj.');
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const calls = groq(say('Kliknij w menu instancji **Napraw instancję**.'), say('Kod wpiszesz w **Hammer+ → Mam kod**.'));
  await open('support', [['Temat', 'Gra się zamyka'], ['Wersja launchera i Minecrafta', '2.11.2'], ['Opisz dokładnie, co się dzieje', 'Po kliknięciu Graj gra się zamyka po paru sekundach']], author);
  const context = calls[0].body.messages.at(-1).content;
  assert.match(context, /Wiedza zespołu[\s\S]*1\. Pytanie: Gra zamyka się po kliknięciu Graj\nOdpowiedź zespołu: Najpierw menu instancji/);
  assert.match(context, /Wpis 1 wyraźnie pasuje do pytania – odpowiedz na jego podstawie, własnymi słowami, krótko i naturalnie, dopasowane do rozmowy \(nie wklejaj go słowo w słowo, nie zaprzeczaj mu, nie dodawaj kroków, których w nim nie ma\)/);
  assert.doesNotMatch(context, /Jeśli żaden nie pasuje/);
  assert.equal(knowledge.get(guild.id, 1).uses, 1, 'the answer went out – the entry counts as used');
  assert.equal(knowledge.get(guild.id, 2).uses, 0);

  // Weak: the model is shown the answers and decides.
  const weak = knowledge.promptBlock([{ question: 'Gra crashuje po dodaniu modów', answer: 'Wyłącz nowe mody.', score: 0.5, strong: false }]);
  assert.match(weak, /Wpisy na górze są podobne do pytania – jeśli któryś pasuje[\s\S]*Jeśli żaden nie pasuje, pomiń je\.$/);
  assert.doesNotMatch(weak, /wyraźnie pasuje/);

  // The free plans' cap holds however long the answers are; a clear match gets most of the room.
  const long = (n) => ({ question: `Pytanie ${n}`, answer: `${'Długa odpowiedź zespołu. '.repeat(60)}`, score: 1, strong: n === 1 });
  const block = knowledge.promptBlock([long(1), long(2), long(3)], 1200);
  assert.ok(block.length <= 1200, `${block.length} characters`);
  const [one, two] = block.split(/\n(?=\d\. Pytanie)/).slice(1);
  assert.ok(one.length > 2 * two.length, `the clear match: ${one.length}, another: ${two.length}`);

  // Two entries that fit equally well: no „answer from 1” – the model chooses.
  add('Jak zmienić wersję Minecrafta?', 'Edytuj instancję.');
  add('Jak zmienić wersję launchera?', 'Ustawienia → Aktualizacje.');
  const tie = knowledge.find('jak zmienic wersje minecrafta w launcherze, wersje launchera tez', { guildId: guild.id });
  assert.equal(tie.length, 2);
  assert.equal(tie[0].strong, false);
  assert.doesNotMatch(knowledge.promptBlock(tie), /wyraźnie pasuje/);
});

// ───────────── The owner's case: „jakie płatności akceptujecie?” → „czy mogę zapłacić revolutem?” ─────────────

test('the owner\'s case: „czy mogę zapłacić revolutem?” finds „Jakie płatności akceptujecie?” through its answer, and the model is told the team is right', async () => {
  const guild = await fresh();
  add('jakie płatności akceptujecie?', 'przyjmujemy revolut, karta, przelewy24 itd');
  add('Jak pobrać launcher?', 'Tylko z hammerclient.com.');
  // Matching: the answer counts too – Revolut is only in this entry's answer – and płacić / płatność are one word.
  for (const q of ['czy moge zaplacic revolutem?', 'Czy mogę zapłacić Revolutem', 'a revolut dziala?', 'przyjmujecie płatność kartą?', 'czy da sie oplacic przelewy24?']) {
    const found = knowledge.find(q, { guildId: guild.id });
    assert.equal(found[0]?.answer, 'przyjmujemy revolut, karta, przelewy24 itd', q);
  }
  assert.equal(knowledge.find('jak zmienic skina?', { guildId: guild.id }).length, 0, 'nothing to do with payments – no match');
  // „jak mogę zapłacić?” shares one word with it – not enough to put it on top, but the whole (small) knowledge goes
  // with every request anyway, so the model has the answer.
  const everything = knowledge.all(guild.id).map((e) => ({ question: e.questions[0], answer: e.answer, source: e.source, id: e.id, key: knowledge.keyOf(e) }));
  assert.match(knowledge.promptBlock(knowledge.find('jak moge zaplacic?', { guildId: guild.id }), 2000, everything), /przyjmujemy revolut, karta, przelewy24/);

  // In a ticket: the form asks about payments, the next message about Revolut.
  const author = fakes.ctx.guild.addMember(uid(), [role('member')]);
  const calls = groq(say('Przyjmujemy Revolut, kartę i Przelewy24.'), say('Tak, Revolutem też zapłacisz.'), say('Tak, Przelewy24 też działa.'));
  await open('plus', [['Twój nick w Minecraft', 'Notch'], ['W czym możemy pomóc?', 'jakie płatności akceptujecie?']], author);
  const channel = fakes.ctx.guild.channels.cache.get(db.tickets((x) => x.ownerId === author.id)[0].channelId);
  await write(channel, author, 'czy moge zaplacic revolutem?');
  const context = calls[1].body.messages.at(-1).content;
  assert.match(context, /Wiedza zespołu – to wpisał zespół i to jest prawda\. Jest ważniejsza niż Twoja instrukcja/);
  assert.match(context, /Nigdy nie mów, że czegoś nie ma albo się nie da, jeśli wiedza zespołu mówi, że jest\./);
  assert.match(context, /1\. Pytanie: jakie płatności akceptujecie\?\nOdpowiedź zespołu: przyjmujemy revolut, karta, przelewy24 itd/);
  // The instruction itself no longer says what can be paid with – only the team's knowledge does.
  const system = calls[1].body.messages[0].content;
  assert.doesNotMatch(system, /karta, Apple Pay, Google Pay/);
  assert.match(system, /„Wiedza zespołu” jest ważniejsza niż ta instrukcja/);
  assert.match(system, /pytanie, jak albo czym zapłacić, to nie problem|Nie mów, że czegoś nie ma, jeśli ona mówi, że jest/);

  // A follow-up with none of its words („a przez p24?”) still gets the entry: the ticket remembers it, and a small
  // knowledge base goes whole anyway.
  await write(channel, author, 'a p24 tez?');
  assert.match(calls[2].body.messages.at(-1).content, /Odpowiedź zespołu: przyjmujemy revolut, karta, przelewy24 itd/);
  assert.deepEqual(db.getTicket(channel.id).ai.knowledge.slice(0, 1), [`c:${entries()[0].id}`]);
});

test('the whole knowledge goes with every request while it fits – the matches first, whole entries only, the free plan\'s cap holds', () => {
  const pick = (n, extra = {}) => ({ question: `Pytanie numer ${n}?`, answer: `Odpowiedź numer ${n}.`, source: 'command', id: n, key: `c:${n}`, score: 0, strong: false, ...extra });
  const rest = Array.from({ length: 5 }, (_, i) => pick(i + 1));
  const block = knowledge.promptBlock([pick(3, { score: 1, strong: true })], 2000, rest);
  assert.match(block, /^Wiedza zespołu/);
  assert.match(block, /\n1\. Pytanie: Pytanie numer 3\?/, 'the match first');
  assert.equal((block.match(/^\d+\. Pytanie: /gm) ?? []).length, 5, 'every entry once (the match is not repeated)');
  assert.match(block, /Wpis 1 wyraźnie pasuje do pytania/);
  // Without a match: the knowledge still goes, with what to do with it.
  assert.match(knowledge.promptBlock([], 2000, rest), /Jeśli któryś wpis dotyczy pytania \(także gdy autor pyta o jedną z rzeczy w odpowiedzi\), odpowiedz na jego podstawie/);
  assert.equal(knowledge.promptBlock([], 2000, []), '');
  // A big base: as many whole entries as fit, never over the cap.
  const big = Array.from({ length: 80 }, (_, i) => pick(i + 1, { answer: `${'Długa odpowiedź zespołu. '.repeat(4)}${i}` }));
  const capped = knowledge.promptBlock([], 2000, big);
  assert.ok(capped.length <= 2000, `${capped.length} characters`);
  assert.ok((capped.match(/^\d+\. Pytanie: /gm) ?? []).length >= 10);
  assert.doesNotMatch(capped, /…\n/, 'no entry cut in half');
});
