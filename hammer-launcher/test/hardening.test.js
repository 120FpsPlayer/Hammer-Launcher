'use strict';

/*
 * Bugs found in a review of the main process – things that worked on small test data and broke on a real
 * computer: a connection that drops, a file of a few gigabytes, a full disk, a file another program holds,
 * a launcher that was closed half-way. Every test here fails without its fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { download, sha1File } = require('../src/main/net');
const { readJson, writeJson } = require('../src/main/store');
const { createModrinth } = require('../src/main/modrinth');
const { createContent } = require('../src/main/content');
const { createInstances, slug } = require('../src/main/instances');
const { createPaths } = require('../src/main/paths');
const { createAccounts, createCrypt } = require('../src/main/accounts');
const { createServices } = require('../src/main/services');
const worlds = require('../src/main/worlds');
const versions = require('../src/main/versions');
const { writeNbt, tag } = require('../src/main/nbt');
const { tmpDir, fabricJar, mrVersion, sha1 } = require('./helpers');

/** Replaces fs.renameSync for the length of `fn`: `fail(to)` returns an error code for a rename that must fail. */
function withRename(fail, fn) {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    const code = fail(String(to));
    if (code) throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code });
    return real(from, to);
  };
  try {
    return fn();
  } finally {
    fs.renameSync = real;
  }
}

/* ── downloads ── */

test('download: no connection, or one that drops in the middle, is said in Polish – not "fetch failed" / "terminated"', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'mods', 'sodium.jar');
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(download('https://cdn.modrinth.com/data/x/sodium.jar', dest, { fetchFn: offline }), /^Error: Nie udało się pobrać pliku sodium\.jar – połączenie z internetem nie działa albo zostało przerwane\. Sprawdź internet i spróbuj ponownie\.$/);
  // The file starts to arrive and the line goes dead.
  const cut = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': '1000000' }),
    body: new ReadableStream({
      pull(c) {
        if (this.sent) return c.error(new TypeError('terminated'));
        this.sent = true;
        return c.enqueue(new Uint8Array(50_000));
      },
    }),
  });
  const err = await download('https://cdn.modrinth.com/data/x/sodium.jar', dest, { fetchFn: cut }).then(
    () => null,
    (e) => e,
  );
  assert.match(err?.message ?? '', /połączenie z internetem nie działa albo zostało przerwane/);
  assert.equal(err.cause?.message, 'terminated', 'the technical reason stays attached for the log');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), [], 'half a file is not left behind');
  // Other errors keep their own words.
  await assert.rejects(download('https://cdn.modrinth.com/data/x/sodium.jar', dest, { fetchFn: async () => new Response('nope', { status: 503 }) }), /HTTP 503/);
});

test('version lists without a connection: a Polish sentence for the window, not "fetch failed"', async () => {
  const real = globalThis.fetch;
  versions._cache.clear();
  try {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(versions.minecraftVersions(), /^Error: Nie udało się pobrać listy wersji Minecrafta – sprawdź internet i spróbuj ponownie\.$/);
    for (const loader of ['fabric', 'quilt', 'neoforge', 'forge']) await assert.rejects(versions.loaderVersions(loader, '1.21.1'), /^Error: Nie udało się pobrać listy wersji loadera modów – sprawdź internet i spróbuj ponownie\.$/, loader);
    // The login page of a school or hotel network instead of the list.
    globalThis.fetch = async () => new Response('<!DOCTYPE html><html>Zaloguj się do sieci</html>', { status: 200 });
    await assert.rejects(versions.minecraftVersions(), /sprawdź internet/);
    await assert.rejects(versions.loaderVersions('fabric', '1.21.1'), /sprawdź internet/);
    // A server that answers with an error keeps its own words, and a loader nobody knows has no versions.
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    await assert.rejects(versions.loaderVersions('forge', '1.21.1'), /Forge: HTTP 503/);
    assert.deepEqual(await versions.loaderVersions('vanilla', '1.21.1'), []);
    // Back online: nothing of the failures was kept.
    globalThis.fetch = async () => new Response(JSON.stringify({ latest: {}, versions: [{ id: '1.21.1', type: 'release', releaseTime: '2024-08-08' }, { id: '24w33a', type: 'snapshot', releaseTime: '2024-08-15' }] }));
    assert.deepEqual((await versions.minecraftVersions()).map((v) => v.id), ['1.21.1']);
  } finally {
    globalThis.fetch = real;
    versions._cache.clear();
  }
});

