'use strict';

/** /assistant (/asystent) – the AI assistant in tickets: on / off for the whole server (admins), per ticket and its status (staff). */

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const assistant = require('../features/aiassistant');
const config = require('../lib/config');
const db = require('../lib/db');
const { COLORS } = require('../lib/theme');
const { embed, reply, replyError, isAdmin, isStaff, pad, ts, count, truncate } = require('../lib/utils');
const { slash } = require('../lib/commandsPl');

const STOPPED = { staff: 'odpisał ktoś z zespołu', escalated: 'zawołał zespół', manual: 'wyłączony przez zespół', break: 'ma przerwę – odpowie znowu, gdy się skończy' };
const time = (ms) => new Date(ms).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });

/** "✅ `openai/gpt-oss-120b` · dziś: 12 zapytań, 31 400 tokenów" – one line per model of the chain. */
function chainLines(chain) {
  return chain
    .map((m) => {
      const state = m.state === 'unavailable' ? '❌ niedostępny' : m.state === 'limited' ? `⏸️ limit do ${time(m.until)}` : '✅ działa';
      const use = m.requests ? ` · dziś: ${count(m.requests, 'zapytanie', 'zapytania', 'zapytań')}, ${m.tokens.toLocaleString('pl-PL')} tokenów` : '';
      return `${state} · \`${m.model}\`${use}`;
    })
    .join('\n');
}

/** "✅ `wiedza-asystenta.md` · 12 pytań (8 odpowiedzi) · wczytany 14:05" – the team's knowledge file (README → its format). */
function knowledgeLine(k) {
  if (!k) return null;
  const name = `\`${k.file}\``;
  if (!k.exists) return `⚪ brak pliku ${name} w folderze bota – asystent odpowiada bez niego (format: README → „Wiedza asystenta”)`;
  const read = k.loadedAt ? ` · wczytany ${time(k.loadedAt)}` : '';
  const loose = k.unanswered ? ` · ⚠️ ${count(k.unanswered, 'pytanie', 'pytania', 'pytań')} bez odpowiedzi pod spodem (sprawdź wcięcia)` : '';
  if (k.error) return `⚠️ ${name}: nie udało się odczytać (${truncate(k.error, 200)})${k.questions ? ` – działa ostatnia dobra wersja: ${count(k.questions, 'pytanie', 'pytania', 'pytań')}` : ''}`;
  if (!k.questions) return `⚪ ${name} jest pusty – dopisz pytania i odpowiedzi (format: README → „Wiedza asystenta”)${loose}${read}`;
  return `✅ ${name} · ${count(k.questions, 'pytanie', 'pytania', 'pytań')} (${count(k.entries, 'odpowiedź', 'odpowiedzi', 'odpowiedzi')})${read}${loose}`;
}

function ticketLine(s) {
  if (!s.ticket) return null;
  if (!s.ticket.open) return 'Ten ticket jest zamknięty.';
  if (s.ticket.mode === 'noai' && !s.ticket.stopped) return '⚪ otwarty bez AI – asystent odpowie na następną wiadomość autora, gdy AI będzie dostępne (nagrody przyciskami, „człowiek” woła zespół)';
  if (s.ticket.active) return `🟢 odpowiada · odpowiedzi: **${s.ticket.replies ?? 0}/${s.maxReplies}**`;
  // /asystent ticket can't switch it on while the assistant has a break (or isn't set up) – don't suggest it then.
  const hint = s.pause || s.problem ? '' : ` · \`${slash('assistant ticket')}\` ${s.ticket.stopped ? 'włącza go ponownie' : 'go włącza'}`;
  if (s.ticket.stopped === 'break') return `⏸️ ${STOPPED.break}${s.pause ? '' : ' (przerwa już się skończyła – odpowie na następną wiadomość autora)'}`;
  if (s.ticket.stopped) return `⚪ nie odpowiada – ${STOPPED[s.ticket.stopped] ?? s.ticket.stopped}${hint}`;
  return `⚪ nie działa w tym tickecie${hint}`;
}

