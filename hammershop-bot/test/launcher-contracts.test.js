'use strict';

// Contracts between the website / bot and Hammer Launcher that broke where the two meet (fala K, integracja): what the
// owner can enter on this side must be something the launcher can use.

const { db } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FakeGuild } = require('./helpers/fakeDiscord');
const releases = require('../src/web/releases');
const store = require('../src/web/store');
const featured = require('../src/features/featured');

test('releases: the portable exe from the build artifact is refused as a release – installed launchers would "update" to it forever', async () => {
  store.load();
  fs.mkdirSync(releases.DIR(), { recursive: true });
  // The GitHub Actions artifact "Hammer-Launcher-Windows" holds both (package.json → build.nsis / build.portable).
  for (const name of ['Hammer-Launcher-Setup-2.11.4.exe', 'Hammer-Launcher-2.11.4-portable.exe', 'Hammer-Launcher-2.11.4-Portable.exe']) fs.writeFileSync(releases.fileOf(name), Buffer.from(`MZ ${name}`));
  // The panel guesses the version from the file name (web/public/assets/admin.js) – for the portable one "2.11.4-portable".
  await assert.rejects(releases.publish({ version: '2.11.4-portable', file: 'Hammer-Launcher-2.11.4-portable.exe' }), (err) => err.status === 400 && /przenośna \(portable\)/.test(err.message) && /Hammer-Launcher-Setup-/.test(err.message));
  await assert.rejects(releases.publish({ version: '2.11.4', file: 'Hammer-Launcher-2.11.4-Portable.exe' }), /przenośna/);
  assert.equal(store.currentRelease(), null, 'nothing was published');
  const release = await releases.publish({ version: '2.11.4', file: 'Hammer-Launcher-Setup-2.11.4.exe' });
  assert.equal(release.file, 'Hammer-Launcher-Setup-2.11.4.exe');
  assert.match(releases.latestYml(), /^path: Hammer-Launcher-Setup-2\.11\.4\.exe$/m);
});

test('featured servers: the modpack is a Modrinth slug / id the launcher can install – a pasted Modrinth link gives its slug, a display name is refused', () => {
  const guild = new FakeGuild();
  db.guild(guild.id);
  const base = { name: 'Paczka', description: 'Serwer z paczką modów.' };
  const add = (address, pack) => featured.add(guild.id, { ...base, name: `Paczka ${address.split('.')[0]}`, address, pack });
  assert.equal(add('a.example.com', 'fabulously-optimized').pack, 'fabulously-optimized');
  assert.equal(add('b.example.com', 'https://modrinth.com/modpack/cobblemon-fabric').pack, 'cobblemon-fabric');
  assert.equal(add('c.example.com', 'modrinth.com/modpack/1KVo5zza/version/5.0.0').pack, '1KVo5zza');
  assert.equal(add('d.example.com', 'https://www.modrinth.com/project/AANobbMI?x=1').pack, 'AANobbMI');
  assert.equal(add('e.example.com', '').pack, null);
  for (const bad of ['Fabulously Optimized', 'https://www.curseforge.com/minecraft/modpacks/rlcraft', 'ab']) {
    assert.throws(() => add(`x${bad.length}.example.com`, bad), /link z Modrinth/, bad);
  }
  // Whatever is stored passes the launcher's own check (hammer-launcher/src/main/featured.js drops anything else).
  const launcherInvite = path.join(__dirname, '..', '..', 'hammer-launcher', 'src', 'main', 'invite.js');
  if (fs.existsSync(launcherInvite)) {
    const { PACK } = require(launcherInvite);
    for (const s of featured.publicList(guild.id)) if (s.pack) assert.ok(PACK.test(s.pack), s.pack);
  }
});

test('the panel refuses a version that is not the one in the installer\'s name (no endless „update” loop on players\' PCs)', async () => {
  store.load();
  fs.mkdirSync(releases.DIR(), { recursive: true });
  fs.writeFileSync(releases.fileOf('Hammer-Launcher-Setup-2.11.5.exe'), Buffer.from('MZ 2.11.5'));
  await assert.rejects(releases.publish({ version: '2.12.0', file: 'Hammer-Launcher-Setup-2.11.5.exe' }), (err) => err.status === 400 && /wersja 2\.11\.5/.test(err.message));
  const release = await releases.publish({ version: '2.11.5', file: 'Hammer-Launcher-Setup-2.11.5.exe' });
  assert.equal(release.version, '2.11.5');
});
