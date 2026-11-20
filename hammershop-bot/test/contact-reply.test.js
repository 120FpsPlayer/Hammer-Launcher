'use strict';

// „Odpowiedz” in the admin panel's „Wiadomości”: the answer to a contact form message goes out by e-mail from the panel
// itself (the owner has no mail app on his computer – a mailto: link did nothing). Over real HTTP against a local copy
// of the website, with a fake Discord server and a local fake SMTP server; at the end the same in a real browser.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { textOf } = require('./helpers/fakeInteraction');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { startSmtp, closedPort } = require('./helpers/fakeSmtp');
const { buildServer } = require('../src/builder/executor');
const { ROLES } = require('../src/builder/layout');
const { env } = require('../src/env');
const config = require('../src/lib/config');
const mail = require('../src/lib/mail');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const { createWebServer } = require('../src/web/server');

const ADDRESS = 'hammerlauncherclient@gmail.com';
const PASS = 'abcdefghijklmnop';
const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const ADMIN = { id: '200000000000000301', username: 'adminka', global_name: 'Adminka', avatar: null };
const MEMBER = { id: '200000000000000302', username: 'gracz', global_name: 'Gracz', avatar: null };

let fakes;
let smtp;
let site;
let base;
let guild;
const sids = {};

const mailOn = (pass = PASS) => {
  Object.assign(env.mail, { pass, user: '', to: '', host: '127.0.0.1', port: smtp.port });
  mail._test({ plain: true });
};
const mailOff = () => Object.assign(env.mail, { pass: '' });

test.before(async () => {
  fakes = await startFakes();
  smtp = await startSmtp({ user: ADDRESS, pass: PASS });
  guild = new FakeGuild({ ownerId: OWNER.id });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  guild.addMember(ADMIN.id, [db.roleId(guild.id, ROLES.find((r) => r.perms === 'admin').key)]);
  guild.addMember(MEMBER.id, [db.roleId(guild.id, 'member')]);
  website._setClient(guild.client);
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onLogin: website.onLogin, isMember: website.isMember, currency: () => 'pln',
    level: website.panelLevel, log: website.panelLog, contact: website.contactCard,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  for (const [name, user] of Object.entries({ owner: OWNER, admin: ADMIN, member: MEMBER })) sids[name] = await signIn(user);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
  smtp?.close();
});
test.beforeEach(() => {
  smtp.behave = {};
  mailOff();
});

let ip = 0;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0].trim()).find((c) => c.startsWith(`${name}=`)) ?? '';

async function signIn(user) {
  fakes.state.user = user;
  const start = await fetch(`${base}/api/shop/auth/start?next=admin`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const jar = [cookieOf(start, 'hs_oauth'), cookieOf(start, 'hs_next')].filter(Boolean).join('; ');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: jar }, redirect: 'manual' });
  return cookieOf(back, 'hs_sid');
}

