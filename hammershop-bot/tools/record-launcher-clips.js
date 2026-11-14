#!/usr/bin/env node
'use strict';

/**
 * Records the short looping clips of Hammer Launcher that the website shows („gify” – really muted looping videos,
 * about ten times smaller than a GIF): the real launcher interface in Chromium with the launcher's own fake backend
 * (hammer-launcher/scripts/preview.js → mock), a drawn mouse cursor that moves smoothly, and natural pauses.
 *
 *   node tools/record-launcher-clips.js                      all clips
 *   node tools/record-launcher-clips.js graj mody            only these
 *   node tools/record-launcher-clips.js --launcher=../hammer-launcher --out=web/public/assets/launcher/clips --keep
 *   node tools/record-launcher-clips.js --stills             the still pictures of the page instead (see STILLS below)
 *
 * Each clip becomes <out>/<name>.webm (VP9), <name>.mp4 (H.264) and <name>-poster.webp (the first frame), 1280×800,
 * 30 fps, looping seamlessly (the last moments fade into the first frame). After a change in the launcher (a new logo,
 * a new look) run it again – the website picks the files up as they are.
 *
 * Needs: Playwright with Chromium (the launcher's devDependency is enough) and ffmpeg with libvpx-vp9 and libx264.
 * Nothing goes to the internet: the launcher runs from its files with fake data (news, mods, an account…).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARGS = process.argv.slice(2);
const opt = (name, fallback) => (ARGS.find((a) => a.startsWith(`--${name}=`)) ?? `=${fallback}`).split('=').slice(1).join('=');
const LAUNCHER = path.resolve(opt('launcher', path.join(__dirname, '..', '..', 'hammer-launcher')));
const OUT = path.resolve(opt('out', path.join(__dirname, '..', 'web', 'public', 'assets', 'launcher', 'clips')));
const KEEP = ARGS.includes('--keep'); // keep the raw frames (in the system's temp folder) for a look
const STILLS_ONLY = ARGS.includes('--stills'); // the still screenshots of the page (into --shots=, default: the folder above the clips)
const SHOTS = path.resolve(opt('shots', path.dirname(OUT)));
const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 30;
const LOOP_FADE = 0.7; // seconds: the end fades into the beginning, so the loop has no jump

function playwright() {
  const places = [path.join(LAUNCHER, 'node_modules', 'playwright'), 'playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright'];
  for (const p of places) {
    try {
      return require(p);
    } catch {
      // the next place
    }
  }
  throw new Error('Playwright nie jest zainstalowany – w folderze launchera: npm install && npx playwright install chromium');
}

/* ───────────── In the page: the launcher's own data made fit for a public website ───────────── */

/** Runs after the launcher's mock, before its scripts: real-looking news, no invented member counts, the current version,
 *  and our Discord server's real icon (the website's launcher-icon.png – the same picture the bot sets on the server). */
function patch({ version, icon }) {
  const day = 864e5;
  const now = Date.now();
  const date = (ms) => new Date(ms).toLocaleDateString('pl-PL');
  window.__feed({
    news: [
      { id: 'w3', title: 'Hammer Launcher wystartował – wersja beta już dostępna!', body: 'Pobierz, zagraj i daj znać, co sądzisz. Każdą opinię czytamy na naszym Discordzie.', tag: 'Nowość', date: date(now - day), at: now - day, url: null, image: null, pinned: true },
      { id: 'w2', title: 'Hammer Client: znaczek Hammer w Tab', body: 'Na serwerach widać, kto gra na Hammer Client – młotek przed nickiem. Do tego nowe moduły HUD.', tag: 'Aktualizacja', date: date(now - day), at: now - day - 3600e3, url: null, image: null, pinned: false },
      { id: 'w1', title: 'Optymalizacja jednym kliknięciem', body: 'Zakładka Optymalizacja dobierze RAM, flagi Javy i mody wydajnościowe pod Twój komputer.', tag: 'Porada', date: date(now - 2 * day), at: now - 2 * day, url: null, image: null, pinned: false },
    ],
  });
  window.__self({ current: version });
  const hs = window.hs;
  const discord = hs.community.discord;
  hs.community.discord = async () => ({ ...(await discord()), name: 'Hammer Launcher', ...(icon ? { iconUrl: icon } : {}), members: null, online: null, live: false });
  // No sample FPS-test results on the Optymalizacja page – they would read as measured numbers.
  const bench = hs.benchmark.info;
  hs.benchmark.info = async (id) => ({ ...(await bench(id)), history: [] });
  const info = hs.app.info;
  hs.app.info = async () => ({ ...(await info()), version });
  // The mock answers every search with the same list – here the list follows what is typed.
  const search = hs.modrinth.search;
  hs.modrinth.search = async (q) => {
    const res = await search(q);
    const text = String(q?.query ?? '').trim().toLowerCase();
    if (!text) return res;
    const hits = res.hits.filter((h) => `${h.title} ${h.description}`.toLowerCase().includes(text));
    return { ...res, hits, total_hits: hits.length };
  };
}