/* ── a file bigger than 2 GiB (a high-resolution resource pack) ── */

function contentSetup() {
  const jar1 = fabricJar({ id: 'sodium', name: 'Sodium', version: '0.6.0' });
  const jar2 = fabricJar({ id: 'sodium', name: 'Sodium', version: '0.6.1', newer: true });
  const versions = {
    sod1: mrVersion({ id: 'sod1', projectId: 'AANobbMI', number: '0.6.0', file: { name: 'sodium-0.6.0.jar', body: jar1 } }),
    sod2: mrVersion({ id: 'sod2', projectId: 'AANobbMI', number: '0.6.1', file: { name: 'sodium-0.6.1.jar', body: jar2 } }),
    // (some mods keep one file name for every version)
    sod3: mrVersion({ id: 'sod3', projectId: 'AANobbMI', number: '0.6.2', file: { name: 'sodium-0.6.0.jar', body: jar2 } }),
  };
  const net = { online: true };
  const fetchFn = async (address) => {
    const url = String(address);
    if (/cdn\.modrinth\.com/.test(url)) {
      if (!net.online) throw new TypeError('fetch failed');
      const version = Object.values(versions).find((v) => v.files[0].url === url);
      const body = version.id === 'sod1' ? jar1 : jar2;
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    const version = /\/version\/(\w+)$/.exec(url)?.[1];
    if (version) return new Response(JSON.stringify(versions[version]));
    if (/\/project\/[^/]+$/.test(url)) return new Response(JSON.stringify({ id: 'AANobbMI', slug: 'sodium', title: 'Sodium' }));
    return new Response('nope', { status: 404 });
  };
  const instances = createInstances(createPaths(tmpDir()));
  const instance = instances.create({ name: 'Test', mcVersion: '1.21.1', loader: 'fabric' });
  const content = createContent({ modrinth: createModrinth({ fetchFn, sleep: async () => {} }), fetchFn });
  const mods = () => fs.readdirSync(path.join(instance.dir, 'mods')).sort();
  return { content, instance, instances, net, mods, jar1, jar2, versions };
}

test('a file over 2 GiB in an instance does not break its list (the checksum is read piece by piece)', async (t) => {
  const { content, instance } = contentSetup();
  const small = path.join(instance.dir, 'resourcepacks', 'Zwykła paczka.zip');
  fs.writeFileSync(small, 'paczka');
  assert.equal(sha1File(small), sha1(Buffer.from('paczka')));
  const big = path.join(instance.dir, 'resourcepacks', 'Patrix 512x.zip');
  const size = 2 * 1024 ** 3 + 5;
  fs.writeFileSync(big, 'PK');
  fs.truncateSync(big, size); // a hole: it takes no room on the disk
  if (fs.statSync(big).blocks * 512 > 64 * 1024 * 1024) {
    fs.rmSync(big, { force: true });
    return t.skip('this disk has no sparse files – a 2 GiB test file would really take 2 GiB');
  }
  try {
    const list = content.list(instance, 'resourcepack');
    assert.deepEqual(list.map((p) => [p.file, p.size]), [['Patrix 512x.zip', size], ['Zwykła paczka.zip', 6]]);
    assert.match(list[0].sha1, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(big, { force: true });
  }
  return undefined;
});

/* ── another version of an installed mod ── */

test('content: picking another version of a mod keeps the old file until the new one is really here', async () => {
  const { content, instance, net, mods, jar1, jar2, versions } = contentSetup();
  await content.install(instance, { projectId: 'AANobbMI', versionId: 'sod1', type: 'mod' });
  assert.deepEqual(mods(), ['sodium-0.6.0.jar']);

  // The connection is gone: the mod that works stays, with everything the list knows about it.
  net.online = false;
  await assert.rejects(content.install(instance, { projectId: 'AANobbMI', versionId: 'sod2', type: 'mod' }), /Nie udało się pobrać pliku sodium-0\.6\.1\.jar/);
  assert.deepEqual(mods(), ['sodium-0.6.0.jar']);
  assert.deepEqual(content.list(instance, 'mod').map((m) => [m.file, m.versionId, m.projectId]), [['sodium-0.6.0.jar', 'sod1', 'AANobbMI']]);
  await assert.rejects(content.installVersion(instance, 'mod', versions.sod2, { title: 'Sodium' }), /Nie udało się pobrać pliku/);
  assert.deepEqual(mods(), ['sodium-0.6.0.jar'], 'the same for an exact version (a recipe, an update)');

  // Back online: the new version goes in and the old file goes.
  net.online = true;
  const res = await content.install(instance, { projectId: 'AANobbMI', versionId: 'sod2', type: 'mod' });
  assert.deepEqual(res.installed, ['Sodium']);
  assert.deepEqual(mods(), ['sodium-0.6.1.jar']);
  assert.deepEqual(content.list(instance, 'mod').map((m) => [m.file, m.versionId]), [['sodium-0.6.1.jar', 'sod2']]);

  // A new version under the very name of the old file, which was switched off: one file, switched on (as before).
  await content.install(instance, { projectId: 'AANobbMI', versionId: 'sod1', type: 'mod' });
  content.setEnabled(instance, 'mod', 'sodium-0.6.0.jar', false);
  assert.deepEqual(mods(), ['sodium-0.6.0.jar.disabled']);
  await content.install(instance, { projectId: 'AANobbMI', versionId: 'sod3', type: 'mod' });
  assert.deepEqual(mods(), ['sodium-0.6.0.jar']);
  assert.ok(fs.readFileSync(path.join(instance.dir, 'mods', 'sodium-0.6.0.jar')).equals(jar2) && !jar1.equals(jar2));
  assert.deepEqual(content.list(instance, 'mod').map((m) => [m.file, m.versionId, m.enabled]), [['sodium-0.6.0.jar', 'sod3', true]]);
});

test('content: a dropped file only goes in when its list shows that kind – a pack dropped on Mods is not „added” and lost', () => {
  const { content, instance } = contentSetup();
  const drop = tmpDir();
  for (const name of ['Sodium.JAR', 'Faithful 32x.zip', 'notatki.txt']) fs.writeFileSync(path.join(drop, name), name);
  const all = fs.readdirSync(drop).map((name) => path.join(drop, name));
  assert.deepEqual(content.importFiles(instance, 'mod', all), ['Sodium.JAR']);
  assert.deepEqual(fs.readdirSync(path.join(instance.dir, 'mods')), ['Sodium.JAR'], 'the pack did not end up in mods/, where no list would show it');
  assert.deepEqual(content.importFiles(instance, 'resourcepack', all), ['Faithful 32x.zip']);
  assert.deepEqual(content.importFiles(instance, 'shader', all), ['Faithful 32x.zip']);
  assert.deepEqual([fs.readdirSync(path.join(instance.dir, 'resourcepacks')), fs.readdirSync(path.join(instance.dir, 'shaderpacks'))], [['Faithful 32x.zip'], ['Faithful 32x.zip']]);
  assert.deepEqual(content.list(instance, 'resourcepack').map((p) => p.file), ['Faithful 32x.zip'], 'what was added is on the list');
  // Picked from the instance's own folder: it is there already – no error, the file is untouched.
  assert.deepEqual(content.importFiles(instance, 'mod', [path.join(instance.dir, 'mods', 'Sodium.JAR')]), ['Sodium.JAR']);
  assert.equal(fs.readFileSync(path.join(instance.dir, 'mods', 'Sodium.JAR'), 'utf8'), 'Sodium.JAR');
  assert.deepEqual(content.importFiles(instance, 'mod', []), []);
});

/* ── instances ── */

test('instances: a copy that fails half-way leaves no broken instance behind, and a world\'s session.lock is not copied', () => {
  const instances = createInstances(createPaths(tmpDir()));
  const original = instances.create({ name: 'Hammer', mcVersion: '1.21.1', loader: 'fabric' });
  const world = path.join(original.dir, 'saves', 'Nasz świat');
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(world, 'level.dat'), 'level');
  fs.writeFileSync(path.join(world, 'session.lock'), '☃'); // on Windows a running game does not let anybody read it
  fs.writeFileSync(path.join(original.dir, 'mods', 'sodium.jar'), 'jar');

  const copy = instances.duplicate(original.id);
  assert.deepEqual(fs.readdirSync(path.join(copy.dir, 'saves', 'Nasz świat')), ['level.dat']);
  assert.equal(fs.readFileSync(path.join(copy.dir, 'mods', 'sodium.jar'), 'utf8'), 'jar');
  instances.remove(copy.id);

  // The disk fills up in the middle of the copy.
  const real = fs.cpSync;
  fs.cpSync = (from, to) => {
    fs.mkdirSync(path.join(to, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(to, 'mods', 'sodium.jar'), 'ja');
    throw Object.assign(new Error("ENOSPC: no space left on device, copyfile 'a' -> 'b'"), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => instances.duplicate(original.id), /^Error: Nie udało się skopiować instancji: na dysku zabrakło miejsca\.$/);
  } finally {
    fs.cpSync = real;
  }
  assert.deepEqual(instances.list().map((i) => i.name), ['Hammer'], 'no half-made „Hammer (kopia)” on the list');
  assert.deepEqual(fs.readdirSync(path.dirname(original.dir)), [original.id], '… nor on the disk');
});

test('instances: a name Windows keeps for a device (CON, NUL, COM1 …) never becomes the folder of an instance', () => {
  for (const name of ['CON', 'con', 'Nul', 'AUX', 'prn', 'COM1', 'lpt9']) assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug(name)), `${name} → ${slug(name)}`);
  assert.deepEqual([slug('Hammer'), slug('Con-fig'), slug('Łódź & Kraków!'), slug('com10')], ['hammer', 'con-fig', 'lodz-krakow', 'com10'], 'other names stay as they were');
  const instances = createInstances(createPaths(tmpDir()));
  const a = instances.create({ name: 'Nul', mcVersion: '1.21.1', loader: 'vanilla' });
  const b = instances.create({ name: 'Nul', mcVersion: '1.21.1', loader: 'vanilla' });
  assert.equal(a.name, 'Nul', 'the name the player sees is theirs');
  assert.ok(/^[a-z0-9-]{1,48}$/.test(a.id) && /^[a-z0-9-]{1,48}$/.test(b.id) && a.id !== b.id && a.id !== 'nul' && b.id !== 'nul');
});

