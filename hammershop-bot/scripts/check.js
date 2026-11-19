'use strict';

/**
 * npm run check – validates config.json and renders every panel, card and form against
 * Discord's limits (no token needed). Run it after editing config.json.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.chdir(path.join(__dirname, '..'));

try {
  const config = require('../src/lib/config');
  console.log(`✔ config.json is valid – ${config.ticketTypes.length} ticket types, ${config.snippets.length} canned replies, ${config.shop.paymentMethods.length} payment methods`);
  const off = config.turnedOff();
  if (off.length) console.log(`ℹ Turned off in config.json: ${off.join(', ')}.`);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

// E-mail from the website (src/lib/mail.js): is it set up, and where it goes – never the password.
{
  const mail = require('../src/lib/mail').status();
  if (mail.ready) console.log(`✔ E-mail: włączony – wiadomości ze strony i powiadomienia o zakupach idą na ${mail.to} (${mail.host}, port ${mail.port}). Sprawdź go przyciskiem „Wyślij testowy e-mail” w panelu admina → Wiadomości.`);
  else if (!mail.to || !mail.from) console.log('ℹ E-mail: wyłączony – strona nie ma adresu kontaktowego (config.json → "contact" → "email"). Formularz kontaktowy działa i tak: panel admina + Discord.');
  else console.log(`ℹ E-mail: wyłączony – w pliku .env brakuje MAIL_PASS (hasło do aplikacji z konta Google ${mail.from}). Formularz kontaktowy działa i tak: panel admina + Discord.`);
}

// „Oficjalny start” on the launcher's start page (config.launch): the date as the page shows it – or what is wrong with it.
try {
  const pages = require('../src/web/pages');
  const day = pages.launchDay();
  if (day) {
    const state = pages.launchState();
    console.log(`✔ Oficjalny start na stronie: ${day.label}${day.time ? `, ${day.time}` : ''} – ${!state ? 'ten dzień już minął, pasek jest ukryty' : state.today ? 'dziś („Startujemy dziś!”)' : state.when}.`);
  }
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

// The Hammer Launcher server (BOT_PROFILE=launcher) is checked with its own build: config.launcher.json, its channels and cards.
const launcher = require('../src/lib/profile').launcher;
if (launcher) console.log('ℹ Profil: Hammer Launcher (BOT_PROFILE=launcher) – config.json + config.launcher.json.');
const tests = launcher ? ['test/profile-launcher.test.js'] : ['test/payloads.test.js', 'test/build.test.js'];
const res = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'pipe', encoding: 'utf8' });
const out = `${res.stdout}${res.stderr}`;
const failed = out.split('\n').filter((l) => l.startsWith('not ok'));
for (const line of out.split('\n').filter((l) => /^(not )?ok /.test(l))) console.log(line.startsWith('ok') ? `✔ ${line.replace(/^ok \d+ - /, '')}` : `✖ ${line.replace(/^not ok \d+ - /, '')}`);
if (res.status !== 0) {
  if (!failed.length) console.error(out);
  console.error('\n✖ Something in config.json breaks a Discord limit – see the failing check above (run "npm test" for details).');
  process.exit(1);
}
console.log('\nAll good ✅');
