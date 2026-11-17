'use strict';

/**
 * /knowledge (/wiedza) – the team's questions and answers for the AI assistant in tickets, managed on Discord: no file
 * to find or edit, nothing a hosting panel's editor can mangle. The entries live in the bot's data
 * (src/features/ai/knowledge.js); the optional wiedza-asystenta.md is listed and searched too. Only the Hammer Launcher
 * server loads this command (the assistant only runs there – src/commands/index.js), so its buttons and forms are
 * routed from here.
 */

const { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ButtonStyle } = require('discord.js');
const knowledge = require('../features/ai/knowledge');
const assistant = require('../features/aiassistant');
const hooks = require('../lib/hooks');
const { COLORS } = require('../lib/theme');
const { UserError, embed, fail, logEmbed, reply, sendLog, isStaff, truncate, count, ts } = require('../lib/utils');
const { btn, row } = require('../lib/v2');
const { slash } = require('../lib/commandsPl');

const PAGE = 8; // entries per page of /wiedza lista – 8 full entries stay well under an embed's 4096 characters
const NO_PINGS = { parse: [] };

function requireStaff(interaction) {
  if (!isStaff(interaction.member)) throw new UserError('Bazę wiedzy asystenta przegląda i zmienia tylko zespół.');
}

/** An entry of this server by its number – or a message that says where the numbers are. */
function entryOf(guildId, id) {
  const entry = knowledge.get(guildId, id);
  if (entry) return entry;
  const file = knowledge.stats(guildId);
  const fromFile = file.entries ? ` Wpisy „z pliku” zmieniasz w pliku \`${file.file}\`.` : '';
  throw new UserError(`Nie ma wpisu #${id}. Numery wpisów pokazuje \`${slash('knowledge list')}\`.${fromFile}`);
}

/** When nobody gets an answer from the assistant at all – no key, switched off, a break – the team should know. */
function assistantWarning(guild) {
  const problem = assistant.unavailableText();
  if (problem) return `⚠️ **Asystent teraz w ogóle nie odpowiada w ticketach.** ${problem}`;
  if (!assistant.globallyOn(guild.id)) return `⚠️ **Asystent jest wyłączony na serwerze** – nikt nie dostanie tych odpowiedzi, dopóki nie włączysz go przez \`${slash('assistant on')}\`.`;
  const pause = assistant.pauseText();
  return pause ? `⏸️ ${pause}` : null;
}

// ───────────── The form (add / edit) ─────────────

function entryModal(entry = null) {
  const questions = new TextInputBuilder()
    .setCustomId('questions')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(knowledge.LIMITS.questions)
    .setPlaceholder('Jak zmienić wersję Minecrafta?\nJak zmienic wersje gry w launcherze?');
  const answer = new TextInputBuilder()
    .setCustomId('answer')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(knowledge.LIMITS.answer)
    .setPlaceholder('W launcherze: Instancje → kliknij instancję → Edytuj → Wersja Minecrafta.');
  if (entry) {
    questions.setValue(entry.questions.join('\n'));
    answer.setValue(entry.answer);
  }
  return new ModalBuilder()
    .setCustomId(entry ? `kb:edit:${entry.id}` : 'kb:add')
    .setTitle(entry ? `Baza wiedzy – wpis #${entry.id}` : 'Nowy wpis w bazie wiedzy')
    .addLabelComponents(
      new LabelBuilder().setLabel('Pytanie').setDescription('Można zapytać na kilka sposobów? Wpisz każdy w osobnej linii.').setTextInputComponent(questions),
      new LabelBuilder().setLabel('Odpowiedź').setDescription('Krótko, z nazwami z launchera – asystent powie to własnymi słowami.').setTextInputComponent(answer),
    );
}

const entryFields = (entry) => [
  { name: entry.questions.length > 1 ? `Pytania (${entry.questions.length} – każde pasuje osobno)` : 'Pytanie', value: truncate(entry.questions.map((q) => `• ${q}`).join('\n'), 1024) },
  { name: 'Odpowiedź', value: truncate(entry.answer, 1024) },
];

