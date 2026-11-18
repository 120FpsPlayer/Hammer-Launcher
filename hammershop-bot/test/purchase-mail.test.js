'use strict';

// After a payment on the website: the buyer's confirmation e-mail (HTML + text, for Hammer+ with the code) at the
// address they typed on Stripe's page, the owner's e-mail with the code and that address – each once per order and
// recorded on the order (the admin panel's „Zamówienia”) – the „Dziękujemy za zakup!” screen, and the owner's
// „Wyzeruj statystyki”. Over real HTTP against a local copy of the website with fake Discord, Stripe and Mojang and a
// local fake SMTP server – nothing reaches a real mail server. On the Hammer Launcher profile (it has a contact address).
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { textOf } = require('./helpers/fakeInteraction');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { startSmtp } = require('./helpers/fakeSmtp');
const { buildServer } = require('../src/builder/executor');
const { ROLES } = require('../src/builder/layout');
const { env } = require('../src/env');
const mail = require('../src/lib/mail');
const plus = require('../src/lib/plus');
const hammerplus = require('../src/features/hammerplus');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const releases = require('../src/web/releases');
const { createWebServer } = require('../src/web/server');

const ADDRESS = 'hammerlauncherclient@gmail.com';
const PASS = 'abcdefghijklmnop';
const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const ADMIN = { id: '200000000000000301', username: 'adminka', global_name: 'Adminka', avatar: null };
const BUYER = { id: '200000000000000303', username: 'kupiec', global_name: 'Kupiec', avatar: null };
const MC = { Notch: '069a79f444e94726a5befca90e38aaf5', Steve: '8667ba71b85a4004af54457a9734eed7' };
const BUYER_MAIL = 'jan.kowalski@gmail.com';

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
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Waits until fn() is true (the e-mails go out after the buyer's answer – nothing waits for them). */
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await tick();
  }
}
/** The console, quiet while fn runs. → { result, said } */
async function quietly(fn) {
  const said = [];
  const { warn, log } = console;
  console.warn = (...a) => said.push(a.join(' '));
  console.log = (...a) => said.push(a.join(' '));
  try {
    return { result: await fn(), said };
  } finally {
    Object.assign(console, { warn, log });
  }
}

/** The parts of a multipart message as the fake SMTP server got it: [{ type, encoding, text }]. */
/** The parts of a multipart body (a multipart/related part – the HTML with its pictures – is opened: its parts follow). */
function split(body, boundary) {
  return body.split(`--${boundary}`).slice(1, -1).flatMap((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const headers = Object.fromEntries(head.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    const inner = /^multipart\/related; boundary="([^"]+)"/.exec(headers['content-type'] ?? '')?.[1];
    if (inner) return split(rest.join('\r\n\r\n'), inner);
    const data = Buffer.from(rest.join('').replace(/\s+/g, ''), 'base64');
    return [{ type: headers['content-type'], encoding: headers['content-transfer-encoding'], cid: headers['content-id'] ?? null, data, text: data.toString('utf8').replace(/\r\n/g, '\n') }];
  });
}
function partsOf(message) {
  const boundary = /boundary="([^"]+)"/.exec(message.headers['content-type'] ?? '')?.[1];
  if (!boundary) return null;
  return split(message.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n'), boundary);
}
const to = (address) => smtp.messages.filter((m) => m.to.includes(address));