/* ── accounts ── */

test('accounts: a stored sign-in that cannot be decrypted any more asks for a new sign-in, in Polish', async () => {
  class FakeAuth {
    async launch() {
      return FakeAuth.xbox('refresh-1', 'mc-token-1');
    }
    async refresh() {
      return FakeAuth.xbox('refresh-2', 'mc-token-2');
    }
    static xbox(refresh, mcToken) {
      return { save: () => refresh, getMinecraft: async () => ({ mcToken, exp: Date.now() + 3600e3, xuid: '1', profile: { id: 'uuid-1', name: 'Gracz', skins: [] } }) };
    }
  }
  const file = path.join(tmpDir(), 'accounts.json');
  let key = null;
  await createAccounts({ file, crypt: createCrypt({ keyFile: 'k', readKey: () => key, writeKey: (f, k) => (key = k) }), AuthClass: FakeAuth }).login();

  // The launcher folder was copied to another computer (or the key file is gone): another key.
  let otherKey = null;
  const moved = createAccounts({ file, crypt: createCrypt({ keyFile: 'k', readKey: () => otherKey, writeKey: (f, k) => (otherKey = k) }), AuthClass: FakeAuth });
  await assert.rejects(moved.launchAuth('uuid-1'), /^Error: Sesja konta Gracz wygasła – zaloguj się ponownie w zakładce Konta\.$/);
  assert.equal(moved.list()[0].needsLogin, true, 'the account is marked: the window shows „zaloguj się ponownie”');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accounts[0].needsLogin, true, '… also after a restart');

  // The system keychain refuses (Windows: another user profile) – Electron's own English sentence never reaches the player.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text),
    decryptString: () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    },
  };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(data.accounts[0], { refresh: 's:AAAA', token: 's:AAAA', needsLogin: false });
  fs.writeFileSync(file, JSON.stringify(data));
  const locked = createAccounts({ file, crypt: createCrypt({ safeStorage }), AuthClass: FakeAuth });
  const err = await locked.launchAuth('uuid-1').then(
    () => null,
    (e) => e,
  );
  assert.match(err?.message ?? '', /^Sesja konta Gracz wygasła – zaloguj się ponownie/);
  assert.ok(!/decrypt/i.test(err.message));
  assert.equal(locked.list()[0].needsLogin, true);
  // Signing in again puts everything right.
  assert.equal((await locked.login()).needsLogin, false);

  // The connection drops in the middle of a sign-in (after Microsoft's page): the same sentence as at a start of the game.
  FakeAuth.prototype.launch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(locked.login(), /^Error: Nie udało się połączyć z serwerami Microsoft – sprawdź internet i spróbuj ponownie\.$/);
  FakeAuth.prototype.launch = async () => {
    throw 'error.gui.closed'; // (msmc throws its error codes as plain strings)
  };
  await assert.rejects(locked.login(), /Okno logowania zostało zamknięte/);
});

