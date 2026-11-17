'use strict';

/**
 * Instances – separate game folders, each with its own Minecraft version, mod loader, mods, worlds and options.
 * instances/<id>/instance.json holds the settings; the rest of the folder is the game directory.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./store');
const { fileReason, walk } = require('./fsutil');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const ICONS = ['hammer', 'grass', 'diamond', 'sword', 'pickaxe', 'creeper', 'nether', 'end', 'rocket', 'star'];
const CONTENT_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
// What „Duplikuj” leaves with the original: it tells the story of the original, not of the copy – its logs and crash
// reports, the zips of its worlds (often bigger than the worlds themselves), its screenshots (Galeria would show each
// one twice), the restore points of its mod updates and its FPS test results. Paths inside the instance folder.
const NOT_COPIED = ['logs', 'crash-reports', 'backups', 'screenshots', '.hammer/przywracanie', '.hammer/benchmarks.json'];
const copied = (rel) => rel !== 'instance.json' && path.posix.basename(rel) !== 'session.lock' && !NOT_COPIED.some((p) => rel === p || rel.startsWith(`${p}/`));

function slug(text) {
  const id = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'instancja';
  // Windows keeps a few names for devices: a folder called "con" or "nul" cannot be opened by the game or the Explorer.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(id) ? `instancja-${id}` : id;
}

/** Validates the editable fields of an instance (from the UI) – unknown keys are dropped. */
function clean(data, base = {}) {
  const out = { ...base };
  if (typeof data.name === 'string' && data.name.trim()) out.name = data.name.trim().slice(0, 48);
  if (typeof data.mcVersion === 'string' && /^[\w.\-+ ]{1,40}$/.test(data.mcVersion)) out.mcVersion = data.mcVersion;
  if (LOADERS.includes(data.loader)) out.loader = data.loader;
  if ('loaderVersion' in data) out.loaderVersion = data.loaderVersion ? String(data.loaderVersion).slice(0, 64) : null;
  if (ICONS.includes(data.icon)) out.icon = data.icon;
  if ('memoryMb' in data) out.memoryMb = data.memoryMb == null || data.memoryMb === '' ? null : Math.min(65536, Math.max(1024, Math.round(Number(data.memoryMb)) || 1024));
  if ('jvmPreset' in data) out.jvmPreset = ['recommended', 'zgc', 'vanilla', 'custom'].includes(data.jvmPreset) ? data.jvmPreset : null;
  if (typeof data.customJvmArgs === 'string') out.customJvmArgs = data.customJvmArgs.slice(0, 2000);
  if (typeof data.javaPath === 'string') out.javaPath = data.javaPath.trim();
  if ('optimized' in data) out.optimized = Boolean(data.optimized);
  if ('autoJoinServer' in data) out.autoJoinServer = Boolean(data.autoJoinServer);
  if ('hammerClient' in data) out.hammerClient = Boolean(data.hammerClient);
  // null = the launcher setting (Ustawienia / Optymalizacja)
  if ('processPriority' in data) out.processPriority = ['normal', 'above_normal', 'high'].includes(data.processPriority) ? data.processPriority : null;
  return out;
}