/** The entry as the team sees it after saving (and before removing). */
const entryEmbed = (entry, title, color = COLORS.success) => embed(color).setTitle(title).addFields(entryFields(entry));

/** The server log (#logi-serwera): who changed what, with the entry – mentions never ping. */
function logEntry(guild, user, entry, title, color, text) {
  return sendLog(guild, { embeds: [logEmbed(color, title, user).setDescription(text).addFields(entryFields(entry))], allowedMentions: NO_PINGS });
}

/** The form was sent: saved (or a clear message – with the typed text, so nothing typed is lost), logged without pings. */
async function submitForm(interaction, action, [id]) {
  requireStaff(interaction);
  const guild = interaction.guild;
  const fields = { questions: interaction.fields.getTextInputValue('questions'), answer: interaction.fields.getTextInputValue('answer') };
  const editing = action === 'edit';
  let saved;
  try {
    saved = editing ? knowledge.update(guild.id, Number(id), fields, interaction.user.id) : knowledge.add(guild.id, fields, interaction.user.id);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    // A form can't be shown again after it was sent – the text comes back here to copy into the next try.
    const block = (text) => `\`\`\`\n${truncate(String(text ?? '').replace(/```/g, "'''"), 1700)}\n\`\`\``;
    const kept = embed(COLORS.muted).setTitle('Twój tekst – skopiuj go, żeby nie przepadł').setDescription(`**Pytanie**\n${block(fields.questions)}\n**Odpowiedź**\n${block(fields.answer)}`);
    return reply(interaction, { embeds: [fail(err.message), kept] });
  }
  const { entry, notes } = saved;
  const description = [
    editing ? 'Zmiany działają od razu.' : 'Asystent korzysta z niego od razu.',
    `Sprawdź, czy go znajdzie: \`${slash('knowledge test')}\`.`,
    ...notes.map((n) => `⚠️ ${n}`),
    assistantWarning(guild),
  ].filter(Boolean);
  await reply(interaction, { embeds: [entryEmbed(entry, editing ? `✏️ Zapisano zmiany we wpisie #${entry.id}` : `✅ Dodano wpis #${entry.id} do bazy wiedzy`).setDescription(description.join('\n'))] });
  const title = editing ? `✏️ Baza wiedzy: zmieniony wpis #${entry.id}` : `📚 Baza wiedzy: nowy wpis #${entry.id}`;
  await logEntry(guild, interaction.user, entry, title, COLORS.brand, `${editing ? 'Zmienione' : 'Dodane'} przez <@${interaction.user.id}> komendą \`${slash(editing ? 'knowledge edit' : 'knowledge add')}\`.`);
}

// ───────────── /wiedza lista ─────────────

/** One entry of the list: its number (or „z pliku”), the first question (+ how many more), the answer's start, its use. */
function listLine(guildId, e) {
  const head = e.source === 'command' ? `**#${e.id}**` : '📄 **z pliku**';
  const more = e.questions.length > 1 ? ` *(+${count(e.questions.length - 1, 'inne pytanie', 'inne pytania', 'innych pytań')})*` : '';
  const answer = truncate(e.answer.replace(/\s*\n\s*/g, ' '), 140);
  let use = '';
  if (e.source === 'command') {
    const stored = knowledge.get(guildId, e.id);
    use = stored?.uses ? `\n-# asystent dostał go do odpowiedzi: ${stored.uses}× · ostatnio ${ts(stored.usedAt, 'R')}` : '\n-# asystent jeszcze ani razu go nie dostał';
  }
  return `${head} ${truncate(e.questions[0], 120)}${more}\n> ${answer}${use}`;
}