/* ── worlds ── */

const level = (name) => writeNbt(Object.assign(tag.compound({ Data: tag.compound({ LevelName: tag.string(name), GameType: tag.int(0) }) }), { name: '' }), { gzip: true });

function worldSetup() {
  const instance = { id: 'hammer', dir: path.join(tmpDir(), 'instances', 'hammer') };
  const dir = path.join(instance.dir, 'saves', 'Nasz świat');
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), level('Nasz świat'));
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), Buffer.alloc(4096, 1));
  return { instance, dir, backups: path.join(instance.dir, 'backups') };
}

test('worlds: a world that was wiped – only the game\'s session.lock is left – can still be put back from a backup', async () => {
  const { instance, dir } = worldSetup();
  const backup = await worlds.backup(instance, 'Nasz świat', { auto: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'session.lock'), '☃'); // the game writes it into any folder it opens
  const res = await worlds.restoreInPlace(instance, 'Nasz świat', backup.file);
  assert.deepEqual([res.folder, res.safety], ['Nasz świat', null], 'nothing worth keeping was there – no backup of it');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['level.dat', 'region']);
  assert.deepEqual(fs.readdirSync(path.join(instance.dir, 'saves')), ['Nasz świat']);
  assert.deepEqual((await worlds.listBackups(instance)).map((b) => b.file), [backup.file]);
});

