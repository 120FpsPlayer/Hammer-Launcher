#!/usr/bin/env node
'use strict';

/**
 * Draws the picture a link to the website shows on Discord, Messenger, X… (web/public/assets/launcher/og.jpg,
 * 1200×630) from the page's own font, logo (assets/launcher/logo-h-big.webp) and launcher screenshot – run it again
 * after a new logo or a new screenshot:  node tools/render-og-image.js
 * Needs Playwright with Chromium (the launcher's devDependency is enough, or a global one).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', 'web', 'public', 'assets');
const OUT = path.join(ASSETS, 'launcher', 'og.jpg');

function playwright() {
  for (const p of [path.join(__dirname, '..', '..', 'hammer-launcher', 'node_modules', 'playwright'), 'playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright']) {
    try {
      return require(p);
    } catch {
      // the next place
    }
  }
  throw new Error('Playwright nie jest zainstalowany (npm install playwright && npx playwright install chromium).');
}

const file = (p) => `file://${path.join(ASSETS, p)}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:M;font-weight:800;src:url(${file('fonts/montserrat-latin-800-normal.woff2')})}
@font-face{font-family:M;font-weight:800;src:url(${file('fonts/montserrat-latin-ext-800-normal.woff2')});unicode-range:U+0100-02AF}
@font-face{font-family:M;font-weight:600;src:url(${file('fonts/montserrat-latin-600-normal.woff2')})}
@font-face{font-family:M;font-weight:600;src:url(${file('fonts/montserrat-latin-ext-600-normal.woff2')});unicode-range:U+0100-02AF}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#0b0806;font-family:M;color:#fbf4ee;position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(40% 55% at 22% 40%,rgba(255,128,34,.32),transparent 70%),radial-gradient(40% 50% at 80% 60%,rgba(255,180,60,.22),transparent 70%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,196,140,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,196,140,.06) 1px,transparent 1px);background-size:56px 56px;-webkit-mask-image:radial-gradient(70% 70% at 30% 40%,#000,transparent 80%)}
.copy{position:absolute;left:72px;top:92px;width:560px}
.brand{display:flex;align-items:center;gap:14px;font-weight:800;font-size:30px;letter-spacing:-1px}
.brand img{width:54px;height:54px;object-fit:contain;filter:drop-shadow(0 0 16px rgba(255,194,51,.55))}
.brand b{color:#ff9a3c}
.beta{font-size:14px;letter-spacing:.1em;padding:4px 10px;border-radius:99px;background:linear-gradient(110deg,#ffd58f,#ffa94d);color:#2b1c00;margin-left:4px}
h1{margin-top:40px;font-size:66px;white-space:nowrap;line-height:1.02;letter-spacing:-3px;font-weight:800}
h1 span{background:linear-gradient(100deg,#ffe08a,#ffb547 38%,#ff8a2b 70%,#ff6b1a);-webkit-background-clip:text;color:transparent}
p{margin-top:26px;font-size:22px;font-weight:600;color:#dcc7b4;line-height:1.45}
.shot{position:absolute;left:640px;top:120px;width:700px;border-radius:14px;padding:1px;background:linear-gradient(180deg,rgba(255,214,170,.5),rgba(255,170,90,.1));box-shadow:0 40px 100px -20px #000,0 0 80px -20px rgba(255,140,40,.5);transform:perspective(1600px) rotateY(-16deg) rotateX(4deg);transform-origin:0 50%}
.shot img{display:block;width:100%;border-radius:13px}
</style></head><body><div class="glow"></div><div class="grid"></div>
<div class="copy"><div class="brand"><img src="${file('launcher/logo-h-big.webp')}"><span>Hammer<b>Launcher</b></span><span class="beta">BETA</span></div>
<h1>Graj więcej.<br><span>Kombinuj mniej.</span></h1><p>Instancje, 1000+ modów z Modrinth, FPS&nbsp;boost i&nbsp;Hammer Client w&nbsp;grze.<br>Za darmo na Windows.</p></div>
<div class="shot"><img src="${file('launcher/hero-1400.webp')}"></div></body></html>`;

(async () => {
  const { chromium } = playwright();
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'og-')), 'og.html');
  fs.writeFileSync(tmp, html);
  await page.goto(`file://${tmp}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT, type: 'jpeg', quality: 86 });
  await browser.close();
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  console.log(`✓ ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
})().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
