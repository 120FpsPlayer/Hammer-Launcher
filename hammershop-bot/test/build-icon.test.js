'use strict';

// /zbuduj tylko:ikona – a new logo becomes the server icon, and the cards (which show the server icon in their corner)
// are redrawn right away, so they stop showing the old one.
process.env.HS_TEST_PROFILE = 'launcher';

const { db } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { createInteraction, lastResponse, textOf } = require('./helpers/fakeInteraction');
const { buildServer } = require('../src/builder/executor');
const handle = require('../src/handlers/interactions');
const loadCommands = require('../src/commands');

const commands = loadCommands();

test('/zbuduj tylko:ikona sets the Hammer Launcher logo as the server icon and redraws the cards', async () => {
  const guild = new FakeGuild({ ownerId: '1' });
  await buildServer({ guild, mode: 'add', invokerId: '1' });
  guild.iconSet = null; // as if the owner had another icon
  const owner = guild.members.cache.get('1') ?? guild.addMember('1');
  const i = createInteraction({ guild, member: owner, kind: 'command', commandName: 'build', options: { only: 'icon' } });
  await handle(i, commands);
  assert.equal(path.basename(guild.iconSet ?? ''), 'logo-launcher.png');
  assert.match(textOf(lastResponse(i)), /Ikona serwera to teraz aktualne logo[\s\S]*Karty odświeżone/);
  assert.ok(db.build(guild.id), 'the server stays built');
});

test('/zbuduj tylko:ikona on a server that was never built says so', async () => {
  const guild = new FakeGuild({ ownerId: '1' });
  const owner = guild.addMember('1');
  const i = createInteraction({ guild, member: owner, kind: 'command', commandName: 'build', options: { only: 'icon' } });
  await handle(i, commands);
  assert.match(textOf(lastResponse(i)), /nie został jeszcze zbudowany/);
});