test('worlds: what a backup that was cut off left behind (…zip.part) is removed by the next backup – and nothing else is', async () => {
  const { instance, backups } = worldSetup();
  fs.mkdirSync(backups, { recursive: true });
  // The computer was shut down while the launcher packed these.
  const cutOff = ['Nasz świat-2026-11-10_18-05-auto.zip.part', 'Nasz świat-2026-11-10_18-07.zip.part', 'Inny-2026-11-09_21-40-przed-przywroceniem (2).zip.part'];
  for (const name of cutOff) fs.writeFileSync(path.join(backups, name), Buffer.alloc(50_000, 9));
  // Not the launcher's: left alone.
  const foreign = ['pobieranie.zip.part', 'Nasz świat-2026-11-08_12-00.zip', 'notatki.txt'];
  for (const name of foreign) fs.writeFileSync(path.join(backups, name), 'x');
  fs.mkdirSync(path.join(backups, 'Folder-2026-11-10_18-05.zip.part'));

  const seen = [];
  const made = await worlds.backup(instance, 'Nasz świat', { now: new Date(2026, 10, 12, 18, 5), onProgress: () => seen.push(fs.readdirSync(backups).filter((f) => f.endsWith('.part')).sort()) });
  assert.equal(made.file, 'Nasz świat-2026-11-12_18-05.zip');
  assert.ok(seen.length && seen.every((parts) => parts.includes('Nasz świat-2026-11-12_18-05.zip.part')), 'the backup being packed keeps its own .part file');
  assert.deepEqual(fs.readdirSync(backups).sort(), ['Folder-2026-11-10_18-05.zip.part', made.file, ...foreign].sort());
});

