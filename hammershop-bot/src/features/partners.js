'use strict';

/**
 * Partnerships (the Hammer Launcher server): servers the team works with – a Discord server, a Minecraft server, or
 * both. The admin panel's „Partnerstwa” tab adds, changes and ends them (src/web/admin.js → the website's hooks in
 * src/features/website.js → here):
 *
 *   discord     the invite is checked with Discord (the server's name, icon and member count come from it) and the
 *               partner gets a read-only channel of its own under 🤝 PARTNERSTWA, with a card: who they are, how many
 *               people, „Dołącz do serwera” – and, for both, the Minecraft address
 *   minecraft   the server goes on the launcher's featured list (src/features/featured.js – its checks, plus the tag
 *               „partner”), so Hammer Launcher shows it under „Polecane serwery” (the website's API reads that list live)
 *   both        both of the above
 *
 * The website lists them on its „Partnerzy” page (src/web/pages.js – publicList). A logo uploaded in the panel
 * (src/lib/partnerLogo.js) shows there, in the panel, on the Discord card and in the announcements – not in the
 * launcher: the owner wants no partner pictures there, so its featured server has no icon. The category is made here
 * too when /build has not made it yet; the partners' channels are not in the layout, so /build only:update leaves them.
 *
 *   db.guild(id).partners = [{ id, name, kind ('discord' | 'minecraft' | 'both'), description, icon (https | null),
 *     logo (a file in data/partners | null), discord: { invite, code, guildId, guildName, guildIcon, memberCount,
 *     channelId, messageId } | null, minecraft: { address, mc, loader, pack, tags (without „partner”), featuredId }
 *     | null, addedBy, addedAt, updatedBy, updatedAt }] – in the order they were added
 */

const { ChannelType, escapeMarkdown } = require('discord.js');
const config = require('../lib/config');
const db = require('../lib/db');
const panels = require('../lib/panels');
const logos = require('../lib/partnerLogo');
const { COLORS, e, ce } = require('../lib/theme');
const { UserError, truncate, ts } = require('../lib/utils');
const { container, text, divider, header, linkBtn, row, v2, channelUrl } = require('../lib/v2');
const featured = require('./featured');

const KINDS = ['discord', 'minecraft', 'both'];
const KIND_LABELS = { discord: 'Discord', minecraft: 'Minecraft', both: 'Discord + Minecraft' };
const MAX_PARTNERS = 45; // a Discord category holds 50 channels – #współpraca and some room left
const LIMITS = { name: 40, description: 200, invite: 200, tags: featured.MAX_TAGS - 1 }; // name and description fit the launcher's featured card
const CATEGORY = 'catPartnerships';
const PARTNER_TAG = 'partner';
const REASON = `${config.brand.name} – partnerstwa (panel admina)`;

const problem = (status, message) => Object.assign(new Error(message), { status });
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const hasDiscord = (kind) => kind === 'discord' || kind === 'both';
const hasMinecraft = (kind) => kind === 'minecraft' || kind === 'both';
const list = (guildId) => db.guild(guildId).partners;
const find = (guildId, id) => list(guildId).find((p) => p.id === id) ?? null;
/** „1 osoba”, „3 osoby”, „1 250 osób”. */
const people = (n) => `${new Intl.NumberFormat('pl-PL').format(n)} ${n === 1 ? 'osoba' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'osoby' : 'osób'}`;
const plDate = (ms) => new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' }).format(new Date(ms));
/** Text from the panel on its way into a card: shown as typed, never as Discord formatting. */
const plain = (value) => escapeMarkdown(String(value ?? ''), { maskedLink: true, heading: true, bulletedList: true, numberedList: true });

