'use strict';

// „Oficjalny start” on Hammer Launcher's start page (config.launch): the premiere date with a countdown in the hero –
// „za 17 dni”, „jutro”, „dziś o 18:00”, „Startujemy dziś!” on the day, gone the day after. Polish time, drawn by the
// server (the page is never cached) and moved on by the page itself while it stays open. Over real HTTP against a local
// copy of the website; at the end in a browser, on a laptop and on a phone.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/lib/config');
const pages = require('../src/web/pages');
const webStore = require('../src/web/store');
const { createWebServer } = require('../src/web/server');

const ROOT = path.join(__dirname, '..');
const SHIPPED = { ...config.launch }; // what config.launcher.json says
let site;
let base;

test.before(async () => {
  webStore.load();
  site = createWebServer({ catalog: () => [], info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), currency: () => 'pln', level: async () => null, log: () => null });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
});
test.after(() => {
  site?.close();
  config.launch = SHIPPED;
});

/** An instant given in Polish time: at('2026-11-19 12:00') – November and December are UTC+1, March before the 28th too. */
const at = (local, offset = '+01:00') => Date.parse(`${local.replace(' ', 'T')}${offset}`);
/** Today in Poland, n days on: 'YYYY-MM-DD'. */
const dayIn = (n) => new Date(Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date())}T00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const when = (launch, now) => {
  const s = pages.launchState(launch, now);
  return s && (s.today ? 'today' : s.when);
};
async function page(pathname) {
  const res = await fetch(base + pathname, { headers: { 'x-forwarded-for': '10.70.0.1' } });
  return { status: res.status, cache: res.headers.get('cache-control'), html: await res.text() };
}

test('the countdown in Polish: „za 22 / 17 / 2 dni”, „jutro”, „Startujemy dziś!” – by the Polish calendar day, gone the day after', () => {
  const premiere = { date: '2026-12-06', time: '' };
  assert.equal(pages.launchDay(premiere).label, '6 grudnia 2026');
  assert.equal(when(premiere, at('2026-11-14 12:00')), 'za 22 dni');
  assert.equal(when(premiere, at('2026-11-19 08:00')), 'za 17 dni');
  assert.equal(when(premiere, at('2026-12-04 23:59')), 'za 2 dni');
  assert.equal(when(premiere, at('2026-12-05 00:00')), 'jutro');
  assert.equal(when(premiere, at('2026-12-05 23:59')), 'jutro');
  // 23:30 UTC on the 5th is already 00:30 on the 6th in Poland – the server's own clock may run in UTC.
  assert.equal(when(premiere, Date.parse('2026-12-05T23:30Z')), 'today');
  assert.equal(when(premiere, at('2026-12-06 23:59')), 'today');
  assert.equal(when(premiere, at('2026-12-07 00:00')), null, 'the day after: no strip');
  assert.equal(when(premiere, at('2027-01-10 12:00')), null);
  // A clock change on the way (the last Sunday of March) does not make a day disappear.
  assert.equal(when({ date: '2027-03-29', time: '' }, at('2027-03-27 12:00')), 'za 2 dni');
  assert.equal(pages.launchDay({ date: '2027-01-01', time: '' }).label, '1 stycznia 2027');
});

test('with an hour: „jutro o 18:00”, „dziś o 18:00” – and „Startujemy dziś!” from 18:00', () => {
  const premiere = { date: '2026-12-06', time: '18:00' };
  assert.equal(when(premiere, at('2026-11-19 12:00')), 'za 17 dni');
  assert.equal(when(premiere, at('2026-12-05 10:00')), 'jutro o 18:00');
  assert.equal(when(premiere, at('2026-12-06 00:01')), 'dziś o 18:00');
  assert.equal(when(premiere, at('2026-12-06 17:59')), 'dziś o 18:00');
  assert.equal(when(premiere, at('2026-12-06 18:00')), 'today');
  assert.equal(when(premiere, at('2026-12-07 00:00')), null);
});

test('the strip itself: the date in <time>, the countdown beside it; on the day only „Startujemy dziś!”; nothing without a date', () => {
  const before = pages.launchStrip({ date: '2026-12-06', time: '' }, at('2026-11-19 12:00'));
  assert.match(before, /^<p class="launch" id="launch" data-date="2026-12-06" data-time="" data-now="\d+">/);
  assert.match(before, /🚀/);
  assert.match(before, /Oficjalny start: <b><time datetime="2026-12-06">6 grudnia 2026<\/time><\/b>/);
  assert.match(before, /<span class="launch-when">za 17 dni<\/span>/);
  assert.match(pages.launchStrip({ date: '2026-12-06', time: '18:00' }, at('2026-12-06 09:00')), /datetime="2026-12-06T18:00">6 grudnia 2026<\/time>.*<span class="launch-when">dziś o 18:00<\/span>/);
  const today = pages.launchStrip({ date: '2026-12-06', time: '' }, at('2026-12-06 09:00'));
  assert.match(today, /^<p class="launch today" id="launch"[^>]*><span class="launch-ico" aria-hidden="true">🚀<\/span><span class="launch-text"><b>Startujemy dziś!<\/b><\/span><\/p>$/);
  assert.equal(pages.launchStrip({ date: '2026-12-06', time: '' }, at('2026-12-07 09:00')), '');
  for (const empty of [{ date: '', time: '' }, { date: '  ', time: '18:00' }, {}, null]) assert.equal(pages.launchStrip(empty), '', JSON.stringify(empty));
});

