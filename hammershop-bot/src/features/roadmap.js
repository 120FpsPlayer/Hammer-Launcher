'use strict';

/**
 * #📋 plany (the Hammer Launcher server): one card with what the team is doing now, what comes in the next version,
 * later, and what was done lately. The admin panel's „Plany” tab edits the list (src/web/admin.js → the website's
 * hooks in src/features/website.js → publish here); the bot then edits the same message in place – it never posts a
 * second card and never pings anybody. A card someone deleted is posted again by the next publish, and remembered.
 *
 * The card is a live panel ('roadmap'): /build posts it as the channel's content (content.launcher.js) and
 * /build only:panels refreshes it like every other tracked post.
 */

const db = require('../lib/db');
const panels = require('../lib/panels');
const roadmap = require('../lib/roadmap');
const { COLORS } = require('../lib/theme');
const { truncate, ts } = require('../lib/utils');
const { container, text, divider, v2, channelUrl } = require('../lib/v2');

const KIND = 'roadmap';
const problem = (status, message) => Object.assign(new Error(message), { status });

/** The list from the website's data – empty while the website is off. */
function current() {
  try {
    return require('../web/store').roadmap();
  } catch {
    return { items: [], updatedAt: null };
  }
}

/** The card itself. */
function card(guild) {
  const { items, updatedAt } = current();
  const ideas = db.channelId(guild.id, 'suggestions') ? `<#${db.channelId(guild.id, 'suggestions')}>` : '#propozycje';
  const list = roadmap.listText(items ?? []);
  const c = container(COLORS.brand);
  c.addTextDisplayComponents(text('# 📋 Plany\nNad czym teraz pracujemy i co pojawi się w kolejnych wersjach launchera.'));
  c.addSeparatorComponents(divider());
  if (!list) {
    // Nothing planned yet: a friendly word instead of an empty card (and no date of a change that never happened).
    c.addTextDisplayComponents(text(`### 🛠️ Plany są w drodze\nJuż niedługo pokażemy tutaj, nad czym pracujemy i co dodamy w kolejnych wersjach. Masz pomysł? Wrzuć go na ${ideas} – czytamy wszystkie!`));
    return v2(c);
  }
  c.addTextDisplayComponents(text(list));
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text(`-# ${updatedAt ? `Ostatnia zmiana: ${ts(updatedAt, 'D')} · ` : ''}Plany mogą się jeszcze zmienić · Pomysły zostawiaj na ${ideas}`));
  return v2(c); // (v2: mentions in it notify nobody)
}

panels.register(KIND, (guild) => card(guild));

/** #📋 plany – null when the server has none (the shop server, or a server built before the channel existed). */
function channelOf(guild) {
  const channel = guild?.channels.cache.get(db.channelId(guild.id, 'roadmap') ?? '');
  return channel?.isTextBased?.() ? channel : null;
}

/** The messages that are (or were) the card: the live panel record and the /build post – newest first, no repeats. */
function cardIds(guild, channel) {
  const fromPanels = db.panels(guild.id, KIND).filter((p) => p.channelId === channel.id).map((p) => p.messageId).reverse();
  const fromBuild = (db.build(guild.id)?.posts?.roadmap ?? []).filter((p) => p.type === 'panel').map((p) => p.id);
  return [...new Set([...fromPanels, ...fromBuild])];
}

/** A new card: the panel record and the /build post both point to it, so neither a publish nor a rebuild posts another. */
function remember(guild, channel, message, oldIds) {
  for (const id of oldIds) db.removePanel(guild.id, id);
  db.addPanel(guild.id, { kind: KIND, channelId: channel.id, messageId: message.id });
  const build = db.build(guild.id);
  if (!build) return;
  const list = [...(build.posts?.roadmap ?? [])];
  const entry = { type: 'panel', id: message.id, kind: KIND };
  const at = list.findIndex((p) => p.type === 'panel');
  if (at === -1) list.push(entry);
  else list[at] = entry;
  db.setBuild(guild.id, { ...build, posts: { ...(build.posts ?? {}), roadmap: list } });
}

async function doPublish(guild) {
  const channel = channelOf(guild);
  if (!channel) throw problem(409, 'Na serwerze nie ma kanału #📋 plany – dodaj go na Discordzie komendą /zbuduj tylko:update.');
  const payload = card(guild);
  const gone = [];
  for (const id of cardIds(guild, channel)) {
    // Only "this message does not exist" means a new card – any other trouble (Discord down) must not leave two cards.
    const message = await channel.messages.fetch(id).catch((err) => {
      if (err.code === 10008) return null;
      throw problem(502, `Discord nie odpowiada: ${truncate(err.message, 200)}`);
    });
    if (!message) {
      gone.push(id);
      continue;
    }
    await message.edit(panels.forEdit(payload)).catch((err) => {
      throw problem(502, `Discord nie przyjął karty: ${truncate(err.message, 200)}`);
    });
    if (gone.length) remember(guild, channel, message, gone);
    return { url: message.url, reposted: false };
  }
  const message = await channel.send(payload).catch((err) => {
    throw problem(502, `Nie udało się wysłać karty na #${channel.name}: ${truncate(err.message, 200)}`);
  });
  remember(guild, channel, message, gone);
  return { url: message.url, reposted: true };
}

// One publish at a time per server: two quick changes in the panel must never both find "no card" and post two.
const queues = new Map();
/** Puts the current list on the card (edits it, or posts it when there is none) → { url, reposted }. */
function publish(guild) {
  const next = (queues.get(guild.id) ?? Promise.resolve()).catch(() => null).then(() => doPublish(guild));
  queues.set(guild.id, next);
  next.then(
    () => queues.get(guild.id) === next && queues.delete(guild.id),
    () => queues.get(guild.id) === next && queues.delete(guild.id),
  );
  return next;
}

/** For the panel: where the card is – { channel: { id, name, url } | null, url (the card's message) | null }. */
function status(guild) {
  const channel = guild ? channelOf(guild) : null;
  if (!channel) return { channel: null, url: null };
  const id = cardIds(guild, channel)[0];
  return { channel: { id: channel.id, name: channel.name, url: channelUrl(guild.id, channel.id) }, url: id ? `${channelUrl(guild.id, channel.id)}/${id}` : null };
}

module.exports = { card, publish, status, channelOf, KIND };
