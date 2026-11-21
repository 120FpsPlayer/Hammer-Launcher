'use strict';

/* The release pipeline as the owner uses it: GitHub Actions builds the Windows installer as an artifact (nothing is
   ever published to GitHub Releases), the owner uploads it in the website's admin panel (hammershop-bot/src/web/
   releases.js), and installed launchers update from there. These tests read the real configuration files. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'launcher.config.json'), 'utf8'));
// Git on the Windows runner checks text files out with CRLF line ends – the checks below read lines.
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const workflow = read(path.join(REPO, '.github', 'workflows', 'hammer-launcher.yml'));
const expand = (pattern, ext) => pattern.replace('${version}', pkg.version).replace('${arch}', 'x64').replace('${ext}', ext);

test('nothing is ever published to GitHub: every build script says --publish never, the only publish target is the website', () => {
  const builds = Object.entries(pkg.scripts).filter(([, cmd]) => /electron-builder/.test(cmd));
  assert.ok(builds.length >= 1);
  for (const [name, cmd] of builds) assert.match(cmd, /--publish never\b/, `npm run ${name}`);
  const targets = [pkg.build.publish].flat().filter(Boolean);
  assert.ok(targets.length >= 1, 'without a publish entry electron-builder would guess GitHub from the repository');
  for (const t of targets) assert.equal(typeof t === 'string' ? t : t.provider, 'generic');
  assert.equal(targets[0].url, `${config.website}/updates`, 'app-update.yml points at the website the launcher updates from');
  // The workflow only uploads artifacts: no release action, no `gh release`, no token handed to electron-builder.
  for (const bad of [/action-gh-release/i, /\bgh release\b/, /--publish (always|onTag|onTagOrDraft)/, /\bGH_TOKEN\b/, /contents:\s*write/, /\btags:/]) assert.doesNotMatch(workflow, bad);
});

test('the files the admin panel gets: the installer and its .blockmap have names the website accepts', () => {
  const releases = fs.readFileSync(path.join(REPO, 'hammershop-bot', 'src', 'web', 'releases.js'), 'utf8');
  const source = /const FILE_NAME = \/(.+)\/;/.exec(releases)?.[1];
  assert.ok(source, 'releases.js → FILE_NAME');
  const accepted = new RegExp(source);
  const installer = expand(pkg.build.nsis.artifactName, 'exe');
  assert.equal(installer, `Hammer-Launcher-Setup-${pkg.version}.exe`, 'the name the README and the panel tell the owner to upload');
  assert.match(installer, accepted);
  assert.match(`${installer}.blockmap`, accepted);
});

test('the artifact for the website holds the installer – the portable exe (it cannot update itself) is a separate one', () => {
  const block = /name: Hammer-Launcher-Windows\n\s+path: \|\n((?:\s+\S.*\n)+?)\s+if-no-files-found/.exec(workflow)?.[1];
  assert.ok(block, 'the upload step of the Hammer-Launcher-Windows artifact');
  const globs = block.split('\n').map((l) => l.trim()).filter(Boolean).map((g) => new RegExp(`^${path.posix.basename(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`));
  const inArtifact = (name) => globs.some((g) => g.test(name));
  const installer = expand(pkg.build.nsis.artifactName, 'exe');
  assert.ok(inArtifact(installer) && inArtifact(`${installer}.blockmap`) && inArtifact(`${installer}.sig`));
  assert.equal(inArtifact(expand(pkg.build.portable.artifactName, 'exe')), false, 'the portable exe is not next to the installer');
  assert.match(workflow, /path: hammer-launcher\/dist\/Hammer-Launcher-\*-portable\.exe/, 'it is still built – as an artifact of its own');
});

test('the installer installs for the current user only – a Program Files install would need administrator rights for every update', () => {
  const nsis = pkg.build.nsis;
  assert.equal(nsis.oneClick, false);
  assert.notEqual(nsis.perMachine, true);
  const include = read(path.join(ROOT, nsis.include));
  assert.match(include, /!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"\s+!macroend/, 'no „for all users” page');
  assert.doesNotMatch(include, /isForceMachineInstall "1"/);
  // Uninstalling (not during an update) removes the „start with Windows” entry the launcher wrote under its own name.
  assert.match(include, /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Hammer Launcher"/);
  assert.equal(require('../src/main/autostart').NAME, 'Hammer Launcher');
  // … and the hammer:// links the launcher registered for the current user (Electron writes HKCU\Software\Classes\hammer).
  assert.match(include, /DeleteRegKey HKCU "Software\\Classes\\hammer"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8'), /setAsDefaultProtocolClient\('hammer', process\.execPath/);
});

test('Hammer Client\'s homepage (Mod Menu → Website) is the launcher\'s website, not an old domain', () => {
  const mod = JSON.parse(fs.readFileSync(path.join(REPO, 'hammer-client', 'versions', 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8'));
  assert.equal(mod.contact.homepage, config.website);
});

test('the launcher sends players to „the Hammer Launcher website” – the site the download and the invitations are on – not to „HammerShop\'s”', () => {
  const dir = path.join(ROOT, 'src', 'renderer', 'views');
  for (const file of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /(stron[aęy]|stronie) HammerShop/, file);
});

test('„Polecane serwery” are picked by Hammer Launcher – the card names the launcher (config.name), not the HammerShop brand', () => {
  const view = read(path.join(ROOT, 'src', 'renderer', 'views', 'invite.js'));
  assert.match(view, /`wybiera \$\{state\.info\?\.config\?\.name \?\? 'Hammer Launcher'\}`/);
  assert.doesNotMatch(view, /wybiera \$\{state\.info\?\.config\?\.brand/);
  assert.equal(config.name, 'Hammer Launcher');
});