/** A drawn mouse cursor (the screen capture has none) that follows the real one, with a ripple on every click. */
function cursorOverlay() {
  const box = document.createElement('div');
  box.id = 'rec-cursor';
  box.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2.5v17.2l4.3-4 2.9 6.6 3-1.3-2.9-6.5h6z" fill="#fff" stroke="#14100c" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  Object.assign(box.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-80px, -80px)', filter: 'drop-shadow(0 3px 5px rgba(0,0,0,.55))', willChange: 'transform' });
  document.documentElement.appendChild(box);
  addEventListener('mousemove', (e) => (box.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`), true);
  addEventListener(
    'mousedown',
    (e) => {
      const ring = document.createElement('div');
      Object.assign(ring.style, { position: 'fixed', left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: '36px', height: '36px', borderRadius: '50%', border: '2px solid rgba(255,170,80,.95)', background: 'rgba(255,160,60,.22)', zIndex: '2147483646', pointerEvents: 'none', transform: 'scale(.3)', opacity: '1', transition: 'transform .45s cubic-bezier(.2,.7,.2,1), opacity .45s' });
      document.documentElement.appendChild(ring);
      requestAnimationFrame(() => requestAnimationFrame(() => Object.assign(ring.style, { transform: 'scale(1.25)', opacity: '0' })));
      setTimeout(() => ring.remove(), 600);
    },
    true,
  );
}

/* ───────────── A person at the mouse ───────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function hand(page) {
  const at = { x: WIDTH * 0.62, y: HEIGHT * 0.66 };
  const self = {
    async place(x, y) {
      at.x = x;
      at.y = y;
      await page.mouse.move(x, y);
    },
    /** A smooth, slightly curved move – like a hand, not a robot. */
    async move(x, y, ms = 650) {
      const from = { ...at };
      const bend = { x: (from.y - y) * 0.12, y: (x - from.x) * 0.08 };
      const steps = Math.max(10, Math.round(ms / 16));
      const start = Date.now();
      for (let i = 1; i <= steps; i++) {
        const t = ease(i / steps);
        const arc = Math.sin(Math.PI * t);
        await page.mouse.move(from.x + (x - from.x) * t + bend.x * arc, from.y + (y - from.y) * t + bend.y * arc);
        const due = start + (ms * i) / steps;
        if (due > Date.now()) await sleep(due - Date.now());
      }
      at.x = x;
      at.y = y;
    },
    /** Moves to the middle of an element (or a spot in it: fx/fy from 0 to 1). */
    async to(locator, { ms = 650, fx = 0.5, fy = 0.5 } = {}) {
      const target = typeof locator === 'string' ? page.locator(locator).first() : locator;
      await target.waitFor({ state: 'visible' });
      const b = await target.boundingBox();
      await self.move(b.x + b.width * fx, b.y + b.height * fy, ms);
    },
    async click(locator, options = {}) {
      if (locator) await self.to(locator, options);
      await sleep(140);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
    },
    async wheel(dy, steps = 8, ms = 600) {
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(ms / steps);
      }
    },
    async type(text, delay = 95) {
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep(delay + Math.round(Math.random() * 40));
      }
    },
  };
  return self;
}

/* ───────────── The clips ───────────── */

/** Puts the launcher's scroll area at a heading at once (no smooth scrolling on the way). */
const viewTo = (page, selector, text, offset = 16) =>
  page.locator(selector, { hasText: text }).first().evaluate((el, off) => {
    const view = document.getElementById('view');
    view.style.scrollBehavior = 'auto';
    view.scrollTop = (el.closest('.card') ?? el).offsetTop - off;
    view.style.scrollBehavior = '';
  }, offset);
const nav = (page, title) => page.locator('.nav-item', { hasText: title }).first().click();
const noToasts = (page) => page.evaluate(() => document.getElementById('toasts')?.replaceChildren());

const CLIPS = {
  /** Graj: pick the instance, click GRAJ – the game downloads, starts and runs. */
  graj: {
    async before(page) {
      await page.evaluate(() => HS.state.selectInstance('fo'));
      await sleep(300);
    },
    async run(page, me) {
      await sleep(400);
      await me.click('.instance-pick', { ms: 850 });
      await sleep(450);
      const item = page.locator('.menu button, .menu .item, .menu [role="menuitem"]', { hasText: 'Hammer' }).first();
      await me.to(item, { ms: 600 });
      await sleep(250);
      await me.click(null);
      await sleep(350);
      await me.click('.play-btn', { ms: 700 });
      await sleep(250);
      const stages = [
        ['Pobieranie Minecrafta', 0, 58, 1150],
        ['Instalowanie Fabric', 58, 74, 450],
        ['Sprawdzanie modów', 74, 100, 650],
      ];
      for (const [label, from, to, ms] of stages) {
        const steps = Math.round(ms / 50);
        for (let i = 0; i <= steps; i++) {
          const percent = Math.round(from + ((to - from) * i) / steps);
          await page.evaluate(([l, p]) => window.__emit('game:progress', { instanceId: 'hammershop', stage: 'minecraft', label: l, done: p * 10, total: 1000, percent: p }), [label, percent]);
          await sleep(50);
        }
      }
      await page.evaluate(() => window.__emit('game:state', { instanceId: 'hammershop', state: 'starting' }));
      await sleep(700);
      await page.evaluate(() => window.__emit('game:state', { instanceId: 'hammershop', state: 'running' }));
      await me.move(WIDTH * 0.62, HEIGHT * 0.66, 800);
      await sleep(900);
    },
  },

  /** Mody: search Modrinth, open a mod, install it. */
  mody: {
    async before(page) {
      await nav(page, 'Mody');
      await sleep(600);
    },
    async run(page, me) {
      await sleep(600);
      await me.click('.page input[type="search"], .view input[placeholder*="zukaj"]', { ms: 850, fx: 0.25 });
      await sleep(250);
      await me.type('iris');
      await sleep(900);
      const row = page.locator('.project', { hasText: 'Iris' }).first();
      await me.click(row.locator('h3'), { ms: 700 });
      await sleep(1500);
      await page.keyboard.press('Escape');
      await sleep(450);
      await me.click(row.locator('.btn.primary'), { ms: 700 });
      await sleep(1500);
      await me.move(WIDTH * 0.62, HEIGHT * 0.66, 800);
      await sleep(700);
    },
  },

  /** Optymalizacja: „Zoptymalizuj wszystko” – one click, and what was done. */
  optymalizacja: {
    async before(page) {
      await nav(page, 'Optymalizacja');
      await sleep(600);
    },
    async run(page, me) {
      await sleep(600);
      await me.to('.card', { ms: 800, fx: 0.3, fy: 0.5 });
      await sleep(400);
      await me.click(page.locator('button', { hasText: 'Zoptymalizuj wszystko' }).first(), { ms: 800 });
      await sleep(2600);
      await page.keyboard.press('Escape');
      await sleep(400);
      await me.move(WIDTH * 0.62, HEIGHT * 0.66, 800);
      await sleep(600);
    },
  },

  /** Ustawienia → Wygląd (Hammer+): the themes with their moving backgrounds. */
  motywy: {
    async before(page) {
      await page.evaluate(() => window.__plus(true));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await nav(page, 'Ustawienia');
      await sleep(500);
      await viewTo(page, 'h2', 'Wygląd', 70);
      await sleep(500);
      await noToasts(page);
    },
    async run(page, me) {
      await sleep(500);
      for (const [id, wait] of [['nether', 1350], ['end', 1300], ['ocean', 1200], ['cherry', 1200], ['deepdark', 1400]]) {
        await me.click(`.theme-tile[data-theme="${id}"]`, { ms: 460 });
        await sleep(wait);
      }
    },
  },

  /** Skórka (Hammer+): a moving cape and the cosmetics on the character. */
  skorka: {
    async before(page) {
      await page.evaluate(() => window.__plus(true));
      await nav(page, 'Skórka');
      await sleep(800);
      await viewTo(page, 'h2', 'Peleryny', 90);
      await sleep(500);
      await noToasts(page);
    },
    async run(page, me) {
      await sleep(600);
      await me.click('.hcape[data-cape="flame"]', { ms: 800 });
      await sleep(1200);
      await me.click('.hcape[data-cape="sparks"]', { ms: 450 });
      await sleep(900);
      await page.locator('h2', { hasText: 'Dodatki' }).first().evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await sleep(750);
      for (const id of ['angel', 'halo', 'crown']) {
        await me.click(`.hcos[data-cosmetic="${id}"]`, { ms: 460 });
        await sleep(650);
      }
      await sleep(500);
    },
  },
};

/** The Discord server's icon as a data URL (web/public/assets/launcher-icon.png), or null when the file is missing. */
function serverIcon() {
  const file = path.join(__dirname, '..', 'web', 'public', 'assets', 'launcher-icon.png');
  return fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null;
}

/* ───────────── Recording and encoding ───────────── */

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function record(browser, mock, page0, name, clip, version) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((list) => (window.__cosmetics = list), JSON.parse(fs.readFileSync(path.join(LAUNCHER, 'src', 'renderer', 'assets', 'cosmetics', 'cosmetics.json'), 'utf8')));
  await page.addInitScript(mock);
  await page.addInitScript(patch, { version, icon: serverIcon() });
  await page.goto(page0);
  await page.waitForTimeout(900);
  await page.evaluate(cursorOverlay);
  await clip.before(page);
  const me = hand(page);
  await me.place(WIDTH * 0.62, HEIGHT * 0.66);
  await sleep(500);

  // Every frame Chromium draws, with its time – they become a 30 fps film afterwards.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${name}-`));
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  const started = Date.now() / 1000;
  await clip.run(page, me);
  const ended = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await context.close();
  if (errors.length) console.warn(`  ${name}: błędy na stronie launchera: ${errors.join(' | ')}`);
  if (frames.length < 10) throw new Error(`${name}: za mało klatek (${frames.length})`);

  // The frames with their real durations → a steady 30 fps master, the last LOOP_FADE seconds fading into the first.
  const t0 = frames[0].t;
  const total = Math.max(frames.at(-1).t - t0 + 0.2, ended - started - 0.1);
  const list = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : t0 + total;
    list.push(`file '${path.basename(f.file)}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  list.push(`file '${path.basename(frames.at(-1).file)}'`);
  fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));
  const master = path.join(dir, 'master.mkv');
  const fade = LOOP_FADE;
  const length = Math.floor(total * FPS) / FPS;
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'),
    '-filter_complex',
    `[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,trim=duration=${length},setpts=PTS-STARTPTS,split[a][b];` +
      `[a]trim=end=${fade},setpts=PTS-STARTPTS[head];[b]trim=start=${fade},setpts=PTS-STARTPTS[body];` +
      `[body][head]xfade=transition=fade:duration=${fade}:offset=${(length - 2 * fade).toFixed(3)},format=yuv420p[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', master,
  ]);

  fs.mkdirSync(OUT, { recursive: true });
  const webm = path.join(OUT, `${name}.webm`);
  const mp4 = path.join(OUT, `${name}.mp4`);
  const poster = path.join(OUT, `${name}-poster.webp`);
  ffmpeg(['-i', master, '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-g', String(FPS * 4), '-pix_fmt', 'yuv420p', webm]);
  ffmpeg(['-i', master, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(FPS * 4), '-movflags', '+faststart', mp4]);
  ffmpeg(['-i', master, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80', poster]);
  if (KEEP) console.log(`  klatki: ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
  const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
  console.log(`✓ ${name}: ${length.toFixed(1)} s, ${frames.length} klatek – webm ${kb(webm)}, mp4 ${kb(mp4)}, plakat ${kb(poster)}`);
}

/* ───────────── Still pictures for the page ───────────── */

/**
 * The page's screenshots of the launcher, from the same interface and data as the clips (1240×780 window, drawn at 2×):
 * the hero (hero-1400.webp, hero-820.webp, graj.jpg), the feature tabs (instancje / mody / optymalizacja – .webp + .jpg,
 * 1100 px) and the theme deck (motyw-*.webp – the top 372 px of Graj in every theme, Hammer+ on).
 */
const STILLS = [
  { name: 'graj', files: [['hero-1400.webp', 1400], ['hero-820.webp', 820], ['graj.jpg', 1400]], async before() {} },
  { name: 'instancje', files: [['instancje.webp', 1100], ['instancje.jpg', 1100]], before: (page) => nav(page, 'Instancje') },
  { name: 'mody', files: [['mody.webp', 1100], ['mody.jpg', 1100]], before: (page) => nav(page, 'Mody') },
  { name: 'optymalizacja', files: [['optymalizacja.webp', 1100], ['optymalizacja.jpg', 1100]], before: (page) => nav(page, 'Optymalizacja') },
];
const THEME_STILLS = [['default', 'motyw-domyslny'], ['nether', 'motyw-nether'], ['end', 'motyw-end'], ['ocean', 'motyw-ocean'], ['cherry', 'motyw-wisnia'], ['deepdark', 'motyw-mrok']];

/** One PNG → the page's files: WebP (quality 78) or JPEG, scaled to the width given. */
function encodeStill(png, file, width) {
  const out = path.join(SHOTS, file);
  const scale = `scale=${width}:-2:flags=lanczos`;
  if (file.endsWith('.webp')) ffmpeg(['-i', png, '-vf', scale, '-c:v', 'libwebp', '-quality', '78', '-compression_level', '6', out]);
  else ffmpeg(['-i', png, '-vf', scale, '-q:v', '4', out]);
  return `${file} ${Math.round(fs.statSync(out).size / 1024)} KB`;
}

async function stills(browser, mock, page0, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stills-'));
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1240, height: 780 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.addInitScript((list) => (window.__cosmetics = list), JSON.parse(fs.readFileSync(path.join(LAUNCHER, 'src', 'renderer', 'assets', 'cosmetics', 'cosmetics.json'), 'utf8')));
    await page.addInitScript(mock);
    await page.addInitScript(patch, { version, icon: serverIcon() });
    await page.goto(page0);
    await page.waitForTimeout(1200);
    return { context, page };
  };
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const still of STILLS) {
      const { context, page } = await open();
      await still.before(page);
      await sleep(1400);
      await noToasts(page);
      const png = path.join(dir, `${still.name}.png`);
      await page.screenshot({ path: png });
      await context.close();
      console.log(`✓ ${still.files.map(([file, width]) => encodeStill(png, file, width)).join(', ')}`);
    }
    const { context, page } = await open();
    await page.evaluate(() => window.__plus(true));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (const [id, file] of THEME_STILLS) {
      await nav(page, 'Ustawienia');
      await sleep(500);
      await viewTo(page, 'h2', 'Wygląd', 70);
      await page.locator(`.theme-tile[data-theme="${id}"]`).first().click();
      await sleep(400);
      await nav(page, 'Graj');
      await sleep(1600);
      await noToasts(page);
      const png = path.join(dir, `${file}.png`);
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1240, height: 372 } });
      console.log(`✓ ${encodeStill(png, `${file}.webp`, 1240)}`);
    }
    await context.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('Nie ma ffmpeg – zainstaluj go (np. apt install ffmpeg) i uruchom ponownie.');
  }
  const { mock, PAGE } = require(path.join(LAUNCHER, 'scripts', 'preview.js'));
  const version = JSON.parse(fs.readFileSync(path.join(LAUNCHER, 'package.json'), 'utf8')).version;
  const wanted = ARGS.filter((a) => !a.startsWith('--'));
  const names = wanted.length ? wanted : Object.keys(CLIPS);
  const unknown = names.filter((n) => !CLIPS[n]);
  if (unknown.length) throw new Error(`Nie ma takiego klipu: ${unknown.join(', ')} (są: ${Object.keys(CLIPS).join(', ')})`);
  const { chromium } = playwright();
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const where = STILLS_ONLY ? SHOTS : OUT;
  try {
    if (STILLS_ONLY) await stills(browser, mock, PAGE, version);
    else for (const name of names) await record(browser, mock, PAGE, name, CLIPS[name], version);
  } finally {
    await browser.close();
  }
  console.log(`Gotowe – pliki w ${path.relative(process.cwd(), where) || where}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