/** → { status, body }. who: 'owner' | 'admin' | 'member' | null; from: a fixed address (else a new one each call). */
async function call(method, pathname, { who = 'owner', body, raw, origin = base, from } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': from ?? `10.91.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...(who && { cookie: sids[who] }),
      ...(origin && method !== 'GET' && { origin }),
      ...((body !== undefined || raw !== undefined) && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(raw !== undefined && { body: raw }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const reply = (id, body, opts = {}) => call('POST', `/api/admin/messages/${encodeURIComponent(id)}/reply`, { body, ...opts });
const logText = () => guild.channels.cache.get(db.channelId(guild.id, 'serverLogs')).messageList.map((m) => textOf(m.body)).join('\n');

/** A message as the contact form would have stored it. */
const message = (fields = {}) => webStore.addMessage({ name: 'Kuba', email: 'kuba@example.com', topic: 'launcher', text: 'Cześć!\nLauncher nie widzi moich modów.', ...fields });

/** The parts of a multipart body (a multipart/related part – the HTML with its pictures – is opened: its parts follow). */
function split(body, boundary) {
  return body.split(`--${boundary}`).slice(1, -1).flatMap((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const headers = Object.fromEntries(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    const inner = /^multipart\/related; boundary="([^"]+)"/.exec(headers['content-type'] ?? '')?.[1];
    if (inner) return split(rest.join('\r\n\r\n'), inner);
    const data = Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64');
    return [{ type: headers['content-type'], cid: headers['content-id'] ?? null, text: data.toString('utf8').replace(/\r\n/g, '\n') }];
  });
}
const partsOf = (m) => split(m.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'), /boundary="([^"]+)"/.exec(m.headers['content-type'])[1]);

test('who may answer: the team (owner and admins) – only from the panel itself, never a member or a stranger', async () => {
  mailOn();
  const m = message();
  const body = { text: 'Dzień dobry!' };
  assert.equal((await reply(m.id, body, { who: null })).status, 401);
  assert.equal((await reply(m.id, body, { who: 'member' })).status, 403);
  // CSRF: a change needs the panel's own Origin header – none, or another site's, is refused before anything is sent.
  assert.equal((await reply(m.id, body, { origin: null })).status, 403);
  assert.equal((await reply(m.id, body, { origin: 'https://evil.example' })).status, 403);
  assert.equal(smtp.messages.length, 0, 'nothing went out');
  assert.equal(webStore.getMessage(m.id).replies, undefined);
  assert.equal((await reply('msg_nie_ma', body)).status, 404);
  // The form, checked: a Polish sentence each.
  assert.deepEqual(await reply(m.id, { text: '   \n ' }), { status: 400, body: { error: 'Wpisz treść odpowiedzi.' } });
  assert.deepEqual(await reply(m.id, { text: 'x'.repeat(4001) }), { status: 400, body: { error: 'Odpowiedź może mieć najwyżej 4000 znaków (teraz 4001).' } });
  assert.deepEqual(await reply(m.id, { text: 'ok', subject: 's'.repeat(201) }), { status: 400, body: { error: 'Temat może mieć najwyżej 200 znaków (teraz 201).' } });
  assert.equal((await call('POST', `/api/admin/messages/${m.id}/reply`, { raw: 'null' })).status, 400);
  // An admin answers like the owner.
  const sent = await reply(m.id, body, { who: 'admin' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.item.replies[0].by.id, ADMIN.id);
});

test('the answer arrives: to the sender, from the site\'s account, „Reply” to the contact address – branded HTML and text, everything escaped, their message quoted', async () => {
  mailOn();
  smtp.messages.length = 0;
  const m = message({ name: 'Ola <b>', email: 'ola@example.com', topic: 'plus', text: 'Zapłaciłam i nie mam kodu <script>alert(1)</script>\n\nPomocy!' });
  // The subject the panel fills in, sent as it is.
  const list = await call('GET', '/api/admin/messages');
  const row = list.body.messages.find((x) => x.id === m.id);
  assert.equal(row.replySubject, 'Re: Hammer+ i płatności – Hammer Launcher');
  assert.deepEqual([row.answered, row.replies], [false, []]);
  const text = 'Cześć Ola!\n\nKod już wysłaliśmy – sprawdź <folder> Spam & „Oferty”.\nPozdrawiamy';
  const res = await reply(m.id, { subject: row.replySubject, text });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.to, 'ola@example.com');
  assert.equal(smtp.messages.length, 1, 'one e-mail, at once');
  const sent = smtp.messages[0];
  assert.deepEqual([sent.from, sent.to], [ADDRESS, ['ola@example.com']]);
  assert.equal(sent.headers.from, `"Hammer Launcher" <${ADDRESS}>`);
  assert.equal(sent.headers['reply-to'], `<${config.contact.email}>`, 'their „Reply” goes to the contact address');
  assert.equal(sent.subject, 'Re: Hammer+ i płatności – Hammer Launcher');
  assert.match(sent.headers['content-type'], /^multipart\/alternative; boundary="=_hs_[0-9a-f]{24}"$/);
  const [plain, html, logo] = partsOf(sent);
  assert.deepEqual([plain.type, html.type, logo.type, logo.cid], ['text/plain; charset=utf-8', 'text/html; charset=utf-8', 'image/png', '<logo>']);
  // The text version: the answer, signed, then their message quoted with when and the topic.
  assert.ok(plain.text.startsWith(`${text}\n\nZespół Hammer Launcher\n`), plain.text);
  assert.match(plain.text, /Twoja wiadomość z \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} \(temat: Hammer\+ i płatności\):\n\n> Zapłaciłam i nie mam kodu <script>alert\(1\)<\/script>\n> \n> Pomocy!$/);
  // The HTML: the logo inside, the answer in paragraphs, nothing anybody typed works as HTML.
  assert.ok(html.text.includes('src="cid:logo"'));
  assert.ok(html.text.includes('Cześć Ola!</p>'));
  assert.ok(html.text.includes('Kod już wysłaliśmy – sprawdź &lt;folder&gt; Spam &amp; „Oferty”.<br>Pozdrawiamy'));
  assert.ok(html.text.includes('Zapłaciłam i nie mam kodu &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(html.text, /Twoja wiadomość · \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} · temat: Hammer\+ i płatności/);
  assert.doesNotMatch(html.text, /<script|<folder>|<b>/);
  assert.ok(html.text.includes('href="https://discord.gg/hammerlauncher"'), 'the Discord link under it');
  // Kept on the message: the answer, who and when; the message counts as read and answered.
  const stored = webStore.getMessage(m.id);
  assert.equal(stored.replies.length, 1);
  assert.deepEqual({ ...stored.replies[0], at: 0 }, { text, subject: 'Re: Hammer+ i płatności – Hammer Launcher', at: 0, by: OWNER.id, ok: true });
  assert.deepEqual([stored.read, stored.readBy], [true, OWNER.id]);
  assert.deepEqual([res.body.item.answered, res.body.item.replies[0].ok, res.body.item.replies[0].by], [true, true, { id: OWNER.id, name: 'Szef' }]);
  assert.match(logText(), /Wysłano odpowiedź na wiadomość ze strony od \*\*Ola b\*\* \(Hammer\+ i płatności\) · <@1>/);
  // A subject of their own, with Polish letters – and the next answer goes under the first one.
  await reply(m.id, { subject: 'Twój kod Hammer+ – ważne', text: 'Jeszcze jedno.' });
  assert.equal(smtp.messages.at(-1).subject, 'Twój kod Hammer+ – ważne');
  assert.deepEqual(webStore.getMessage(m.id).replies.map((r) => r.text), [text, 'Jeszcze jedno.']);
  // An empty subject is the panel's default one.
  await reply(m.id, { subject: '  ', text: 'I jeszcze.' });
  assert.equal(smtp.messages.at(-1).subject, 'Re: Hammer+ i płatności – Hammer Launcher');
});

test('every way it can fail says why in Polish, is tried once, keeps the attempt – and the message stays unanswered', async () => {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    const m = message({ email: 'nikt@example.com' });
    const text = 'Odpowiedź, której nie wolno zgubić.';
    // E-mail not set up: says exactly what to add; nothing is tried, nothing kept.
    const off = await reply(m.id, { text });
    assert.equal(off.status, 503);
    assert.match(off.body.error, /^Odpowiedź nie wyszła\. E-mail nie jest włączony: w pliku \.env brakuje linii MAIL_PASS \(hasło do aplikacji z konta Google\)\. Potem uruchom bota ponownie/);
    assert.equal(webStore.getMessage(m.id).replies, undefined);
    // A wrong password.
    mailOn('zwykle-haslo');
    const sessions = smtp.sessions.length;
    const wrong = await reply(m.id, { text });
    assert.equal(wrong.status, 502);
    assert.match(wrong.body.error, /^Odpowiedź nie wyszła\. Serwer poczty 127\.0\.0\.1 nie przyjął hasła z pliku \.env \(MAIL_PASS\)[\s\S]*hasło do aplikacji/);
    assert.ok(!wrong.body.error.includes('zwykle-haslo'), 'never the password');
    assert.equal(smtp.sessions.length, sessions + 1, 'one try – no second one in the background');
    // The address is refused by the mail server.
    mailOn();
    smtp.behave = { rejectRcpt: true };
    const refused = await reply(m.id, { text });
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /odrzucił adres odbiorcy nikt@example\.com – sprawdź, czy nie ma w nim literówki/);
    // The mail server cannot be reached.
    smtp.behave = {};
    env.mail.port = await closedPort();
    mail._test({ plain: true, connectMs: 300, other: {} });
    const gone = await reply(m.id, { text });
    assert.equal(gone.status, 502);
    assert.match(gone.body.error, /Nie udało się połączyć z serwerem poczty 127\.0\.0\.1[\s\S]*hosting blokuje wysyłanie poczty/);
    // Every attempt is on the message with its reason; it is still unread and unanswered.
    const stored = webStore.getMessage(m.id);
    assert.deepEqual(stored.replies.map((r) => [r.ok, r.text]), [[false, text], [false, text], [false, text]]);
    assert.match(stored.replies[0].error, /nie przyjął hasła/);
    assert.equal(stored.read, false);
    assert.deepEqual([gone.body.item.answered, gone.body.item.replies.length], [false, 3]);
    assert.match(logText(), /Odpowiedź na wiadomość od \*\*Kuba\*\* \(Pomoc z launcherem\) nie wyszła/);
  } finally {
    Object.assign(console, { warn, log });
  }
});

test('a few answers a minute from one place – then a polite wait', async () => {
  mailOn();
  const m = message();
  const from = '10.92.0.1';
  for (let i = 0; i < 10; i += 1) assert.equal((await reply(m.id, { text: `Odpowiedź ${i}` }, { from })).status, 200);
  const over = await reply(m.id, { text: 'Jedenasta' }, { from });
  assert.deepEqual(over, { status: 429, body: { error: 'Za dużo odpowiedzi w krótkim czasie – odczekaj chwilę i wyślij ponownie.' } });
  assert.equal(webStore.getMessage(m.id).replies.length, 10);
  // The message keeps its newest 20 attempts.
  for (let i = 0; i < 12; i += 1) await reply(m.id, { text: `Dalej ${i}` });
  const kept = webStore.getMessage(m.id).replies;
  assert.deepEqual([kept.length, kept[0].text, kept.at(-1).text], [20, 'Odpowiedź 2', 'Dalej 11']);
});

test('the owner\'s own e-mail about a new message has Reply-To set to the sender – „Odpowiedz” in Gmail writes to them', () => {
  const owner = require('../src/web/contact').mailFor({ name: 'Ola', email: 'ola@example.com', topic: 'bug', text: 'x'.repeat(20), at: Date.now(), user: null });
  assert.equal(owner.replyTo, 'ola@example.com');
  const wire = mail.compose({ from: ADDRESS, to: ADDRESS, ...owner });
  assert.match(wire, /^Reply-To: <ola@example\.com>$/m);
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

test('in a real browser: „Odpowiedz” opens the form on the card, an error keeps the text, „Wyślij” sends – the badge and the history – also on a phone', { skip: !pw && 'Playwright is not installed' }, async () => {
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const shots = process.env.HS_SHOTS;
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      const w = viewport.width;
      webStore._state().messages = [];
      message({ name: 'Starsza', email: 'starsza@example.com', topic: 'collab', text: 'Proponuję współpracę.' });
      const m = message({ name: 'Kuba', email: `kuba${w}@example.com`, text: 'Cześć!\nLauncher nie widzi moich modów – co robić?' });
      mailOn('zle-haslo');
      const context = await browser.newContext({ viewport, ...(w < 500 && { isMobile: true, hasTouch: true }) });
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.93.0.${w % 250}` });
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      // (a 502 / 503 answer is the browser's "Failed to load resource" line – expected on the error paths)
      page.on('console', (msg) => msg.type() === 'error' && !/Failed to load resource/.test(msg.text()) && problems.push(`console: ${msg.text()}`));
      fakes.state.user = OWNER;
      await page.goto(`${base}/api/shop/auth/start?next=admin`);
      await page.goto(`${base}/admin#wiadomosci`);
      const card = page.locator('.msg-item', { hasText: `kuba${w}@example.com` });
      await card.waitFor();
      assert.equal(await card.locator('a.msg-mailto').getAttribute('href'), `mailto:kuba${w}@example.com?subject=${encodeURIComponent('Re: Pomoc z launcherem – Hammer Launcher')}`, 'the small mailto link stays');
      // Open the form: the subject is ready, the counter counts.
      await card.locator('button', { hasText: 'Odpowiedz' }).click();
      const form = card.locator('form.msg-reply-form');
      await form.waitFor();
      assert.equal(await form.locator('input').inputValue(), 'Re: Pomoc z launcherem – Hammer Launcher');
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
      assert.equal(await card.locator('button', { hasText: /^Odpowiedz$/ }).isVisible(), false);
      const answer = 'Cześć Kuba!\n\nWejdź w Ustawienia → Mody i kliknij „Odśwież”.\nDaj znać, czy pomogło.';
      await form.locator('textarea').fill(answer);
      assert.equal(await form.locator('.hint').textContent(), `${answer.length}/4000`);
      if (shots) await page.screenshot({ path: `${shots}/odpowiedz-formularz-${w}.png`, fullPage: false });
      // A wrong password: the reason under the form, the text still there – also after the list is drawn again.
      await form.locator('button[type="submit"]').click();
      const error = card.locator('form.msg-reply-form [role="alert"]');
      await page.waitForFunction(() => /nie przyjął hasła/.test(document.querySelector('form.msg-reply-form [role="alert"]')?.textContent ?? ''));
      assert.match(await error.textContent(), /^Odpowiedź nie wyszła\. Serwer poczty .* nie przyjął hasła/);
      assert.equal(await card.locator('form.msg-reply-form textarea').inputValue(), answer, 'nothing typed is lost');
      assert.equal(await card.locator('.msg-reply.failed').count(), 1, 'the failed attempt is listed');
      if (shots) await page.screenshot({ path: `${shots}/odpowiedz-blad-${w}.png` });
      // E-mail switched off: the exact line to add, the text still there.
      mailOff();
      await card.locator('form.msg-reply-form button[type="submit"]').click();
      await page.waitForFunction(() => /MAIL_PASS/.test(document.querySelector('form.msg-reply-form [role="alert"]')?.textContent ?? '') && !/nie przyjął/.test(document.querySelector('form.msg-reply-form [role="alert"]').textContent));
      assert.equal(await card.locator('form.msg-reply-form textarea').inputValue(), answer);
      // Fixed: sent – the form closes, the badge and the answer are on the card, the e-mail is out.
      mailOn();
      const arriving = smtp.next();
      await card.locator('form.msg-reply-form button[type="submit"]').click();
      await card.locator('.msg-answered').waitFor();
      assert.equal(await card.locator('.msg-answered').textContent(), '✅ Odpowiedziano');
      assert.equal(await card.locator('form.msg-reply-form').count(), 0, 'the form is closed');
      assert.match(await card.locator('.msg-reply:not(.failed)').textContent(), /Wysłana odpowiedź · .* · Szef · „Re: Pomoc z launcherem – Hammer Launcher”Cześć Kuba!/);
      assert.match(await page.locator('#toast').textContent(), new RegExp(`Odpowiedź wysłana na kuba${w}@example\\.com\\.`));
      const sent = await arriving;
      assert.deepEqual(sent.to, [`kuba${w}@example.com`]);
      assert.equal(webStore.getMessage(m.id).replies.at(-1).ok, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
      if (shots) {
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/odpowiedz-wyslana-${w}.png` });
      }
      // „Anuluj” on an empty form closes it; with text it asks first.
      await card.locator('button', { hasText: /^Odpowiedz$/ }).click();
      await card.locator('form.msg-reply-form textarea').fill('Szkic');
      await card.locator('form.msg-reply-form button', { hasText: 'Anuluj' }).click();
      await page.locator('#confirm[open]').waitFor();
      await page.locator('#confirm-no').click();
      assert.equal(await card.locator('form.msg-reply-form textarea').inputValue(), 'Szkic');
      await card.locator('form.msg-reply-form button', { hasText: 'Anuluj' }).click();
      await page.locator('#confirm-yes').click();
      await page.waitForFunction(() => !document.querySelector('form.msg-reply-form'));
      assert.deepEqual(problems, []);
      await context.close();
    }
  } finally {
    Object.assign(console, { warn, log });
    await browser.close();
  }
});
