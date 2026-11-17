'use strict';

const config = require('../lib/config');
const db = require('../lib/db');
const hooks = require('../lib/hooks');
const panels = require('../lib/panels');
const { e, COLORS } = require('../lib/theme');
const { ts, plural, safeRename } = require('../lib/utils');
const { container, text, divider, header, v2 } = require('../lib/v2');
const { channelName, sameChannelName } = require('../builder/style');

/**
 * Server stats: locked voice channels showing the member and vouch count, plus an
 * activity leaderboard (messages this week / all time) in #ranking.
 */

const WEEK = 7 * 86_400_000;
/** Week number, weeks start on Monday 00:00 UTC. */
const weekKey = (t = Date.now()) => Math.floor((t + 3 * 86_400_000) / WEEK);
const weekEnds = (key) => (key + 1) * WEEK - 3 * 86_400_000;

const STAT_NAMES = {
  statMembers: (n) => channelName(`👥 Członkowie: ${n.toLocaleString('en-US')}`),
  statVouches: (n) => channelName(`⭐ Opinie: ${n.toLocaleString('en-US')}`),
  // The Hammer Launcher server: the newest published launcher and how often its installer was downloaded.
  statVersion: (v) => channelName(`🚀 Wersja: ${v ?? 'beta'}`),
  statDownloads: (n) => channelName(`📥 Pobrania: ${n.toLocaleString('en-US')}`),
  // Players in a multiplayer world with Hammer Client right now (playingNow) – singleplayer doesn't report itself.
  statPlaying: (n) => channelName(`🕹️ Gra teraz: ${n.toLocaleString('en-US')}`),
};

/**
 * How many people play right now: the launcher (2.11.3+) says "a game runs here" every two minutes while one runs and
 * "it ended" when it ends; older launchers are counted through Hammer Client on servers (it says "I am playing" every
 * 90 s in a multiplayer world). The website keeps both for 5 minutes, in memory only (src/web/launcher.js onlineNow).
 */
function playingNow() {
  try {
    return require('../web/launcher').onlineNow();
  } catch {
    return 0;
  }
}
// The presence list starts empty with every restart and fills up again with the clients' next "I am playing" – until
// then the channel keeps its old number instead of dropping to 0 for a moment (and using up a rename on it).
const PRESENCE_WARMUP_MS = 3 * 60_000;
let startedAt = Date.now();

function trackMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (db.getTicket(message.channel.id)) return; // ticket chats don't count
  const a = db.guild(message.guild.id).activity;
  const key = weekKey();
  if (a.weekKey !== key) {
    a.weekKey = key;
    a.week = {};
  }
  a.total[message.author.id] = (a.total[message.author.id] ?? 0) + 1;
  a.week[message.author.id] = (a.week[message.author.id] ?? 0) + 1;
  db.save();
}

function top(map, n = 10) {
  return Object.entries(map ?? {})
    .sort((x, y) => y[1] - x[1])
    .slice(0, n);
}

function leaderboardPanel(guild) {
  const a = db.guild(guild.id).activity;
  const key = weekKey();
  const week = a.weekKey === key ? a.week : {};
  const medal = (i) => ['🥇', '🥈', '🥉'][i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``;
  const list = (entries) => (entries.length ? entries.map(([id, n], i) => `${medal(i)} <@${id}> – **${n.toLocaleString('en-US')}** ${plural(n, 'wiadomość', 'wiadomości', 'wiadomości')}`).join('\n') : '*Jeszcze nikogo – zacznij pisać!*');

  const c = container(COLORS.brand);
  header(c, `# ${e(guild, 'trophy')} Ranking\nNajaktywniejsi członkowie **${config.brand.name}**. Pisz, pomagaj innym i wspinaj się w rankingu!`, guild.iconURL?.({ size: 256 }));
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text(`### ${e(guild, 'flame')} Ten tydzień\n${list(top(week))}\n-# Wyniki zerują się ${ts(weekEnds(key), 'R')}`));
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text(`### ${e(guild, 'crown')} Od początku\n${list(top(a.total))}`));
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text(`-# Zaktualizowano ${ts(Date.now(), 'R')} · Wiadomości w ticketach i boty się nie liczą.`));
  return v2(c);
}

panels.register('leaderboard', (guild) => leaderboardPanel(guild));

/** The names the stat channels should have right now. */
function statNames(guild) {
  const names = {
    statMembers: STAT_NAMES.statMembers(guild.memberCount ?? 0),
    statVouches: STAT_NAMES.statVouches(db.guild(guild.id).vouches.length),
  };
  const shop = require('./shopstatus').statusChannelName(guild.id);
  if (shop) names.statShop = shop;
  if (db.channelId(guild.id, 'statVersion') || db.channelId(guild.id, 'statDownloads')) {
    const launcher = launcherNumbers();
    names.statVersion = STAT_NAMES.statVersion(launcher.version);
    names.statDownloads = STAT_NAMES.statDownloads(launcher.downloads);
  }
  if (db.channelId(guild.id, 'statPlaying') && Date.now() - startedAt >= PRESENCE_WARMUP_MS) names.statPlaying = STAT_NAMES.statPlaying(playingNow());
  return names;
}

/** { version, downloads } of the launcher's installers on the website (src/web/store.js) – nothing published: null and 0. */
function launcherNumbers() {
  try {
    const store = require('../web/store');
    return { version: store.currentRelease()?.version ?? null, downloads: store.releases().reduce((sum, r) => sum + (r.downloads ?? 0), 0) };
  } catch {
    return { version: null, downloads: 0 };
  }
}

/** Renames the stat channels whose number changed. keys: only these channels (e.g. ['statPlaying']). */
async function updateStatChannels(client, { keys = null } = {}) {
  for (const guildId of db.allGuildIds()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const [key, name] of Object.entries(statNames(guild))) {
      if (keys && !keys.includes(key)) continue;
      const channel = guild.channels.cache.get(db.channelId(guildId, key) ?? '');
      if (!channel || sameChannelName(channel.name, name)) continue;
      // Discord allows 2 renames per 10 minutes per channel. This runs every 10 minutes (and after /build); the
      // players' channel also every 5 – safeRename counts its renames and skips one over the limit (the next round has it).
      if (key === 'statPlaying') await safeRename(channel, name).catch(() => null);
      else await channel.setName(name, 'Aktualizacja statystyk').catch(() => null);
    }
  }
}

// The players' number moves more than the others: checked every 5 minutes (the first time once the presence list is warm).
hooks.every('statPlaying', 5 * 60_000, (client) => updateStatChannels(client, { keys: ['statPlaying'] }), PRESENCE_WARMUP_MS + 30_000);

module.exports = {
  weekKey, STAT_NAMES, statNames, trackMessage, leaderboardPanel, updateStatChannels, top, playingNow, PRESENCE_WARMUP_MS,
  _setStartedAt: (ms) => (startedAt = ms), // tests: pretend the bot has been running for a while
};