/* ── the end of a game session ── */

test('services: the game closes while instance.json cannot be written (a full disk) – the session still ends properly', async () => {
  const events = [];
  const child = new EventEmitter();
  child.kill = () => child.emit('exit', 0, null);
  const s = createServices({ root: tmpDir(), config: { brand: 'HammerShop' }, accounts: { list: () => [], launchAuth: async () => Promise.reject(new Error('Zaloguj się kontem Microsoft.')) }, emit: (channel, payload) => events.push({ channel, ...payload }), launchFn: async () => child });
  const instance = s.instances.create({ name: 'Hammer', mcVersion: '1.21.1', loader: 'fabric' });
  // main.js listens after the services: this is where the launcher window comes back.
  const ended = [];
  s.games.on('state', (e) => (e.state === 'exited' || e.state === 'crashed') && ended.push(e.state));
  await s.games.start({ instance: s.instances.get(instance.id), options: {} });
  withRename(
    (to) => (to.endsWith('instance.json') ? 'ENOSPC' : null),
    () => assert.doesNotThrow(() => child.emit('exit', 0, null), 'an error here is an uncaught exception of the launcher'),
  );
  await s.afterSessions();
  assert.deepEqual(ended, ['exited'], 'the listeners after the services still run');
  assert.equal(s.games.isRunning(instance.id), false);
  assert.deepEqual(fs.readdirSync(instance.dir).filter((f) => f.endsWith('.tmp')), [], 'and no temp file is left in the instance');
  assert.equal(s.instances.get(instance.id).name, 'Hammer', 'instance.json is as it was');
});

/* ── small JSON files ── */

test('store: a rename Windows refuses for a moment is tried again; a write that fails leaves no temp file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  writeJson(file, { accent: 'orange' });

  // An antivirus holds settings.json twice, then lets go.
  let refused = 0;
  withRename(
    () => (refused++ < 2 ? 'EPERM' : null),
    () => writeJson(file, { accent: 'gold' }),
  );
  assert.equal(refused, 3);
  assert.deepEqual(readJson(file, null), { accent: 'gold' });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);

  // It never lets go: the error comes out, the file is as it was, nothing is left next to it.
  assert.throws(() => withRename(() => 'EBUSY', () => writeJson(file, { accent: 'red' })), { code: 'EBUSY' });
  assert.deepEqual(readJson(file, null), { accent: 'gold' });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);

  // An error that waiting cannot cure is not tried again.
  let tries = 0;
  assert.throws(() => withRename(() => ((tries += 1), 'ENOSPC'), () => writeJson(file, { accent: 'red' })), { code: 'ENOSPC' });
  assert.equal(tries, 1);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});