function listPage(guildId, page = 0) {
  const list = knowledge.all(guildId);
  const stats = knowledge.stats(guildId);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const e = embed(COLORS.brand).setTitle(`📚 Baza wiedzy asystenta (${count(list.length, 'wpis', 'wpisy', 'wpisów')})`);
  if (!list.length) {
    e.setDescription(`Baza jest pusta – asystent odpowiada tylko z tego, co sam wie o launcherze. Dodaj pierwsze pytanie i odpowiedź: \`${slash('knowledge add')}\`.`);
  } else {
    const lines = list.slice(p * PAGE, (p + 1) * PAGE).map((x) => listLine(guildId, x));
    e.setDescription(truncate(`${lines.join('\n\n')}\n\n-# Popraw: \`${slash('knowledge edit')}\` · usuń: \`${slash('knowledge remove')}\` · sprawdź: \`${slash('knowledge test')}\``, 4096));
  }
  const fromFile = stats.entries ? ` · z pliku: ${stats.entries} (zmieniasz je w ${stats.file})` : '';
  e.setFooter({ text: `Strona ${p + 1}/${pages} · z komendy: ${stats.command.entries}/${stats.command.max}${fromFile}` });
  // The suffix keeps the two IDs different on the first and last page, where both point at the same page.
  const components = pages > 1 ? [row(btn(`kb:page:${p - 1}:prev`, 'Poprzednia', '◀️').setDisabled(p === 0), btn(`kb:page:${p + 1}:next`, 'Następna', '▶️').setDisabled(p >= pages - 1))] : [];
  return { embeds: [e], components };
}

// ───────────── /wiedza usun ─────────────

function askRemove(interaction, entry) {
  const ask = entryEmbed(entry, `🗑️ Usunąć wpis #${entry.id}?`, COLORS.danger).setDescription('Asystent przestanie z niego korzystać od razu. Tego nie da się cofnąć.');
  return reply(interaction, { embeds: [ask], components: [row(btn(`kb:remove:${entry.id}`, 'Usuń', '🗑️', ButtonStyle.Danger), btn(`kb:keep:${entry.id}`, 'Anuluj', null, ButtonStyle.Secondary))] });
}

async function confirmRemove(interaction, id) {
  requireStaff(interaction);
  const removed = knowledge.remove(interaction.guild.id, id);
  if (!removed) return interaction.update({ embeds: [fail(`Wpisu #${id} już nie ma – ktoś go usunął wcześniej.`)], components: [] });
  await interaction.update({ embeds: [embed(COLORS.muted).setDescription(`🗑️ Usunięto wpis **#${id}** – asystent już z niego nie korzysta.`)], components: [] });
  await logEntry(interaction.guild, interaction.user, removed, `🗑️ Baza wiedzy: usunięty wpis #${id}`, COLORS.danger, `Usunięte przez <@${interaction.user.id}> komendą \`${slash('knowledge remove')}\`.`);
}

// ───────────── /wiedza test ─────────────

const LABELS = {
  strong: '🟢 **pasuje**',
  weak: '🟡 **słabo**',
  extra: '⚪ **pasuje, ale poza 3 najlepszymi**',
  no: '🔴 **nie pasuje**',
};

/** "🟡 **słabo** · 50% · **#2** „Gra crashuje po dodaniu modów” · brakuje: Gra, modów" + the answer's start. */
function testLine(r, label) {
  const ref = r.entry.source === 'command' ? `**#${r.entry.id}**` : '📄 z pliku';
  const missing = !r.strong && r.missing.length ? ` · brakuje: ${truncate(r.missing.join(', '), 80)}` : '';
  return `${label} · ${Math.round(r.score * 100)}% · ${ref} „${truncate(r.question, 100)}”${missing}\n> ${truncate(r.entry.answer.replace(/\s*\n\s*/g, ' '), 120)}`;
}