function statusEmbed(guild, channel) {
  const s = assistant.status(guild, db.getTicket(channel?.id) ? channel : null);
  const working = !s.problem && !s.pause && s.global;
  const e = embed(working ? COLORS.success : s.pause ? COLORS.warning : COLORS.muted)
    .setTitle('🤖 Asystent AI w ticketach')
    .setDescription(
      s.problem ??
        s.pauseText ??
        (s.global
          ? 'Odpowiada w nowych ticketach, zanim odpisze zespół: pomaga z launcherem, wydaje nagrody z giveawayów (Hammer+ od razu, resztę zgłasza zespołowi) i woła zespół, gdy trzeba.'
          : `Wyłączony na całym serwerze – włączysz go przez \`${slash('assistant on')}\`. Nagrody z giveawayów odbiera się wtedy przyciskami w tickecie.`),
    )
    .addFields(
      { name: 'Dostawca AI', value: s.providerLabel, inline: true },
      { name: s.chain.length > 1 ? 'Model (pierwszy z listy)' : 'Model', value: s.model ? `\`${s.model}\`` : '—', inline: true },
      { name: 'Klucz API', value: s.problem ? '❌ brak albo niepełna konfiguracja' : '✅ ustawiony', inline: true },
      { name: 'Na serwerze', value: s.global ? '🟢 włączony' : '⚪ wyłączony', inline: true },
      { name: 'Przerwa', value: s.pause ? (s.pause.until === Infinity ? '⏸️ do ponownego uruchomienia bota' : `⏸️ do ${ts(s.pause.until, 't')} (${ts(s.pause.until, 'R')})`) : '—', inline: true },
      { name: 'Aktywny w ticketach', value: String(s.activeTickets), inline: true },
    )
    .setFooter({
      text:
        s.provider === 'claude'
          ? 'Odmowy modelu obsługuje model zapasowy · logi: kanał logów ticketów'
          : 'Bez klucza albo w przerwie nagrody odbiera się przyciskami, a „człowiek” woła zespół · logi: kanał logów ticketów',
    });
  if (s.chain.length) {
    e.addFields({
      name: s.chain.length > 1 ? 'Modele po kolei (gdy jednemu skończy się limit, odpowiada następny)' : 'Model',
      value: truncate(`${chainLines(s.chain)}\n-# Liczniki od północy (albo od uruchomienia bota).`, 1024),
    });
  }
  const known = knowledgeLine(s.knowledge);
  if (known) e.addFields({ name: 'Baza wiedzy', value: truncate(known, 1024) });
  const line = ticketLine(s);
  if (line) e.addFields({ name: 'Ten ticket', value: line });
  return e;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('assistant')
    .setDescription('The AI assistant in tickets (Groq / Claude) – on/off and status')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('on').setDescription('Turn the AI assistant on for the whole server (admins)'))
    .addSubcommand((s) => s.setName('off').setDescription('Turn the AI assistant off for the whole server (admins)'))
    .addSubcommand((s) => s.setName('status').setDescription('Is the assistant on, which model, how many tickets it answers in'))
    .addSubcommand((s) =>
      s
        .setName('ticket')
        .setDescription('Turn the assistant on or off in this ticket (staff)')
        .addStringOption((o) =>
          o
            .setName('state')
            .setDescription('On or off')
            .setRequired(true)
            .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const member = interaction.member;

    if (sub === 'on' || sub === 'off') {
      if (!isAdmin(member)) return replyError(interaction, 'Asystenta na całym serwerze może włączyć albo wyłączyć tylko administrator.');
      const on = sub === 'on';
      if (on && assistant.unavailableText()) return replyError(interaction, assistant.unavailableText());
      if (assistant.globallyOn(guild.id) === on) return reply(interaction, on ? 'Asystent AI już jest włączony.' : 'Asystent AI już jest wyłączony.');
      assistant.setGlobal(guild, on, member);
      return reply(
        interaction,
        on
          ? 'Asystent AI włączony – będzie odpowiadał w nowych ticketach.'
          : `Asystent AI wyłączony na całym serwerze – nie odpowie w żadnym tickecie, dopóki nie włączysz go przez \`${slash('assistant on')}\`.`,
      );
    }

    if (sub === 'ticket') {
      const ticket = db.getTicket(interaction.channel?.id);
      if (!ticket) return replyError(interaction, 'Tej komendy użyj na kanale ticketu.');
      if (!isStaff(member, config.getType(ticket.typeId))) return replyError(interaction, 'Asystenta w tickecie może włączyć albo wyłączyć tylko zespół.');
      const on = interaction.options.getString('state') === 'on';
      await assistant.setTicket(interaction.channel, on, member);
      return reply(interaction, on ? `Asystent AI znów odpowiada w tickecie \`#${pad(ticket.number)}\`.` : `Asystent AI wyłączony w tickecie \`#${pad(ticket.number)}\`.`);
    }

    if (!isStaff(member)) return replyError(interaction, 'Status asystenta widzi tylko zespół.');
    return reply(interaction, { embeds: [statusEmbed(guild, interaction.channel)] });
  },
};
