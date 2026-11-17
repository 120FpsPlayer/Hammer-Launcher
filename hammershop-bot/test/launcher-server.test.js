'use strict';

// The Hammer Launcher server after its second tidy-up: the #hammershop channel of our co-creator, no reminders about
// unclaimed tickets, and no „Zgłoś użytkownika” / „Odwołanie od kary” categories – tickets opened in them earlier
// still work.
process.env.HS_TEST_PROFILE = 'launcher';

const { db } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { textOf } = require('./helpers/fakeInteraction');
const { buildServer } = require('../src/builder/executor');
const { addMissing } = require('../src/builder/update');
const config = require('../src/lib/config');
const tickets = require('../src/tickets/tickets');
const reminders = require('../src/features/staffreminders');

config.defaults.openCooldownSeconds = 0;
config.defaults.deleteDelaySeconds = 0;

async function built() {
  const guild = new FakeGuild({ ownerId: '1' });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  return guild;
}
const channel = (guild, key) => guild.channels.cache.get(db.channelId(guild.id, key));
const text = (guild, key) => channel(guild, key).messageList.map((m) => textOf(m.body)).join('\n');
const json = (guild, key) => channel(guild, key).messageList.map((m) => JSON.stringify(m.body)).join('\n');
const staffOf = (guild) => guild.addMember('300000000000000201', [db.roleId(guild.id, 'member'), db.roleId(guild.id, 'support')]);

test('#hammershop: the co-creator\'s channel with its banner, what it sells and a link to its site', async () => {
  const guild = await built();
  const ch = channel(guild, 'hammershop');
  assert.ok(ch, 'the channel exists');
  assert.match(ch.name, /^🤝/); // the name itself is in small caps (server.smallCaps)
  assert.equal(ch.parentId, db.build(guild.id).categories.catLauncher, 'in the LAUNCHER category');
  assert.equal(ch.messageList.length, 2, 'a banner and the card');
  assert.match(ch.messageList[0].body.files[0].name, /hammershop\.png$/);
  const card = text(guild, 'hammershop');
  assert.match(card, /HammerShop – nasz współtwórca/);
  for (const word of ['Pluginy', 'Skrypty', 'Boty Discord', 'Serwery']) assert.match(card, new RegExp(word));
  assert.match(json(guild, 'hammershop'), /"url":"https:\/\/hammershop\.pl"/, 'a button to the partner\'s site');
  assert.doesNotMatch(json(guild, 'hammershop'), /Discord HammerShop/, 'no Discord button until an invite is set in the config');
  // The channel guide in #informacje names it; the readers can't write there.
  assert.match(text(guild, 'information'), new RegExp(`<#${ch.id}> – HammerShop, nasz współtwórca`));
});

test('#hammershop gets a Discord button once config.partner.discord is set, and none at all without links', async () => {
  const { postsFor } = require('../src/builder/content.launcher');
  const guild = await built();
  const x = { guild, ch: () => '#tickety', E: () => '•', brand: config.brand.name };
  const before = { ...config.partner };
  try {
    config.partner.discord = 'https://discord.gg/przyklad';
    const withInvite = JSON.stringify(postsFor('hammershop', x, null)[1].payload);
    assert.match(withInvite, /"label":"Discord HammerShop"/);
    assert.match(withInvite, /discord\.gg\/przyklad/);
    Object.assign(config.partner, { url: '', discord: '' });
    const bare = postsFor('hammershop', x, null)[1].payload.components[0].toJSON();
    assert.equal(bare.components.some((c) => c.type === 1), false, 'no empty button row (Discord rejects it)');
  } finally {
    Object.assign(config.partner, before);
  }
});

test('/build only:update adds #hammershop to a server built before it existed', async () => {
  const guild = await built();
  // Pretend the server was built by an older version: no #hammershop yet.
  const old = channel(guild, 'hammershop');
  await old.delete();
  const b = db.build(guild.id);
  const { hammershop: _gone, ...channels } = b.channels;
  const { hammershop: _posts, ...posts } = b.posts;
  db.setBuild(guild.id, { ...b, channels, posts });

  const res = await addMissing(guild);
  assert.deepEqual(res.errors, []);
  assert.equal(res.channels.length, 1);
  assert.match(res.channels[0], /^🤝/);
  assert.match(text(guild, 'hammershop'), /współtwórca/);
});

test('the ticket panel: no „Zgłoś użytkownika” and no „Odwołanie od kary”; the rules send appeals elsewhere', async () => {
  const guild = await built();
  assert.deepEqual(config.ticketTypes.map((t) => t.id), ['order', 'support', 'bug', 'plus', 'reward', 'apply']);
  const panel = `${text(guild, 'tickets')}\n${json(guild, 'tickets')}`;
  assert.doesNotMatch(panel, /Zgłoś użytkownika|Odwołanie od kary|ticket:open:(report|appeal)/);
  assert.match(panel, /Pomoc z launcherem/);
  const rules = text(guild, 'rules');
  assert.doesNotMatch(rules, /Odwołanie od kary/);
  assert.match(rules, /Od kary możesz się odwołać: napisz ticket \*\*Pomoc z launcherem\*\*/);
  assert.match(rules, /E-mail:\*\* hammerlauncherclient@gmail\.com/, 'the contact address is in §1');
  assert.match(text(guild, 'information'), /Wolisz e-mail\?.*hammerlauncherclient@gmail\.com/);
});

test('a ticket opened in a category that was removed later can still be claimed, closed and deleted', async () => {
  const guild = await built();
  const staff = staffOf(guild);
  const owner = guild.addMember('300000000000000202', [db.roleId(guild.id, 'member')]);
  const ch = await tickets.openTicket(owner, config.getType('support'), [{ label: 'Temat', value: 'Stare zgłoszenie' }]);
  db.updateTicket(ch.id, { typeId: 'report' }); // as if it had been opened as „Zgłoś użytkownika” before the update
  assert.equal(config.getType('report'), null);

  await tickets.claimTicket(ch, staff);
  assert.equal(db.getTicket(ch.id).claimedBy, staff.id);
  await tickets.closeTicket(ch, staff, 'załatwione');
  assert.equal(db.getTicket(ch.id).status, 'closed');
  await tickets.deleteTicket(ch, staff);
  assert.equal(db.getTicket(ch.id).status, 'deleted'); // the channel itself goes a few seconds later
});

test('no reminders about unclaimed tickets on this server – however long a ticket waits', async () => {
  const guild = await built();
  assert.equal(config.staffReminders.enabled, false);
  const owner = guild.addMember('300000000000000203', [db.roleId(guild.id, 'member')]);
  const ch = await tickets.openTicket(owner, config.getType('support'), [{ label: 'Temat', value: 'Czekam' }]);
  db.updateTicket(ch.id, { createdAt: Date.now() - 5 * 3_600_000 });
  const chat = channel(guild, 'staffChat');
  const before = chat.messageList.length;
  assert.equal(await reminders.sweep(guild.client, Date.now()), 0);
  assert.equal(await reminders.sweep(guild.client, Date.now() + 24 * 3_600_000), 0);
  assert.equal(chat.messageList.length, before, 'nothing posted, nobody pinged');
  assert.equal(db.getTicket(ch.id).unclaimedRemindedAt, undefined);
});