/** Which entries the assistant would use for this question, best first, and the closest ones it wouldn't. */
function testEmbed(guild, question) {
  const ranked = knowledge.rank(question, { guildId: guild.id });
  const used = knowledge.find(question, { guildId: guild.id });
  const isUsed = (r) => used.some((m) => m.source === r.entry.source && m.question === r.question && m.answer === r.entry.answer);
  const chosen = ranked.filter(isUsed);
  const rest = ranked.filter((r) => !isUsed(r)).slice(0, 3);
  const lines = [`**Pytanie:** „${truncate(question, 300)}”`];
  const warning = assistantWarning(guild);
  if (warning) lines.push('', warning);
  lines.push('');
  if (chosen.length) {
    lines.push(`**Asystent dostanie ${chosen.length === 1 ? 'tę odpowiedź' : `te odpowiedzi (${chosen.length})`}:**`);
    lines.push(...chosen.map((r, i) => testLine(r, i === 0 && used[0].strong ? LABELS.strong : LABELS.weak)));
    if (used[0].strong) lines.push(`-# Odpowie na podstawie pierwszej – własnymi słowami.`);
  } else {
    lines.push(`**Żaden wpis nie pasuje** – asystent odpowie bez bazy wiedzy. Dopisz to pytanie jako kolejną wersję we wpisie, który powinien pasować (\`${slash('knowledge edit')}\`), albo dodaj nowy wpis (\`${slash('knowledge add')}\`).`);
  }
  if (rest.length) {
    lines.push('', '**Blisko, ale nie weźmie:**');
    lines.push(...rest.map((r) => testLine(r, r.ok ? LABELS.extra : LABELS.no)));
  }
  return embed(chosen.length ? COLORS.success : COLORS.muted)
    .setTitle('🔎 Test bazy wiedzy')
    .setDescription(truncate(lines.join('\n'), 4096))
    .setFooter({ text: '🟢 pasuje – odpowie na jej podstawie · 🟡 słabo – dostanie ją, ale sam oceni, czy pasuje · 🔴 nie pasuje – nie dostanie jej · % – ile słów pytania jest w tickecie (słowa typu „launcher”, „zmienić” liczą się za pół)' });
}

// ───────────── Buttons and forms ─────────────

hooks.route('kb', {
  async button(interaction, action, args) {
    if (action === 'page') {
      requireStaff(interaction);
      return interaction.update(listPage(interaction.guild.id, Number(args[0])));
    }
    if (action === 'remove') return confirmRemove(interaction, Number(args[0]));
    if (action === 'keep') {
      requireStaff(interaction);
      return interaction.update({ embeds: [embed(COLORS.muted).setDescription(`Nic nie usunięto – wpis #${args[0]} zostaje.`)], components: [] });
    }
    return null;
  },
  modal(interaction, action, args) {
    return action === 'add' || action === 'edit' ? submitForm(interaction, action, args) : null;
  },
});

const numberOption = (o) => o.setName('number').setDescription('Entry number (from /knowledge list)').setRequired(true).setMinValue(1).setAutocomplete(true);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('knowledge')
    .setDescription("The AI assistant's questions and answers (staff)")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers) // hidden from members, like /announce
    .addSubcommand((s) => s.setName('add').setDescription('Add a question and its answer (opens a form)'))
    .addSubcommand((s) => s.setName('list').setDescription('Every question and answer with its number'))
    .addSubcommand((s) => s.setName('edit').setDescription('Change an entry (the form with its current text)').addIntegerOption(numberOption))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an entry (asks first)').addIntegerOption(numberOption))
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Which answers the assistant would use for a question')
        .addStringOption((o) => o.setName('question').setDescription('The question as someone would write it in a ticket').setRequired(true).setMaxLength(500)),
    ),

  /** The number options: the newest entries first, or those whose number or question matches what is typed. */
  async autocomplete(interaction) {
    if (!isStaff(interaction.member)) return interaction.respond([]);
    const typed = knowledge.fold(interaction.options.getFocused());
    const list = knowledge
      .own(interaction.guild.id)
      .filter((e) => !typed || String(e.id).startsWith(typed) || e.questions.some((q) => knowledge.fold(q).includes(typed)))
      .sort((a, b) => b.id - a.id)
      .slice(0, 25);
    return interaction.respond(list.map((e) => ({ name: truncate(`#${e.id} · ${e.questions[0]}`, 100), value: e.id })));
  },

  async execute(interaction) {
    requireStaff(interaction);
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    if (sub === 'add') {
      knowledge.assertRoom(guildId);
      return interaction.showModal(entryModal());
    }
    if (sub === 'list') return reply(interaction, listPage(guildId, 0));
    if (sub === 'edit') return interaction.showModal(entryModal(entryOf(guildId, interaction.options.getInteger('number'))));
    if (sub === 'remove') return askRemove(interaction, entryOf(guildId, interaction.options.getInteger('number')));
    return reply(interaction, { embeds: [testEmbed(interaction.guild, interaction.options.getString('question'))] });
  },
};