test('a date the owner typed wrong: a clear message for npm run check, and the site keeps working without the strip', () => {
  for (const launch of [{ date: '2026-6-12' }, { date: '06.12.2026' }, { date: '2026-02-31' }, { date: '2026-12-06', time: '25:00' }, { date: '2026-12-06', time: '18.00' }]) {
    assert.throws(() => pages.launchDay(launch), /"launch": data .* wpisz datę jako RRRR-MM-DD \(np\. 2026-12-06\) i godzinę jako GG:MM \(np\. 18:00\) albo ""/, JSON.stringify(launch));
  }
  const said = [];
  const { warn } = console;
  console.warn = (...a) => said.push(a.join(' '));
  try {
    assert.equal(pages.launchStrip({ date: '2026-6-12', time: '' }), '');
    assert.equal(pages.launchStrip({ date: '2026-6-12', time: '' }), '');
  } finally {
    console.warn = warn;
  }
  assert.equal(said.length, 1, 'said once, not on every visit');
  assert.match(said[0], /Pasek „Oficjalny start” jest ukryty/);
});

test('config: config.launcher.json names a real premiere date; the shop has none (nothing is shown there)', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.launcher.json'), 'utf8')).launch;
  assert.match(shipped.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pages.launchDay(shipped), 'a date launchDay accepts');
  assert.deepEqual(SHIPPED, shipped);
  const shop = config.load(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
  assert.deepEqual(shop.launch, { date: '', time: '' });
  assert.equal(pages.launchStrip(shop.launch), '');
});

test('the start page: the strip right above the download button, drawn for today; not on other pages, not once the day is over', async () => {
  config.launch = { date: dayIn(10), time: '' };
  const start = await page('/');
  assert.equal(start.status, 200);
  assert.equal(start.cache, 'no-cache', 'the page is never kept – the countdown is always today\'s');
  assert.match(start.html, /<span class="launch-when">za 10 dni<\/span>/);
  const lead = start.html.indexOf('class="lead"');
  const strip = start.html.indexOf('id="launch"');
  const cta = start.html.indexOf('class="cta"');
  assert.ok(lead < strip && strip < cta, 'between the lead and the download button');
  assert.doesNotMatch(start.html, /\{\{launch\}\}/);
  assert.match(start.html, /<span class="pill beta">Beta<\/span>/, 'the beta wording stays');
  for (const other of ['/funkcje', '/hammer-plus', '/pomoc', '/nie-ma-takiej']) {
    const { html } = await page(other);
    assert.doesNotMatch(html, /class="launch|\{\{launch\}\}/, other);
  }
  config.launch = { date: dayIn(0), time: '' };
  assert.match((await page('/')).html, /<b>Startujemy dziś!<\/b>/);
  for (const gone of [{ date: dayIn(-1), time: '' }, { date: '', time: '' }]) {
    config.launch = gone;
    const { html } = await page('/');
    assert.doesNotMatch(html, /class="launch|\{\{launch\}\}/, JSON.stringify(gone));
    assert.match(html, /class="cta"/);
  }
});

function playwright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try {
      return require(p);
    } catch {
      // next
    }
  }
  return null;
}
const pw = playwright();

test('in a browser at 1366 and 390 px: readable, inside the screen, no sideways scroll, nothing blocked by the CSP; a page left open moves on by itself', { skip: !pw && 'Playwright is not installed' }, async () => {
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  try {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(viewport.width < 500 && { isMobile: true, hasTouch: true }) });
      await context.route(/^https:\/\//, (route) => route.abort());
      const tab = await context.newPage();
      const problems = [];
      tab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      tab.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

      config.launch = { date: dayIn(17), time: '' };
      await tab.goto(`${base}/`, { waitUntil: 'networkidle' });
      const strip = tab.locator('#launch');
      assert.ok(await strip.isVisible(), `${viewport.width}: the strip is visible`);
      assert.equal((await strip.innerText()).replace(/\s+/g, ' ').trim(), `🚀 Oficjalny start: ${pages.launchDay(config.launch).label} za 17 dni`);
      const box = await strip.boundingBox();
      const fit = await tab.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, cta: document.querySelector('.cta').getBoundingClientRect().top }));
      assert.ok(fit.scroll <= fit.inner, `${viewport.width}: no sideways scroll (${fit.scroll} > ${fit.inner})`);
      assert.ok(box.x >= 0 && box.x + box.width <= fit.inner, `${viewport.width}: the strip is inside the screen`);
      assert.ok(box.y + box.height <= fit.cta, `${viewport.width}: above the download button`);
      assert.ok(box.y + box.height <= viewport.height, `${viewport.width}: seen without scrolling`);
      const font = await strip.evaluate((n) => Number.parseFloat(getComputedStyle(n).fontSize));
      assert.ok(font >= 13, `${viewport.width}: readable (${font}px)`);

      // Left open over midnight: „jutro” → „Startujemy dziś!” → gone (the page's own clock, set by the server's).
      config.launch = { date: dayIn(1), time: '' };
      await tab.clock.install({ time: Date.now() });
      await tab.goto(`${base}/`, { waitUntil: 'networkidle' });
      assert.match(await strip.innerText(), /jutro/);
      await tab.clock.fastForward('24:00:00');
      assert.equal((await strip.innerText()).replace(/\s+/g, ' ').trim(), '🚀 Startujemy dziś!');
      assert.ok(await tab.locator('#launch.today').isVisible());
      await tab.clock.fastForward('24:00:00');
      assert.equal(await strip.isVisible(), false, 'the day after it is gone');
      assert.deepEqual(problems, [], `${viewport.width}: no errors`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