// ───────────── The invite ─────────────
const INVITE = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,64})\/?(?:[?#]\S*)?$/i;
const DEAD = 'To zaproszenie nie działa – wygasło albo zostało usunięte. Poproś partnera o nowe, bezterminowe zaproszenie (przy tworzeniu zaproszenia: „Wygasa po: Nigdy”).';

/** "https://discord.gg/abc123", "discord.com/invite/abc123" → "abc123". */
function parseInvite(raw) {
  const value = clean(raw);
  if (!value) throw new UserError('Wklej link zaproszenia na serwer Discord partnera, np. https://discord.gg/abc123.');
  const m = INVITE.exec(value);
  if (!m || value.length > LIMITS.invite) throw new UserError('To nie wygląda na link zaproszenia na Discorda. Wklej link w postaci https://discord.gg/abc123 albo https://discord.com/invite/abc123.');
  return m[1];
}

/** Asks Discord about the invite → { code, guildId, guildName, guildIcon, memberCount }. A dead or temporary invite is refused. */
async function resolveInvite(guild, code) {
  let invite;
  try {
    invite = await guild.client.fetchInvite(code);
  } catch (err) {
    if (err?.status === 404 || [10006, 50270].includes(err?.code)) throw new UserError(DEAD);
    throw problem(502, `Discord nie odpowiada – nie udało się sprawdzić zaproszenia (${truncate(String(err?.message ?? err), 120)}). Spróbuj ponownie za chwilę.`);
  }
  if (!invite?.guild?.id) throw new UserError('To zaproszenie nie prowadzi na serwer Discord (to może być zaproszenie do znajomych albo do grupy). Poproś partnera o zaproszenie na jego serwer.');
  if (invite.guild.id === guild.id) throw new UserError('To zaproszenie prowadzi na nasz własny serwer – wklej zaproszenie na serwer partnera.');
  if (invite.expiresTimestamp && invite.expiresTimestamp <= Date.now()) throw new UserError(DEAD);
  // A partner's channel lives for months: an invite that runs out in a week would leave a dead button behind.
  if (invite.expiresTimestamp) throw new UserError(`To zaproszenie wygaśnie ${plDate(invite.expiresTimestamp)} – przycisk „Dołącz do serwera” przestałby wtedy działać. Poproś partnera o zaproszenie bez terminu ważności (przy tworzeniu zaproszenia: „Wygasa po: Nigdy”).`);
  const icon = invite.guild.iconURL?.({ extension: 'png', size: 256 }) ?? null;
  return {
    code: invite.code ?? code,
    guildId: invite.guild.id,
    guildName: truncate(clean(invite.guild.name) || 'Serwer Discord', 100),
    guildIcon: /^https:\/\//.test(String(icon)) ? icon : null,
    memberCount: Number.isInteger(invite.memberCount) ? invite.memberCount : null,
  };
}

// ───────────── The form ─────────────
/**
 * What the panel sent, checked → { name, kind, description, icon, invite (code) | null, minecraft: { address, mc,
 * loader, pack, tags } | null }. Every message is a Polish sentence for the panel. Minecraft fields go through the
 * featured list's own checks later (featured.check) – here only what the partner form adds.
 */
function fieldsOf(body) {
  const name = clean(body.name);
  if (!name) throw new UserError('Wpisz nazwę partnera.');
  if (name.length > LIMITS.name) throw new UserError(`Nazwa może mieć najwyżej ${LIMITS.name} znaków (teraz ${name.length}).`);
  if (!KINDS.includes(body.kind)) throw new UserError('Wybierz rodzaj współpracy: Discord, Minecraft albo Discord + Minecraft.');
  const description = clean(body.description);
  if (!description) throw new UserError('Napisz kilka słów o partnerze – opis pokaże się na karcie.');
  if (description.length > LIMITS.description) throw new UserError(`Opis może mieć najwyżej ${LIMITS.description} znaków (teraz ${description.length}).`);
  const icon = featured.parseIcon(body.icon);
  const invite = hasDiscord(body.kind) ? parseInvite(body.invite) : null;
  let minecraft = null;
  if (hasMinecraft(body.kind)) {
    if (!clean(body.address)) throw new UserError('Wpisz adres serwera Minecraft partnera, np. mc.partner.pl.');
    const tags = featured.parseTags(body.tags).filter((t) => t !== PARTNER_TAG);
    if (tags.length > LIMITS.tags) throw new UserError(`Podaj najwyżej ${LIMITS.tags} tagów – szósty, „${PARTNER_TAG}”, bot dodaje sam.`);
    minecraft = { address: featured.parseAddress(body.address), mc: clean(body.mc) || null, loader: clean(body.loader).toLowerCase() || null, pack: clean(body.pack) || null, tags };
  }
  return { name, kind: body.kind, description, icon, invite, minecraft };
}

/** The partner's entry on the launcher's featured list – no picture: partner logos stay on the website and Discord. */
const featuredFields = (f, invite, by) => ({
  name: f.name, address: f.minecraft.address, description: f.description, tags: [PARTNER_TAG, ...f.minecraft.tags].join(','),
  icon: null, mc: f.minecraft.mc, loader: f.minecraft.loader, pack: f.minecraft.pack, addedBy: by,
});

/** "Kraina Craftu ⚒" → "kraina-craftu" (and "kraina-craftu-2" when taken) – also the logo's file name. */
function newId(guildId, name) {
  const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'partner';
  let id = base;
  for (let n = 2; find(guildId, id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Someone else has this name or this Discord server already. */
function checkUnique(guildId, { name, guildId: discordId }, except = null) {
  const others = list(guildId).filter((p) => p.id !== except);
  const same = others.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (same) throw new UserError(`Partner o nazwie „${same.name}” jest już na liście – wybierz inną nazwę albo edytuj tamtego partnera.`);
  const server = discordId && others.find((p) => p.discord?.guildId === discordId);
  if (server) throw new UserError(`Serwer Discord z tego zaproszenia jest już partnerem jako „${server.name}”.`);
}

/** A featured server – full list or an address that is taken – said as it is about the launcher. */
function checkFeatured(guildId, fields, except) {
  const room = featured.list(guildId).some((s) => s.id === except) || featured.list(guildId).length < featured.MAX_SERVERS;
  if (!room) throw new UserError(`Lista polecanych serwerów w launcherze jest pełna (${featured.MAX_SERVERS} z ${featured.MAX_SERVERS}) – usuń któryś w zakładce „Polecane serwery” albo wybierz współpracę „Discord”.`);
  return featured.check(guildId, fields, { except });
}

// ───────────── Discord: the category, the channel and its card ─────────────
const categoryLayout = () => require('../builder/layout').CATEGORIES.find((c) => c.key === CATEGORY) ?? null;
/** A partner's channel: read-only for members, the team (with Support) and the bot write – like #współpraca. */
const CHANNEL = { profile: 'readonly', posters: ['support'] };

/** 🤝 PARTNERSTWA – made (in its place in the layout) when /build has not made it yet. */
async function ensureCategory(guild) {
  const build = db.build(guild.id);
  const layout = categoryLayout();
  if (!build || !layout) throw problem(409, 'Serwer Discord nie jest jeszcze zbudowany – najpierw użyj na nim /zbuduj, wtedy bot wie, kto może pisać w kanałach partnerów.');
  const existing = guild.channels.cache.get(build.categories?.[CATEGORY] ?? '');
  if (existing) return existing;
  const { overwriteResolver } = require('../builder/executor');
  const { profile } = require('../builder/permissions');
  const style = require('../builder/style');
  const created = await guild.channels.create({ name: style.categoryName(layout.name), type: ChannelType.GuildCategory, permissionOverwrites: overwriteResolver(guild, build.roles ?? {})(profile(layout.profile)), reason: REASON }).catch((err) => {
    throw problem(502, `Nie udało się utworzyć kategorii ${layout.name} na Discordzie: ${require('../builder/executor').describeError(err)}`);
  });
  const categories = { ...(db.build(guild.id).categories ?? {}), [CATEGORY]: created.id };
  db.setBuild(guild.id, { ...db.build(guild.id), categories });
  await require('../builder/update').placeCategory(guild, CATEGORY, categories).catch(() => null); // a new category lands at the bottom
  return created;
}

/** "Kraina Craftu!" → the channel's name in the server's style: 🤝┃ᴋʀᴀɪɴᴀ-ᴄʀᴀꜰᴛᴜ. */
function channelName(name) {
  const label = name.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'partner';
  return require('../builder/style').channelName(`🤝 ${label}`);
}
const topicOf = (p) => truncate(`Partner ${config.brand.name} – ${p.description}`, 1024);

/** The picture next to the name: the uploaded logo (uploaded with the message), the icon address, the Discord server's icon. */
function picture(p) {
  const path = logos.file(p.logo);
  if (path) {
    const file = { attachment: path, name: `partner-logo.${p.logo.split('.').pop()}` };
    return { file, url: `attachment://${file.name}` };
  }
  const url = p.icon || p.discord?.guildIcon || null;
  return url ? { file: null, url } : null;
}

/** The card on the partner's channel. */
function card(guild, p) {
  const c = container(COLORS.brand);
  const pic = picture(p);
  header(c, `# 🤝 ${plain(p.name)}\n${plain(p.description)}`, pic?.url ?? null);
  const facts = [];
  if (p.discord?.memberCount) facts.push(`> ${e(guild, 'group')} **${people(p.discord.memberCount)}** na serwerze Discord`);
  if (p.minecraft) {
    const extra = [p.minecraft.mc, p.minecraft.loader && p.minecraft.loader[0].toUpperCase() + p.minecraft.loader.slice(1)].filter(Boolean).join(' · ');
    facts.push(`> 🎮 **Serwer Minecraft:** \`${p.minecraft.address}\`${extra ? ` · ${extra}` : ''}`);
  }
  if (facts.length) {
    c.addSeparatorComponents(divider());
    c.addTextDisplayComponents(text(`${facts.join('\n')}${p.minecraft ? '\n-# Ten serwer Minecraft znajdziesz też w Hammer Launcherze, w „Polecanych serwerach”.' : ''}`));
  }
  c.addSeparatorComponents(divider());
  c.addTextDisplayComponents(text(`-# ${KIND_LABELS[p.kind]} · partner ${config.brand.name} od ${ts(p.addedAt, 'D')}`));
  if (p.discord?.invite) c.addActionRowComponents(row(linkBtn(p.discord.invite, 'Dołącz do serwera', ce(guild, 'group'))));
  return v2(c, { files: pic?.file ? [pic.file] : [] });
}

const gone = (err) => err?.code === 10003 || err?.code === 10008 || err?.status === 404;
const describe = (err) => require('../builder/executor').describeError(err);

/**
 * The partner's channel and card as they should be now: made when missing (also when someone deleted the channel by
 * hand), renamed and edited when it is there → { channelId, messageId, warning }.
 */
async function placeOnDiscord(guild, p, previous) {
  const category = await ensureCategory(guild);
  const style = require('../builder/style');
  const name = channelName(p.name);
  let channel = guild.channels.cache.get(previous?.channelId ?? '') ?? null;
  let warning = null;
  if (!channel) {
    const { overwriteResolver, channelOverwrites } = require('../builder/executor');
    const resolve = overwriteResolver(guild, db.build(guild.id)?.roles ?? {});
    channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, topic: topicOf(p), permissionOverwrites: resolve(channelOverwrites(categoryLayout(), CHANNEL)), reason: REASON }).catch((err) => {
      throw problem(502, /CHANNEL_PARENT_MAX_CHANNELS/.test(String(err?.message)) ? 'W kategorii 🤝 PARTNERSTWA jest już 50 kanałów – tyle mieści Discord. Zakończ któreś partnerstwo albo przenieś kanały, które nie są partnerów.' : `Nie udało się utworzyć kanału partnera na Discordzie: ${describe(err)}`);
    });
  } else {
    // Discord lets a channel be renamed twice in 10 minutes – a third change waits for the next save (the card is updated anyway).
    if (!style.sameChannelName(channel.name, style.textChannelName(name))) {
      await channel.setName(name, REASON).catch(() => {
        warning = 'Nazwa kanału na Discordzie zostaje na razie stara – Discord pozwala zmienić ją tylko 2 razy na 10 minut. Zapisz partnera ponownie za kilka minut.';
      });
    }
    if (channel.topic !== topicOf(p)) await channel.edit({ topic: topicOf(p), reason: REASON }).catch(() => null);
  }
  const payload = card(guild, p);
  const old = previous?.channelId === channel.id && previous.messageId ? await channel.messages.fetch(previous.messageId).catch((err) => (gone(err) ? null : undefined)) : null;
  if (old === undefined) throw problem(502, 'Discord nie odpowiada – nie udało się zmienić karty partnera. Spróbuj ponownie za chwilę.');
  const message = old
    ? await old.edit(panels.forEdit(payload)).then(() => old).catch((err) => {
        throw problem(502, `Discord nie przyjął karty partnera: ${describe(err)}`);
      })
    : await channel.send(payload).catch((err) => {
        throw problem(502, `Nie udało się wysłać karty na kanał partnera: ${describe(err)}`);
      });
  return { channelId: channel.id, messageId: message.id, warning };
}

async function deleteChannel(guild, channelId) {
  const channel = guild.channels.cache.get(channelId ?? '');
  if (!channel) return false; // deleted by hand already – that is what we wanted
  await channel.delete(REASON).catch((err) => {
    if (!gone(err)) throw problem(502, `Nie udało się usunąć kanału partnera z Discorda: ${describe(err)}`);
  });
  return true;
}

// ───────────── Adding, changing, ending ─────────────
/** The logo the panel sent: undefined – keep it, null – take it off, { buffer, type } – a new picture. */
const logoChange = (logo) => (logo === undefined ? undefined : logo === null ? null : logo);

/** Adds a partner → { partner, warning }. Nothing is kept or left on Discord when a step fails. */
async function add(guild, body, by, { logo } = {}) {
  const f = fieldsOf(body);
  if (list(guild.id).length >= MAX_PARTNERS) throw new UserError(`Na liście może być najwyżej ${MAX_PARTNERS} partnerów – zakończ któreś partnerstwo, żeby dodać nowe.`);
  checkUnique(guild.id, { name: f.name });
  const invite = f.invite ? await resolveInvite(guild, f.invite) : null;
  checkUnique(guild.id, { name: f.name, guildId: invite?.guildId });
  if (f.minecraft) checkFeatured(guild.id, featuredFields(f, invite, by), null);
  const now = Date.now();
  const p = {
    id: newId(guild.id, f.name), name: f.name, kind: f.kind, description: f.description, icon: f.icon, logo: null,
    discord: null, minecraft: null, addedBy: by, addedAt: now, updatedBy: by, updatedAt: now,
  };
  if (logo) p.logo = logos.save(p.id, logo);
  let placed = null;
  try {
    if (invite) {
      p.discord = { invite: `https://discord.gg/${invite.code}`, ...invite, channelId: null, messageId: null };
      if (f.minecraft) p.minecraft = { ...f.minecraft, featuredId: null }; // (the card shows the address)
      placed = await placeOnDiscord(guild, p, null);
      Object.assign(p.discord, { channelId: placed.channelId, messageId: placed.messageId });
    }
    if (f.minecraft) p.minecraft = { ...f.minecraft, featuredId: featured.add(guild.id, featuredFields(f, invite, by)).id };
  } catch (err) {
    if (placed) await deleteChannel(guild, placed.channelId).catch(() => null);
    logos.remove(p.logo);
    throw err;
  }
  list(guild.id).push(p);
  db.save();
  return { partner: p, warning: placed?.warning ?? null };
}

/**
 * Changes a partner: the channel's name and card, the featured server; a new kind adds or takes away the channel and
 * the featured server → { partner, warning }.
 */
async function update(guild, id, body, by, { logo } = {}) {
  const p = find(guild.id, id);
  if (!p) throw problem(404, 'Nie ma takiego partnera – może ktoś go właśnie usunął. Odśwież stronę.');
  const f = fieldsOf(body);
  checkUnique(guild.id, { name: f.name }, p.id);
  // The invite again every time: a dead one is said now, and the name, icon and member count are fresh on the card.
  const invite = f.invite ? await resolveInvite(guild, f.invite) : null;
  checkUnique(guild.id, { name: f.name, guildId: invite?.guildId }, p.id);
  const featuredId = p.minecraft?.featuredId && featured.find(guild.id, p.minecraft.featuredId) ? p.minecraft.featuredId : null;
  if (f.minecraft) checkFeatured(guild.id, featuredFields(f, invite, by), featuredId);
  const change = logoChange(logo);
  const newLogo = change ? logos.save(p.id, change) : change === null ? null : p.logo;
  const next = {
    ...p, name: f.name, kind: f.kind, description: f.description, icon: f.icon, logo: newLogo, updatedBy: by, updatedAt: Date.now(),
    discord: invite ? { ...(p.discord ?? {}), invite: `https://discord.gg/${invite.code}`, ...invite } : null,
    minecraft: f.minecraft ? { ...f.minecraft, featuredId } : null,
  };
  let warning = null;
  try {
    if (invite) {
      const placed = await placeOnDiscord(guild, next, p.discord);
      Object.assign(next.discord, { channelId: placed.channelId, messageId: placed.messageId });
      warning = placed.warning;
    }
  } catch (err) {
    if (newLogo !== p.logo) logos.remove(newLogo);
    throw err;
  }
  // From here nothing waits for Discord: the old channel (Discord dropped), the featured server, the logo file.
  if (!invite && p.discord?.channelId) await deleteChannel(guild, p.discord.channelId).catch(() => null);
  if (f.minecraft) {
    const fields = featuredFields(f, invite, by);
    next.minecraft.featuredId = featuredId ? featured.update(guild.id, featuredId, fields).id : featured.add(guild.id, fields).id;
  } else if (featuredId) featured.remove(guild.id, featuredId);
  if (p.logo && p.logo !== newLogo) logos.remove(p.logo);
  Object.assign(p, next);
  db.save();
  return { partner: p, warning };
}

/**
 * Ends a partnership: its channel (if still there), its featured server and its logo go → the removed partner | null.
 * keepLogo: the file stays for now – the goodbye announcement still shows it (then dropLogo).
 */
async function remove(guild, id, { keepLogo = false } = {}) {
  const p = find(guild.id, id);
  if (!p) return null;
  if (p.discord?.channelId) await deleteChannel(guild, p.discord.channelId);
  if (p.minecraft?.featuredId) featured.remove(guild.id, p.minecraft.featuredId);
  if (!keepLogo) logos.remove(p.logo);
  const g = db.guild(guild.id);
  g.partners = g.partners.filter((x) => x !== p);
  db.save();
  return p;
}

// ───────────── #📢 ogłoszenia ─────────────
function announcementsChannel(guild) {
  const channel = guild.channels.cache.get(db.channelId(guild.id, 'announcements') ?? '');
  return channel?.isTextBased?.() ? channel : null;
}

/**
 * A short announcement – never with a ping: 'start' (a new partnership, with its links) or 'end' (a polite goodbye –
 * the partner is gone by then, its logo file not yet: remove(…, { keepLogo })). → { url, channelId, messageId, crossposted, title }
 */
async function announce(guild, p, what, by) {
  const channel = announcementsChannel(guild);
  if (!channel) throw problem(409, 'Na serwerze nie ma kanału #📢 ogłoszenia – dodaj go na Discordzie komendą /zbuduj tylko:update.');
  const name = plain(p.name);
  const lines = [];
  let title;
  let button = null;
  if (what === 'end') {
    title = `👋 Koniec partnerstwa z ${p.name}`;
    lines.push(`Niestety nasze partnerstwo z **${name}** dobiegło końca. Dziękujemy za wspólny czas i życzymy powodzenia! 🧡`);
  } else {
    title = `🤝 Nowe partnerstwo: ${p.name}`;
    lines.push(`Z radością ogłaszamy, że **${name}** zostaje naszym partnerem! 🧡`, `> ${plain(p.description)}`, '');
    const channelId = p.discord?.channelId && guild.channels.cache.has(p.discord.channelId) ? p.discord.channelId : null;
    if (channelId) lines.push(`> ${e(guild, 'group')} Ich serwer Discord: <#${channelId}>`);
    if (p.minecraft) lines.push(`> 🎮 Serwer Minecraft: \`${p.minecraft.address}\` – znajdziesz go też w launcherze, w „Polecanych serwerach”`);
    if (p.discord?.invite) button = { label: 'Dołącz do serwera', url: p.discord.invite };
  }
  const pic = picture(p);
  const payload = require('./announce').buildPanelAnnouncement(guild, `<@${by}>`, {
    title: truncate(title, 120), text: lines.join('\n').trim(), kind: 'ogloszenie', button, ping: 'none', banner: what !== 'end',
    thumbnail: pic ? { url: pic.file ? null : pic.url, file: pic.file } : null,
  });
  const sent = await channel.send(payload).catch((err) => {
    throw problem(502, `Discord nie przyjął ogłoszenia: ${truncate(String(err?.message ?? err), 200)}`);
  });
  const crossposted = channel.type === ChannelType.GuildAnnouncement ? Boolean(await sent.crosspost?.().catch(() => null)) : false;
  return { url: sent.url, channelId: channel.id, messageId: sent.id, crossposted, title: truncate(title, 120) };
}

// ───────────── For the panel and the website ─────────────
/** The picture to show on the website and in the panel: the uploaded logo, the icon address, the Discord server's icon. */
const imageOf = (p) => (logos.file(p.logo) ? logos.url(p.logo) : p.icon || p.discord?.guildIcon || null);

/** A partner as the panel lists it – with where it is now (a channel deleted by hand, a featured server removed). */
function panelRow(guild, p) {
  const channel = guild && p.discord?.channelId ? guild.channels.cache.get(p.discord.channelId) : null;
  return {
    id: p.id, name: p.name, kind: p.kind, kindLabel: KIND_LABELS[p.kind], description: p.description, icon: p.icon ?? null,
    logo: logos.file(p.logo) ? logos.url(p.logo) : null, image: imageOf(p),
    discord: p.discord ? { invite: p.discord.invite, guildName: p.discord.guildName, memberCount: p.discord.memberCount, channel: channel ? { id: channel.id, name: channel.name, url: channelUrl(guild.id, channel.id) } : null } : null,
    minecraft: p.minecraft ? { address: p.minecraft.address, mc: p.minecraft.mc, loader: p.minecraft.loader, pack: p.minecraft.pack, tags: p.minecraft.tags, featured: Boolean(guild && p.minecraft.featuredId && featured.find(guild.id, p.minecraft.featuredId)) } : null,
    addedBy: p.addedBy ?? null, addedAt: p.addedAt, updatedAt: p.updatedAt ?? p.addedAt,
  };
}

/** Newest first, for the panel. */
const panelList = (guild) => [...list(guild.id)].reverse().map((p) => panelRow(guild, p));

/** What the „Partnerzy” page shows – nothing about who added what. Newest first. */
const publicList = (guildId) =>
  [...list(guildId)].reverse().map((p) => ({
    id: p.id, name: p.name, kind: p.kind, kindLabel: KIND_LABELS[p.kind], description: p.description, image: imageOf(p),
    invite: p.discord?.invite ?? null, members: p.discord?.memberCount ?? null,
    address: p.minecraft?.address ?? null, mc: p.minecraft?.mc ?? null, loader: p.minecraft?.loader ?? null,
  }));

/** For the tab: is the server ready, where things go, how much room there is. */
function status(guild) {
  const category = guild ? guild.channels.cache.get(db.build(guild.id)?.categories?.[CATEGORY] ?? '') : null;
  return {
    built: Boolean(guild && db.build(guild.id)),
    category: category ? { id: category.id, name: category.name } : null,
    announcements: guild && announcementsChannel(guild) ? { name: announcementsChannel(guild).name } : null,
    count: guild ? list(guild.id).length : 0,
    max: MAX_PARTNERS,
    featured: { count: guild ? featured.list(guild.id).length : 0, max: featured.MAX_SERVERS },
    limits: { ...LIMITS, logoMb: logos.MAX_BYTES / 1024 / 1024 },
    loaders: featured.LOADERS,
  };
}

module.exports = {
  KINDS, KIND_LABELS, MAX_PARTNERS, LIMITS, CATEGORY, PARTNER_TAG,
  list, find, parseInvite, resolveInvite, fieldsOf, channelName, card, ensureCategory,
  add, update, remove, announce, panelList, panelRow, publicList, status, dropLogo: (name) => logos.remove(name),
};
