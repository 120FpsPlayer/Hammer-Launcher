'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each test file gets its own empty database folder – removed again when the file is done (thousands of runs left
// over 1 GB of them in the temp folder before).
process.env.HS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hammershop-test-'));
const dataDir = process.env.HS_DATA_DIR;
process.on('exit', () => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // a file still open on Windows – the system cleans the temp folder eventually
  }
});
process.env.DISCORD_TOKEN ??= 'test.token.value';
// The tests are written for the shop server – whatever BOT_PROFILE this computer's .env has. The Hammer Launcher
// server's own test (profile-launcher.test.js) asks for its profile with HS_TEST_PROFILE.
process.env.BOT_PROFILE = process.env.HS_TEST_PROFILE ?? 'shop';

// Tests never reach the internet (Stripe, PayPal, crypto rates…) – a test that needs it fakes global.fetch.
global.fetch = async (url) => {
  throw new Error(`No network in tests: ${url}`);
};

// …and never a real mail server: whatever MAIL_* this computer's .env has, every test file starts with e-mail switched
// off and pointed at this machine. A test that sends mail starts a local fake (test/helpers/fakeSmtp.js).
Object.assign(require('../../src/env').env.mail, { pass: '', user: '', to: '', host: '127.0.0.1', port: 9 });

const db = require('../../src/lib/db');

db.load();
require('../../src/features/load'); // features register their panels, hooks and buttons

module.exports = { db };