/** `t` puts the launcher's own words in names it makes up ("(kopia)") into the player's language – see i18n.js. */
function createInstances(paths, { t = (text) => text, lang = () => 'pl_pl' } = {}) {
  const dir = (id) => path.join(paths.instances, id);
  const file = (id) => path.join(dir(id), 'instance.json');
  const exists = (id) => /^[a-z0-9-]{1,48}$/.test(String(id)) && fs.existsSync(file(id));

  function get(id) {
    if (!exists(id)) return null;
    const data = readJson(file(id), null);
    return data ? { ...data, id, dir: dir(id) } : null;
  }

  function list() {
    if (!fs.existsSync(paths.instances)) return [];
    return fs
      .readdirSync(paths.instances, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(d.name))
      .map((d) => get(d.name))
      .filter(Boolean)
      .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  function save(instance) {
    const { dir: _dir, id, ...data } = instance;
    writeJson(file(id), data);
    return get(id);
  }

  /**
   * `unfinished` ('copy' | 'modpack') marks an instance that is still being copied or installed into: the mark goes when
   * it is complete, and one that is still there at the next start was cut off half-way (see services.js).
   */
  function create(data, { unfinished = null } = {}) {
    const fields = clean(data, { name: 'Nowa instancja', mcVersion: null, loader: 'vanilla', loaderVersion: null, icon: 'grass', memoryMb: null, jvmPreset: null, customJvmArgs: '', javaPath: '', optimized: false, hammerClient: true });
    if (!fields.mcVersion) throw new Error('Wybierz wersję Minecrafta.');
    let id = slug(fields.name);
    while (fs.existsSync(dir(id))) id = `${slug(fields.name).slice(0, 25)}-${crypto.randomBytes(3).toString('hex')}`;
    for (const sub of Object.values(CONTENT_DIRS)) fs.mkdirSync(path.join(dir(id), sub), { recursive: true });
    // The game starts in the launcher's language – Polish, or English in the English launcher (changeable in the game).
    // onboardAccessibility:false – no narrator onboarding screen before the main menu on the first start.
    const gameLang = /^[a-z]{2}_[a-z]{2}$/.test(String(lang?.() ?? '')) ? lang() : 'pl_pl';
    fs.writeFileSync(path.join(dir(id), 'options.txt'), `lang:${gameLang}\nonboardAccessibility:false\n`);
    const instance = { ...fields, id, createdAt: Date.now(), lastPlayed: null, playTimeMs: 0, versionId: null, installedFor: null, ...(data.modpack ? { modpack: data.modpack } : {}), ...(unfinished ? { unfinished } : {}) };
    return save(instance);
  }

  function update(id, patch) {
    const current = get(id);
    if (!current) throw new Error('Nie ma takiej instancji.');
    const next = clean(patch, current);
    // Another version or loader means the game has to be prepared again before the next start.
    if (next.mcVersion !== current.mcVersion || next.loader !== current.loader || next.loaderVersion !== current.loaderVersion) {
      next.versionId = null;
      next.installedFor = null;
    }
    return save(next);
  }

  /** Internal fields the launcher sets itself (versionId, lastPlayed, play time …). */
  function patchInternal(id, patch) {
    const current = get(id);
    if (!current) return null;
    return save({ ...current, ...patch });
  }

  function remove(id) {
    if (!exists(id)) throw new Error('Nie ma takiej instancji.');
    fs.rmSync(dir(id), { recursive: true, force: true });
    return true;
  }

  /**
   * „Duplikuj”: a new instance with the files of `id` – except what belongs to the original only (NOT_COPIED).
   * Asynchronous, file by file: an instance of many gigabytes takes minutes and must not freeze the window.
   * The copy is on the list from its first moment, marked unfinished; `onCreated(copy)` tells who made it,
   * `onProgress({ done, total })` counts bytes. Returns the finished copy.
   */
  async function duplicate(id, { onCreated, onProgress } = {}) {
    const current = get(id);
    if (!current) throw new Error('Nie ma takiej instancji.');
    const copy = create({ ...current, name: `${current.name} ${t('(kopia)')}`.slice(0, 48) }, { unfinished: 'copy' });
    onCreated?.(copy);
    try {
      const files = [];
      let total = 0;
      // session.lock of a world: a running game holds it (Windows refuses to read it then) and it is useless in a copy.
      const { partial } = await walk(dir(id), (f) => copied(f.rel) && (files.push(f), (total += f.size)));
      if (partial) throw new Error('ta instancja ma za dużo plików');
      const free = await fsp.statfs(paths.instances).then((s) => s.bavail * s.bsize, () => Infinity);
      if (total > free) throw new Error(`na dysku zabrakło miejsca (kopia potrzebuje około ${Math.max(1, Math.ceil(total / 1024 ** 3))} GB)`);
      let done = 0;
      onProgress?.({ done, total });
      const made = new Set();
      for (const f of files) {
        const target = path.join(dir(copy.id), ...f.rel.split('/'));
        if (!made.has(path.dirname(target))) {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          made.add(path.dirname(target));
        }
        await fsp.copyFile(f.path, target);
        done += f.size;
        onProgress?.({ done: Math.min(done, total), total });
      }
      return patchInternal(copy.id, { versionId: current.versionId, installedFor: current.installedFor, optimized: current.optimized, unfinished: undefined });
    } catch (err) {
      // Half a copy (the disk filled up, a file was held by another program) is not an instance – it goes again.
      await fsp.rm(dir(copy.id), { recursive: true, force: true, maxRetries: 3 }).catch(() => null);
      throw new Error(`Nie udało się skopiować instancji: ${fileReason(err)}.`, { cause: err });
    }
  }

  return { list, get, create, update, patchInternal, remove, duplicate, dir, contentDir: (id, type) => path.join(dir(id), CONTENT_DIRS[type] ?? 'mods') };
}

module.exports = { createInstances, clean, slug, LOADERS, ICONS, CONTENT_DIRS, NOT_COPIED };