test.before(async () => {
  fakes = await startFakes();
  smtp = await startSmtp({ user: ADDRESS, pass: PASS });
  guild = new FakeGuild({ ownerId: OWNER.id });
  await buildServer({ guild, mode: 'add', invokerId: guild.ownerId });
  guild.addMember(ADMIN.id, [db.roleId(guild.id, ROLES.find((r) => r.perms === 'admin').key)]);
  guild.addMember(BUYER.id, [db.roleId(guild.id, 'member')]);
  env.plusPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  hammerplus.setFetch(async (url) => {
    const nick = decodeURIComponent(String(url).split('/').pop());
    const hit = Object.keys(MC).find((n) => n.toLowerCase() === nick.toLowerCase());
    return hit ? { ok: true, status: 200, json: async () => ({ id: MC[hit], name: hit }) } : { ok: false, status: 404, json: async () => ({}) };
  });
  website._setClient(guild.client);
  webAuth.setClientId('123');
  webStore.load();
  site = createWebServer({
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onPaid: website.onPaid, receipt: website.buyerMail, onLogin: website.onLogin, isMember: website.isMember, currency: () => 'pln',
    level: website.panelLevel, log: website.panelLog, plus: website.panelPlus, referrals: website.panelReferrals, statsReset: website.statsReset,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  webStore.setPlusPlans([{ id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1499 }, { id: 'px', name: 'Hammer+ na zawsze', days: 0, price: 7999 }]);
  for (const [name, user] of Object.entries({ owner: OWNER, admin: ADMIN, buyer: BUYER })) sids[name] = await signIn(user);
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
  const start = await fetch(`${base}/api/shop/auth/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const jar = [cookieOf(start, 'hs_oauth'), cookieOf(start, 'hs_next')].filter(Boolean).join('; ');
  const back = await fetch(`${base}/api/shop/auth/callback?code=good&state=${state}`, { headers: { cookie: jar }, redirect: 'manual' });
  return cookieOf(back, 'hs_sid');
}
async function call(method, pathname, { who = null, body, origin = base, headers = {}, raw } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: { 'x-forwarded-for': `10.61.${Math.floor(++ip / 250)}.${ip % 250}`, ...(who && { cookie: sids[who] }), ...(origin && method !== 'GET' && { origin }), ...((body !== undefined || raw !== undefined) && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(raw !== undefined && { body: raw }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** Starts a Hammer+ checkout → { sessionId, orderId }. */
async function checkout(plan, nick) {
  const res = await call('POST', '/api/shop/checkout', { who: 'buyer', body: { kind: 'plus', plan, nick, requestId: crypto.randomUUID() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { sessionId: res.body.url.split('/').pop(), orderId: res.body.order };
}
/** Buys Hammer+: pays on the fake Stripe (extra: what the session says once paid) and comes back to the page. */
async function buyPlus(plan, nick, extra = {}) {
  const { sessionId, orderId } = await checkout(plan, nick);
  fakes.pay(sessionId, extra);
  const verified = await call('POST', '/api/shop/verify', { who: 'buyer', body: { sessionId } });
  assert.deepEqual([verified.status, verified.body.paid], [200, true]);
  return { sessionId, orderId };
}
/** A Stripe webhook, signed like Stripe signs it (STRIPE_WEBHOOK_SECRET = whsec_test in the fakes). */
function webhook(type, object) {
  const raw = JSON.stringify({ id: `evt_${crypto.randomBytes(6).toString('hex')}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex');
  return call('POST', '/api/shop/stripe/webhook', { raw, origin: null, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
}
const myOrder = async (id) => (await call('GET', '/api/shop/orders', { who: 'buyer' })).body.orders.find((o) => o.id === id);
const panelOrder = async (id) => (await call('GET', '/api/admin/orders', { who: 'owner' })).body.orders.find((o) => o.id === id);

test('mail: an HTML version goes next to the text (multipart/alternative, both base64, a boundary nothing can fake) – text-only mail is unchanged', () => {
  const plainOnly = mail.compose({ from: ADDRESS, to: ADDRESS, subject: 'Temat', text: 'Zażółć\ngęślą' });
  assert.match(plainOnly, /\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.doesNotMatch(plainOnly, /multipart|boundary/);
  assert.equal(mail.compose({ from: ADDRESS, to: ADDRESS, subject: 'x', text: 'y', html: '   ' }).includes('multipart'), false, 'an empty html is no html');

  const html = '<p>Kod: <b>HP1.abc</b></p>\r\n--=_hs_000000000000000000000000--\r\n.\r\nBcc: someone@evil.example';
  const raw = mail.compose({ from: ADDRESS, fromName: 'Hammer Launcher', to: BUYER_MAIL, subject: 'Dziękujemy\r\nBcc: x@evil.example', text: 'Twój kod: HP1.abc', html });
  const [head, ...rest] = raw.split('\r\n\r\n');
  assert.doesNotMatch(head, /^Bcc:/im, 'nothing in the subject starts a header');
  assert.doesNotMatch(head, /^Content-Transfer-Encoding:/m, 'the encoding is per part');
  const boundary = /^Content-Type: multipart\/alternative; boundary="(=_hs_[0-9a-f]{24})"$/m.exec(head)?.[1];
  assert.ok(boundary, head);
  const body = rest.join('\r\n\r\n');
  assert.ok(body.startsWith(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`));
  assert.ok(raw.endsWith(`\r\n--${boundary}--\r\n`));
  // Every line is a boundary, a part's header, an empty line or base64 – what the HTML had in it is inside the base64.
  for (const line of body.split('\r\n')) assert.ok(line === '' || line.startsWith(`--${boundary}`) || /^Content-(Type|Transfer-Encoding): /.test(line) || /^[A-Za-z0-9+/=]{1,76}$/.test(line), line);
  assert.equal(body.split('\r\n').filter((l) => l.startsWith('--')).length, 3, 'two parts and the end – the fake boundary in the HTML is not one');
  const parts = partsOf({ raw, headers: { 'content-type': `multipart/alternative; boundary="${boundary}"` } });
  assert.deepEqual(parts.map((p) => [p.type, p.encoding]), [['text/plain; charset=utf-8', 'base64'], ['text/html; charset=utf-8', 'base64']]);
  assert.equal(parts[0].text, 'Twój kod: HP1.abc');
  assert.equal(parts[1].text, html.replace(/\r\n/g, '\n'));
  assert.notEqual(boundary, /boundary="([^"]+)"/.exec(mail.compose({ from: ADDRESS, to: ADDRESS, subject: 's', text: 't', html: '<p>x</p>' }))[1], 'a new boundary for every message');
  // mask: enough for the owner of the address to recognise it.
  assert.deepEqual([mail.mask(BUYER_MAIL), mail.mask('ab@x.pl'), mail.mask('a@x.pl'), mail.mask('nie adres'), mail.mask(null)], ['ja***@gmail.com', 'a***@x.pl', 'a***@x.pl', null, null]);
});

test('the buyer gets the confirmation with the code (HTML + text) at the address from Stripe, the owner gets the code and that address – once per order, recorded on the order', async () => {
  mailOn();
  smtp.messages.length = 0;
  const { sessionId, orderId } = await buyPlus('p30', 'Steve', { customer_details: { email: BUYER_MAIL, name: 'Jan Kowalski' } });
  // The line under Stripe's Pay button comes from config.launcher.json → checkout.plusMessage – and mentions the e-mail.
  assert.equal(fakes.state.lastCheckout.get('custom_text[submit][message]'), require('../src/lib/config').checkout.plusMessage);
  assert.match(fakes.state.lastCheckout.get('custom_text[submit][message]'), /na e-mail podany wyżej/);
  // The name above the price and the line under it: config.launcher.json → checkout.plusName / plusDescription.
  assert.match(fakes.state.lastCheckout.get('line_items[0][price_data][product_data][name]'), / – Steve$/);
  assert.equal(fakes.state.lastCheckout.get('line_items[0][price_data][product_data][description]'), 'Hammer+ w Hammer Launcherze dla konta Minecraft Steve – 30 dni');
  await until(() => to(BUYER_MAIL).length === 1 && to(ADDRESS).length === 1, 'both e-mails');
  const order = webStore.getOrder(orderId);
  assert.equal(order.email, BUYER_MAIL, 'the order keeps the address from the Checkout Session');
  const mine = await myOrder(orderId);
  const code = mine.plus.code;
  assert.equal(plus.verify(code).mc, MC.Steve);

  // The buyer's e-mail.
  const buyer = to(BUYER_MAIL)[0];
  assert.equal(buyer.subject, 'Dziękujemy za zakup Hammer+ – Twój kod');
  assert.deepEqual([buyer.from, buyer.headers['reply-to']], [ADDRESS, `<${ADDRESS}>`]);
  assert.match(buyer.headers['content-type'], /^multipart\/alternative; boundary="=_hs_[0-9a-f]{24}"$/);
  const [text, html, icon] = partsOf(buyer);
  assert.equal(text.type, 'text/plain; charset=utf-8');
  assert.equal(html.type, 'text/html; charset=utf-8');
  // The server's icon travels inside the e-mail (no picture is loaded from the internet) and sits next to the name.
  assert.deepEqual([icon.type, icon.cid], ['image/png', '<logo>']);
  assert.ok(icon.data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'a real PNG');
  assert.match(html.text, /<img src="cid:logo" width="44" height="44" alt=""/);
  for (const line of ['Dziękujemy za zakup Hammer+!', `\n\n${code}\n\n`, 'Plan: Hammer+ na 30 dni', 'Konto Minecraft: Steve', 'Ważny: do ', `Numer zamówienia: ${orderId}`, 'Zapłacono: 14,99 PLN · płatność online', '1. Otwórz Hammer Launcher i wejdź w zakładkę Hammer+.', '2. Kliknij „Mam kod” i wklej kod.', '3. Kliknij „Aktywuj” – gotowe.', 'Kod działa tylko na koncie Minecraft Steve.', `${base}/hammer-plus`, `Otwórz ticket „Hammer+ i płatności” na naszym Discordzie (${env.web.invite})`, ADDRESS]) {
    assert.ok(text.text.includes(line), `${line}\n---\n${text.text}`);
  }
  for (const piece of ['Dziękujemy za zakup!', code, 'Hammer+ na 30 dni', 'Steve', orderId, '„Mam kod”', '„Aktywuj”', `href="${base}/hammer-plus"`, `href="${env.web.invite}"`, `href="mailto:${ADDRESS}"`, 'Hammer+ i płatności', 'Hammer<span style="color:#ff9a3c;">Launcher</span>']) {
    assert.ok(html.text.includes(piece), `${piece}\n---\n${html.text.slice(0, 400)}`);
  }
  // Gmail-safe: inline styles only, nothing loaded from anywhere, no scripts.
  assert.doesNotMatch(html.text, /<script|<style|<link|url\(/i);
  assert.deepEqual(html.text.match(/src="[^"]*"/g), ['src="cid:logo"'], 'the only picture is the one inside the e-mail');
  assert.match(html.text, /^<!doctype html>/);

  // The owner's e-mail: the code and the buyer's address, and that the confirmation went out.
  const owner = to(ADDRESS)[0];
  assert.equal(owner.subject, '[Zakup] Hammer+ 30 dni – Steve – 14,99 PLN');
  for (const line of [`E-mail kupującego: ${BUYER_MAIL} (podany przy płatności w Stripe)`, `Potwierdzenie do kupującego: wysłane na ${BUYER_MAIL}`, `Kod Hammer+ (gdyby kupujący napisał, że go nie ma):\n${code}`]) assert.ok(owner.text.includes(line), `${line}\n---\n${owner.text}`);
  assert.equal(partsOf(owner), null, 'the owner gets plain text, as before');
  assert.ok(smtp.messages.indexOf(buyer) < smtp.messages.indexOf(owner), 'the buyer first');

  // The order remembers both; the panel shows them (the full address – it is the team's panel).
  assert.deepEqual([order.mails.buyer.state, order.mails.buyer.to, order.mails.owner.state], ['sent', BUYER_MAIL, 'sent']);
  const row = await panelOrder(orderId);
  assert.equal(row.email, BUYER_MAIL);
  assert.deepEqual([row.mails.buyer.state, row.mails.buyer.to, row.mails.owner.state], ['sent', BUYER_MAIL, 'sent']);
  // The page: masked, and whether the DM reached them.
  assert.deepEqual(mine.receipt, { email: 'ja***@gmail.com', state: 'sent', dm: true });
  assert.equal(mine.plus.plan, 'Hammer+ na 30 dni');

  // Once per order: a re-delivered webhook, the page reloaded (verify again), the bot asked again – nothing more.
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) assert.equal((await webhook(type, fakes.state.sessions.get(sessionId))).status, 200);
  assert.equal((await call('POST', '/api/shop/verify', { who: 'buyer', body: { sessionId } })).body.paid, true);
  assert.equal(website.buyerMail(webStore.getOrder(orderId)), null);
  assert.equal(website.purchaseMail(webStore.getOrder(orderId)), null);
  await tick(200);
  assert.deepEqual([to(BUYER_MAIL).length, to(ADDRESS).length], [1, 1]);
});

test('the address: customer_email when the session has no customer_details; the webhook path reads a trimmed session from Stripe once; none → skipped and said why', async () => {
  mailOn();
  smtp.messages.length = 0;
  // customer_email (a session made with one) – used when customer_details has none.
  const a = await buyPlus('p30', 'Notch', { customer_email: 'ola@example.com' });
  await until(() => to('ola@example.com').length === 1 && webStore.getOrder(a.orderId).mails?.owner?.state === 'sent', 'customer_email');
  assert.equal(webStore.getOrder(a.orderId).email, 'ola@example.com');

  // The webhook comes first (the buyer closed the tab) with a payload without the address: Stripe is asked once.
  const b = await checkout('p30', 'Steve');
  fakes.pay(b.sessionId, { customer_details: { email: 'Kuba.Nowak+mc@Example.com' } });
  const trimmed = { ...fakes.state.sessions.get(b.sessionId) };
  delete trimmed.customer_details;
  const asked = [];
  const { fetch: before } = global;
  global.fetch = (url, opts) => {
    if (String(url).includes(`/checkout/sessions/${b.sessionId}`)) asked.push(String(url));
    return before(url, opts);
  };
  try {
    assert.equal((await webhook('checkout.session.completed', trimmed)).status, 200);
  } finally {
    global.fetch = before;
  }
  assert.equal(asked.length, 1, 'read from Stripe once');
  assert.equal(webStore.getOrder(b.orderId).email, 'Kuba.Nowak+mc@Example.com');
  await until(() => to('Kuba.Nowak+mc@Example.com').length === 1, 'the webhook path e-mails the buyer too');
  assert.match(to('Kuba.Nowak+mc@Example.com')[0].subject, /Twój kod/);

  // No address anywhere (or one the mail client cannot use): the buyer's e-mail is skipped, the reason recorded, the owner told.
  for (const extra of [{}, { customer_details: { email: 'zly adres@@x' } }]) {
    const c = await buyPlus('p30', 'Notch', extra);
    await until(() => webStore.getOrder(c.orderId).mails?.owner?.state === 'sent', 'the owner e-mail');
    const o = webStore.getOrder(c.orderId);
    assert.equal(o.email, null);
    assert.equal(o.mails.buyer.state, 'none');
    assert.match(o.mails.buyer.reason, /Stripe nie podał adresu e-mail kupującego/);
    const ownerText = smtp.messages.at(-1).text;
    assert.ok(ownerText.includes('E-mail kupującego: brak – Stripe go nie podał') && ownerText.includes('Potwierdzenie do kupującego: nie wysłane – Stripe nie podał adresu e-mail'), ownerText);
    assert.deepEqual((await myOrder(c.orderId)).receipt, { email: null, state: 'not-sent', dm: true });
  }
});

test('mail off or failing: the purchase is untouched, nothing waits, and the order says why each e-mail did not go out', async () => {
  // Off (no MAIL_PASS): recorded with the reason, no connection at all.
  smtp.messages.length = 0;
  const sessions = smtp.sessions.length;
  const off = await buyPlus('p30', 'Steve', { customer_details: { email: BUYER_MAIL } });
  await until(() => webStore.getOrder(off.orderId).mails?.owner, 'recorded');
  const o = webStore.getOrder(off.orderId);
  assert.deepEqual([o.status, o.delivered, o.email], ['paid', true, BUYER_MAIL]);
  assert.deepEqual([o.mails.buyer.state, o.mails.owner.state], ['off', 'off']);
  assert.match(o.mails.buyer.reason, /brakuje linii MAIL_PASS/);
  assert.equal(smtp.sessions.length, sessions);
  const row = await panelOrder(off.orderId);
  assert.deepEqual([row.mails.buyer.state, row.mails.owner.state], ['off', 'off']);
  assert.deepEqual((await myOrder(off.orderId)).receipt.email, null, 'the page does not promise an e-mail that never left');

  // A wrong password: both tried, both recorded as failed with the server's reason – the buyer still has the code.
  mailOn('zle-haslo');
  const { result: bad } = await quietly(async () => {
    const r = await buyPlus('p30', 'Steve', { customer_details: { email: BUYER_MAIL } });
    await until(() => ['failed'].includes(webStore.getOrder(r.orderId).mails?.owner?.state), 'both failed');
    return r;
  });
  const failed = webStore.getOrder(bad.orderId);
  assert.equal(failed.mails.buyer.state, 'failed');
  assert.match(failed.mails.buyer.reason, /nie przyjął hasła z pliku \.env \(MAIL_PASS\)/);
  assert.ok(!JSON.stringify(failed.mails).includes('zle-haslo'));
  const ownerFailed = failed.mails.owner;
  assert.equal(ownerFailed.state, 'failed');
  assert.ok(plus.verify((await myOrder(bad.orderId)).plus.code));
  // A failed one may be sent when asked again (the owner's purchase e-mail after fixing the password).
  mailOn();
  assert.deepEqual(await website.buyerMail(webStore.getOrder(bad.orderId)), { ok: true });
  assert.equal(webStore.getOrder(bad.orderId).mails.buyer.state, 'sent');
  // „W drodze” for longer than a few minutes = cut off by a restart: the panel says so.
  webStore.updateOrder(bad.orderId, { mails: { ...webStore.getOrder(bad.orderId).mails, owner: { state: 'pending', to: null, at: Date.now() - 6 * 60_000 } } });
  const stale = (await panelOrder(bad.orderId)).mails.owner;
  assert.deepEqual([stale.state, stale.reason], ['failed', 'Bot został uruchomiony ponownie, zanim e-mail wyszedł.']);

  // A slow mail server: the buyer's answer comes before the e-mail is even on its way.
  smtp.behave = { greetDelay: 1500 };
  smtp.messages.length = 0;
  const started = Date.now();
  const slow = await buyPlus('p30', 'Notch', { customer_details: { email: BUYER_MAIL } });
  assert.ok(Date.now() - started < 1400, 'nobody waited for the mail server');
  assert.equal((await myOrder(slow.orderId)).receipt.state, 'sending');
  assert.equal((await myOrder(slow.orderId)).receipt.email, 'ja***@gmail.com');
  await until(() => to(BUYER_MAIL).length === 1, 'it still arrives', 8000);
});

test('a shop order (products) gets a short confirmation too: what was bought, the amount, where it is delivered', async () => {
  mailOn();
  smtp.messages.length = 0;
  const order = webStore.createOrder({ userId: BUYER.id, kind: 'products', items: [{ id: 'a', name: 'Gra <A>', price: 1500, quantity: 2 }, { id: 'b', name: 'Bot B', price: 1550, quantity: 1 }], amount: 4550, currency: 'pln', requestId: 'r-shop-1' });
  webStore.markPaid(order.id, { email: 'kupiec@example.com' });
  webStore.updateOrder(order.id, { ticketUrl: 'https://discord.com/channels/1/2', ticketNumber: '0007', delivery: 'Twoje zamówienie czeka w tickecie #0007 na Discordzie.' });
  await website.orderMails(order.id);
  const sent = to('kupiec@example.com')[0];
  assert.equal(sent.subject, `Dziękujemy za zakup – zamówienie ${order.id}`);
  const [text, html] = partsOf(sent);
  for (const line of ['- 2× Gra <A>', '- 1× Bot B', 'Zapłacono: 45,50 PLN', 'Dostawa: Twoje zamówienie czeka w tickecie #0007', 'Ticket na Discordzie: https://discord.com/channels/1/2']) assert.ok(text.text.includes(line), `${line}\n---\n${text.text}`);
  assert.ok(html.text.includes('2× Gra &lt;A&gt;') && !html.text.includes('Gra <A>'), 'what was typed into a product name is escaped');
  assert.ok(html.text.includes('href="https://discord.com/channels/1/2"'));
  const owner = to(ADDRESS).at(-1);
  assert.ok(owner.text.includes('Potwierdzenie do kupującego: wysłane na kupiec@example.com'), owner.text);
  assert.deepEqual([webStore.getOrder(order.id).mails.buyer.state, webStore.getOrder(order.id).mails.owner.state], ['sent', 'sent']);
});

test('„Wyzeruj statystyki”: the owner only, after typing ZERUJ – downloads and launcher starts go to 0 (also on Discord), nothing else is touched', async () => {
  // Some statistics, and everything that must stay.
  fs.mkdirSync(releases.DIR(), { recursive: true });
  fs.writeFileSync(releases.fileOf('Hammer-Launcher-Setup-9.0.0.exe'), Buffer.from('MZ-fake-installer'));
  await quietly(() => releases.publish({ version: '9.0.0', file: 'Hammer-Launcher-Setup-9.0.0.exe', notes: 'x' }));
  for (let i = 0; i < 3; i += 1) webStore.countDownload('9.0.0');
  webStore.countDownload('9.0.0', Date.now() - 86_400_000 * 2);
  webStore.countLaunch('9.0.0', 'k1');
  webStore.countLaunch('9.0.0', 'k2');
  webStore.countUserDownload(BUYER.id);
  const code = webStore.referralCode(OWNER.id);
  webStore.addReferral(BUYER.id, OWNER.id);
  webStore.addReferralDays(OWNER.id, 7, { balance: true });
  webStore.addNews({ title: 'Zostaje', body: '', by: OWNER.id });
  const keep = () => JSON.stringify({ orders: webStore.allOrders(), users: webStore._state().users, plans: webStore.plusPlans(), news: webStore.newsList(), current: webStore.currentRelease()?.version, files: webStore.releases().map((r) => r.file), refs: { code: webStore.referrerOf(code), by: webStore.referralOf(BUYER.id).by, earned: webStore.referralOf(OWNER.id).earned, balance: webStore.referralOf(OWNER.id).balance } });
  const kept = keep();
  const channel = guild.channels.cache.get(db.channelId(guild.id, 'statDownloads'));
  assert.ok(channel, 'the launcher server has the „📥 Pobrania” channel');
  await channel.setName('📥 Pobrania: 4');
  assert.equal((await call('GET', '/api/admin/overview', { who: 'owner' })).body.downloads.total30, 4);

  // Who may: not an admin, not without the panel's Origin, not without ZERUJ.
  const reset = (opts) => call('POST', '/api/admin/stats/reset', { who: 'owner', body: { confirm: 'ZERUJ' }, ...opts });
  assert.equal((await reset({ who: 'admin' })).status, 403);
  assert.equal((await reset({ who: 'buyer' })).status, 403);
  assert.equal((await reset({ who: null })).status, 401);
  assert.equal((await reset({ origin: null })).status, 403);
  for (const confirm of [undefined, '', 'tak', 'ZERUJ TO']) {
    const res = await reset({ body: { confirm } });
    assert.deepEqual([res.status, res.body.error], [400, 'Wpisz ZERUJ w polu potwierdzenia – bez tego statystyki zostają.']);
  }
  assert.equal(webStore.releases()[0].downloads, 4, 'nothing changed so far');

  const { result: done, said } = await quietly(() => reset({ body: { confirm: ' zeruj ' } }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.before, { downloads: 4, launches: 2, releases: 4, people: 1 });
  assert.equal(done.body.overview.downloads.total30, 0);
  assert.ok(said.some((l) => /Statystyki wyzerowane z panelu admina przez 1: było 4 pobrań/.test(l)), said.join('\n'));
  // All the counters at 0 …
  assert.deepEqual(webStore.stats(), { downloads: {}, launches: {} });
  assert.equal(webStore.releases()[0].downloads, 0);
  assert.deepEqual([webStore.referralOf(BUYER.id).downloads, webStore.referralOf(BUYER.id).downloadedAt], [0, undefined]);
  assert.equal(webStore.referralStats(OWNER.id).downloaded, 0);
  const overview = (await call('GET', '/api/admin/overview', { who: 'owner' })).body;
  assert.deepEqual([overview.downloads.total30, overview.launches.today], [0, 0]);
  // … everything else as it was, and on the disk.
  assert.equal(keep(), kept);
  const disk = JSON.parse(fs.readFileSync(require('node:path').join(db.dataDir, 'web.json'), 'utf8'));
  assert.deepEqual(disk.stats, { downloads: {}, launches: {} });
  assert.ok(Object.keys(disk.orders).length > 0);
  // Discord: the channel shows 0, the log channel has who did it.
  await until(() => /: 0$/.test(channel.name), 'the channel renamed');
  assert.match(channel.name, /📥.*: 0$/);
  const logs = guild.channels.cache.get(db.channelId(guild.id, 'serverLogs')).messageList.map((m) => textOf(m.body)).join('\n');
  assert.match(logs, /Wyzerowano statystyki strony \(pobrania i uruchomienia launchera; było 4 pobrań z 90 dni i 4 na liczniku wersji\) · <@1>/);
  // Counting goes on from 0.
  webStore.countDownload('9.0.0');
  webStore.countLaunch('9.0.0', 'k1'); // seen before the reset – today's count starts again
  assert.deepEqual([webStore.releases()[0].downloads, Object.values(webStore.stats().launches)[0].unique], [1, 1]);
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

test('„Dziękujemy za zakup!” in a browser: the code big with „Kopiuj kod”, the steps, where else it went – closes with Esc and ×; processing and cancelled; no errors, nothing too wide', { skip: !pw && 'Playwright is not installed' }, async () => {
  mailOn();
  const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  try {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, reducedMotion: viewport.width < 500 ? 'reduce' : 'no-preference' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await context.addCookies([{ name: 'hs_sid', value: sids.buyer.split('=')[1], url: base }]);
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': `10.62.0.${viewport.width % 250}` });
      const tab = await context.newPage();
      const problems = [];
      tab.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      tab.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      const fits = () => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('#thanks *')].every((n) => n.getBoundingClientRect().right <= window.innerWidth + 0.5));

      // Paid: back from Stripe.
      const { sessionId, orderId } = await checkout('p30', 'Steve');
      fakes.pay(sessionId, { customer_details: { email: BUYER_MAIL } });
      await tab.goto(`${base}/hammer-plus?payment=return&session_id=${sessionId}`);
      await tab.locator('#thanks[open].paid .thanks-code').waitFor();
      const code = await tab.locator('#thanks-code').textContent();
      assert.equal(plus.verify(code).mc, MC.Steve);
      assert.equal(await tab.locator('#thanks-h').textContent(), 'Dziękujemy za zakup!');
      assert.deepEqual(await tab.locator('.thanks-facts dd').allTextContents(), ['Hammer+ na 30 dni', 'Steve', `do ${new Date(webStore.getOrder(orderId).plus.exp * 1000).toLocaleDateString('pl-PL')}`]);
      assert.deepEqual(await tab.locator('.thanks-steps li').allTextContents(), ['Otwórz Hammer Launcher → Hammer+', 'Kliknij „Mam kod” i wklej kod', 'Kliknij „Aktywuj” – gotowe!']);
      assert.match(await tab.locator('.thanks-note').textContent(), /Kod działa tylko na koncie Steve\. (Kod wysłaliśmy też w wiadomości prywatnej na Discordzie i na e[-\u2011]mail|Kod wysłaliśmy też w wiadomości prywatnej na Discordzie, a e[-\u2011]mail z kodem jest w drodze na) ja\*\*\*@gmail\.com\./);
      assert.equal(await tab.evaluate(() => document.activeElement.textContent), 'Kopiuj kod', 'the copy button has the focus');
      assert.equal(await fits(), true, `fits at ${viewport.width}`);
      // Copy: the code in the clipboard, the button says so.
      await tab.locator('.thanks-copy').click();
      await tab.locator('.thanks-copy.copied').waitFor();
      assert.equal(await tab.locator('.thanks-copy').textContent(), 'Skopiowano!');
      assert.equal(await tab.evaluate(() => navigator.clipboard.readText()), code);
      assert.match(await tab.locator('.thanks-status').textContent(), /Kod skopiowany/);
      assert.equal(await tab.locator('.thanks-actions a[href="/download"]').textContent(), 'Pobierz launcher', 'a launcher is published (the test above) – the download is one click away');
      // Esc closes it; the code stays on the page.
      await tab.keyboard.press('Escape');
      await tab.locator('#thanks').waitFor({ state: 'hidden' });
      assert.match(await tab.locator('#plus-result .code-card b').textContent(), /Gotowe! Konto Steve/);
      assert.equal(new URL(tab.url()).search, '', 'the address is clean – a refresh shows nothing again');

      // Processing: Stripe has not confirmed yet – the screen says so; once paid it turns into the thank-you screen.
      const late = await checkout('p30', 'Notch');
      await tab.goto(`${base}/hammer-plus?payment=return&session_id=${late.sessionId}`);
      await tab.locator('#thanks[open].waiting').waitFor();
      assert.equal(await tab.locator('#thanks-h').textContent(), 'Płatność się przetwarza…');
      assert.equal(await fits(), true);
      fakes.pay(late.sessionId, { customer_details: { email: BUYER_MAIL } });
      await tab.locator('#thanks[open].paid .thanks-code').waitFor({ timeout: 8000 });
      // „Moje kody” closes it and goes to the code.
      await tab.locator('.thanks-actions button', { hasText: 'Moje kody' }).click();
      await tab.locator('#thanks').waitFor({ state: 'hidden' });

      // Cancelled: nothing taken, the plans one click away; × closes.
      await tab.goto(`${base}/hammer-plus?payment=cancelled`);
      await tab.locator('#thanks[open].cancelled').waitFor();
      assert.equal(await tab.locator('#thanks-h').textContent(), 'Płatność anulowana');
      assert.match(await tab.locator('#thanks-lead').textContent(), /Nic nie zostało pobrane/);
      assert.equal(await fits(), true);
      await tab.locator('#thanks-close').click();
      await tab.locator('#thanks').waitFor({ state: 'hidden' });
      assert.deepEqual(problems, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
