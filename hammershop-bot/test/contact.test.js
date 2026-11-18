'use strict';

// The website's contact form, its messages in the admin panel („Wiadomości”) and the e-mails the owner gets (contact
// messages, purchases, claimed referral rewards) – over real HTTP against a local copy of the website, with a fake
// Discord server, fake Stripe and Mojang and a local fake SMTP server. On the Hammer Launcher profile – the one that
// has a contact address.
process.env.HS_TEST_PROFILE = 'launcher';

const realFetch = global.fetch;
const { db } = require('./helpers/setup');
global.fetch = realFetch;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FakeGuild } = require('./helpers/fakeDiscord');
const { textOf } = require('./helpers/fakeInteraction');
const { startFakes, useFakes } = require('./helpers/webFakes');
const { startSmtp } = require('./helpers/fakeSmtp');
const { buildServer } = require('../src/builder/executor');
const { ROLES } = require('../src/builder/layout');
const { env } = require('../src/env');
const config = require('../src/lib/config');
const mail = require('../src/lib/mail');
const plus = require('../src/lib/plus');
const hammerplus = require('../src/features/hammerplus');
const website = require('../src/features/website');
const webStore = require('../src/web/store');
const webAuth = require('../src/web/discord');
const contact = require('../src/web/contact');
const { createWebServer } = require('../src/web/server');

const ADDRESS = 'hammerlauncherclient@gmail.com';
const PASS = 'abcdefghijklmnop';
const OWNER = { id: '1', username: 'szef', global_name: 'Szef', avatar: null };
const ADMIN = { id: '200000000000000201', username: 'adminka', global_name: 'Adminka', avatar: null };
const MEMBER = { id: '200000000000000202', username: 'gracz', global_name: 'Gracz', avatar: null };
const BUYER = { id: '200000000000000203', username: 'kupiec', global_name: 'Kupiec', avatar: null };
const MC = { Notch: '069a79f444e94726a5befca90e38aaf5', Steve: '8667ba71b85a4004af54457a9734eed7' };

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
    catalog: website.catalog, info: () => ({ invite: 'https://discord.gg/hammerlauncher' }), onPaid: website.onPaid, onLogin: website.onLogin, isMember: website.isMember, currency: () => 'pln',
    level: website.panelLevel, log: website.panelLog, plus: website.panelPlus, referrals: website.panelReferrals, contact: website.contactCard,
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  site.unref();
  base = `http://127.0.0.1:${site.address().port}`;
  fakes.state.siteBase = base;
  useFakes(env, fakes.base, base);
  for (const [name, user] of Object.entries({ owner: OWNER, admin: ADMIN, member: MEMBER, buyer: BUYER })) sids[name] = await signIn(user);
});
test.after(() => {
  site?.close();
  fakes?.server.close();
  smtp?.close();
});
test.beforeEach(() => {
  smtp.behave = {};
  mailOff();
  contact._reset(); // the limit for everybody together starts anew
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

/** → { status, body }. who: 'owner' | 'admin' | 'member' | 'buyer' | null (not signed in); from: a fixed address (else a new one each call). */
async function call(method, pathname, { who = null, body, raw, origin = base, from, type = 'application/json' } = {}) {
  const res = await fetch(base + pathname, {
    method,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': from ?? `10.44.${Math.floor(++ip / 250)}.${ip % 250}`,
      ...(who && { cookie: sids[who] }),
      ...(origin && method !== 'GET' && { origin }),
      ...((body !== undefined || raw !== undefined) && { 'content-type': type }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(raw !== undefined && { body: raw }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const GOOD = { name: 'Kuba', email: 'kuba@example.com', topic: 'launcher', message: 'Cześć! Launcher nie widzi moich modów.', website: '' };
const write = (fields = {}, opts = {}) => call('POST', '/api/shop/contact', { body: { ...GOOD, ...fields }, ...opts });
/** Sends a message and waits until its e-mail and Discord card are out. → the stored message */
async function written(fields = {}, opts = {}) {
  const res = await write(fields, opts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true });
  await contact.settled();
  return webStore.messageList()[0];
}
const admin = (method, route, opts = {}) => call(method, `/api/admin/${route}`, { who: 'owner', ...opts });
const channel = (key) => guild.channels.cache.get(db.channelId(guild.id, key));
const channelText = (key) => channel(key).messageList.map((m) => textOf(m.body)).join('\n');
const json = (payload) => JSON.stringify((payload.components ?? []).map((c) => (c.toJSON ? c.toJSON() : c)));

test('GET contact: the public address, the five topics, and whether e-mail is on – for anybody', async () => {
  const off = await call('GET', '/api/shop/contact');
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, {
    email: ADDRESS,
    topics: [{ id: 'launcher', label: 'Pomoc z launcherem' }, { id: 'plus', label: 'Hammer+ i płatności' }, { id: 'bug', label: 'Zgłoszenie błędu' }, { id: 'collab', label: 'Współpraca' }, { id: 'other', label: 'Inne' }],
    mail: false,
  });
  mailOn();
  assert.equal((await call('GET', '/api/shop/contact')).body.mail, true);
  // A site without a contact address says null, not an empty string.
  config.contact.email = '';
  try {
    assert.deepEqual([(await call('GET', '/api/shop/contact')).body.email, (await call('GET', '/api/shop/contact')).body.mail], [null, false]);
  } finally {
    config.contact.email = ADDRESS;
  }
});

test('the form is checked: a Polish sentence for every wrong field, nothing kept, nobody told', async () => {
  const cards = channel('staffChat').messageList.length;
  const wrong = async (fields, pattern, status = 400) => {
    const res = await write(fields);
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.match(res.body.error, pattern);
    assert.deepEqual(Object.keys(res.body), ['error']);
  };
  await wrong({ name: ' K ' }, /^Wpisz swoje imię albo nick – co najmniej 2 znaki\.$/);
  await wrong({ name: undefined }, /Wpisz swoje imię albo nick/);
  await wrong({ name: { toString: 'x' } }, /Wpisz swoje imię albo nick/);
  await wrong({ name: 'x'.repeat(61) }, /^Imię albo nick może mieć najwyżej 60 znaków\.$/);
  await wrong({ email: '   ' }, /^Wpisz swój adres e-mail – na niego odpiszemy\.$/);
  await wrong({ email: `${'a'.repeat(60)}@${'b'.repeat(60)}.pl` }, /^Adres e-mail może mieć najwyżej 120 znaków\.$/);
  for (const email of ['kuba', 'kuba@', 'kuba@example', 'kuba @example.com', 'kuba@example.com, inny@example.com', 'Kuba <kuba@example.com>', 'kuba@example.com\nBcc: x@y.pl', 'kuba@exa mple.com', 'ku"ba@example.com', 'kuba@-example.com']) {
    await wrong({ email }, /^Ten adres e-mail wygląda na błędny – sprawdź, czy nie ma w nim literówki\.$/);
  }
  await wrong({ topic: 'reklama' }, /^Wybierz temat wiadomości\.$/);
  await wrong({ topic: undefined }, /^Wybierz temat wiadomości\.$/);
  await wrong({ message: ' za mało ' }, /^Napisz wiadomość – co najmniej 10 znaków\.$/);
  await wrong({ message: 'x'.repeat(2001) }, /^Wiadomość może mieć najwyżej 2000 znaków \(teraz 2001\)\.$/);
  // Not JSON, broken JSON, another site.
  assert.equal((await call('POST', '/api/shop/contact', { raw: 'name=Kuba', type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call('POST', '/api/shop/contact', { raw: '{"name":' })).status, 400);
  assert.equal((await call('POST', '/api/shop/contact', { raw: 'null' })).status, 400, 'an empty form is a wrong form, not a crash');
  assert.equal((await write({}, { origin: 'https://evil.example' })).status, 403);
  await contact.settled();
  assert.equal(webStore.messageList().length, 0);
  assert.equal(channel('staffChat').messageList.length, cards);
});

test('a message without sign-in and without e-mail: kept for the panel, a card on the team chat – nobody pinged', async () => {
  const cards = channel('staffChat').messageList.length;
  const logs = channel('serverLogs').messageList.length;
  const text = '  Cześć!\r\n\r\n\r\n\r\nLauncher **nie widzi** moich modów.\u0007 [kliknij](https://evil.example) @everyone <@&123456789012345678>\n# Nagłówek  ';
  const m = await written({ name: '  Kuba   z  Krakowa\u200f ', email: ' kuba@example.com ', topic: 'bug', message: text });
  assert.match(m.id, /^msg_[0-9a-f]{10}$/);
  assert.ok(Math.abs(m.at - Date.now()) < 5000);
  assert.deepEqual(
    [m.name, m.email, m.topic, m.text, m.user, m.read, m.mail],
    ['Kuba z Krakowa', 'kuba@example.com', 'bug', 'Cześć!\n\nLauncher **nie widzi** moich modów.  [kliknij](https://evil.example) @everyone <@&123456789012345678>\n# Nagłówek', null, false, 'off'],
    'trimmed, control characters turned into spaces, line breaks tidied – stored as written otherwise',
  );
  assert.equal(smtp.messages.length, 0, 'e-mail is off: nothing is sent');
  // The card: who, the topic, the text as plain text, a button to the panel – on the team chat, not in the log.
  assert.equal(channel('staffChat').messageList.length, cards + 1);
  assert.equal(channel('serverLogs').messageList.length, logs);
  const card = channel('staffChat').messageList.at(-1).body;
  const shown = textOf(card);
  assert.match(shown, /Nowa wiadomość ze strony[\s\S]*\*\*Temat:\*\* Zgłoszenie błędu[\s\S]*\*\*Od:\*\* Kuba z Krakowa · `kuba@example\.com`[\s\S]*\*\*Discord:\*\* niezalogowany/);
  assert.ok(shown.includes('> Launcher \\*\\*nie widzi\\*\\* moich modów.'), 'markdown is shown, not applied');
  assert.ok(shown.includes('\\[kliknij](https://evil.example)'), 'a link cannot hide behind other words');
  assert.ok(shown.includes('> \\# Nagłówek'));
  assert.deepEqual(card.allowedMentions, { parse: [] }, 'no mention in the card notifies anybody');
  assert.ok(json(card).includes(`${base}/admin#wiadomosci`), 'the button opens the panel on the right tab');
  // A long message is cut on the card (the panel has all of it).
  const long = await written({ message: `${'Długa wiadomość. '.repeat(110)}KONIEC` });
  assert.equal(long.text.length, 'Długa wiadomość. '.length * 110 + 6);
  const longCard = textOf(channel('staffChat').messageList.at(-1).body);
  assert.ok(longCard.includes('…') && !longCard.includes('KONIEC'));
  // No team chat on the server: the card goes to the server log instead.
  const chat = channel('staffChat');
  guild.channels.cache.delete(chat.id);
  try {
    await written({ name: 'Bez czatu' });
    assert.match(textOf(channel('serverLogs').messageList.at(-1).body), /Nowa wiadomość ze strony[\s\S]*Bez czatu/);
  } finally {
    guild.channels.cache.set(chat.id, chat);
  }
});

test('the honeypot: a script that fills the hidden field hears "sent" – and nothing happens', async () => {
  const before = [webStore.messageList().length, channel('staffChat').messageList.length];
  mailOn();
  const res = await write({ website: 'https://spam.example' });
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  // Even a form that would not pass the checks gets the same answer.
  assert.deepEqual((await write({ website: 'x', email: 'nie-adres', message: '' })).body, { ok: true });
  await contact.settled();
  assert.deepEqual([webStore.messageList().length, channel('staffChat').messageList.length], before);
  assert.equal(smtp.messages.length, 0);
  // Only a filled field counts: spaces, a missing field or another type are a normal visitor.
  await written({ website: '   ' });
  const { website: _, ...noField } = GOOD;
  assert.equal((await call('POST', '/api/shop/contact', { body: noField })).status, 200);
  await contact.settled();
  assert.equal(webStore.messageList().length, before[0] + 2);
});

test('with e-mail on: the owner gets it with Reply-To set to the visitor; a signed-in visitor\'s Discord account is attached', async () => {
  mailOn();
  smtp.messages.length = 0;
  const m = await written({ name: 'Ola', email: 'ola@example.com', topic: 'plus', message: 'Dzień dobry,\nzapłaciłam i nie mam kodu.\n.kropka' }, { who: 'member' });
  assert.deepEqual(m.user, { id: MEMBER.id, name: 'Gracz', username: 'gracz' }, 'from the session – not from anything the browser sent');
  assert.equal(m.mail, 'sent');
  assert.equal(smtp.messages.length, 1);
  const sent = smtp.messages[0];
  assert.deepEqual([sent.from, sent.to], [ADDRESS, [ADDRESS]]);
  assert.equal(sent.subject, '[Kontakt] Hammer+ i płatności – Ola');
  assert.equal(sent.headers['reply-to'], '<ola@example.com>', '"Reply" writes to the visitor');
  assert.equal(sent.headers.from, `"Hammer Launcher" <${ADDRESS}>`);
  for (const line of ['Od: Ola', 'E-mail: ola@example.com', 'Temat: Hammer+ i płatności', `Discord: Gracz (@gracz), ID ${MEMBER.id}`, 'Dzień dobry,\nzapłaciłam i nie mam kodu.\n.kropka', `Wszystkie wiadomości: ${base}/admin#wiadomosci`]) assert.ok(sent.text.includes(line), line);
  assert.match(sent.text, /Kiedy: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  assert.match(textOf(channel('staffChat').messageList.at(-1).body), new RegExp(`\\*\\*Discord:\\*\\* <@${MEMBER.id}> \\(gracz\\)`));
  // Somebody trying to pass as another account: the body's own "user" means nothing.
  const anon = await written({ user: { id: OWNER.id, name: 'Szef' }, read: true, mail: 'sent', id: 'msg_moje' });
  assert.deepEqual([anon.user, anon.read], [null, false]);
  assert.notEqual(anon.id, 'msg_moje');
  assert.ok(smtp.messages.at(-1).text.includes('Discord: niezalogowany'));
  // A name with a line break in it cannot add a header to the e-mail.
  await written({ name: 'Zły\r\nBcc: ofiara@example.com' });
  const evil = smtp.messages.at(-1);
  assert.equal(evil.subject, '[Kontakt] Pomoc z launcherem – Zły Bcc: ofiara@example.com');
  assert.ok(!/^bcc/im.test(evil.raw));
  assert.deepEqual(evil.to, [ADDRESS]);
});

test('e-mail is down or the password is wrong: the visitor still gets "sent", the message is kept and the team is told', async () => {
  mailOn('zle-haslo');
  const cards = channel('staffChat').messageList.length;
  const { warn } = console;
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  let m;
  try {
    m = await written({ name: 'Mimo wszystko' });
  } finally {
    console.warn = warn;
  }
  assert.equal(m.mail, 'failed');
  assert.match(m.mailError, /nie przyjął hasła z pliku \.env \(MAIL_PASS\)/);
  assert.equal(said.length, 1, 'the console hears the real cause');
  assert.match(said[0], /E-mail nie został wysłany/);
  assert.equal(channel('staffChat').messageList.length, cards + 1);
  // The Discord side failing does not lose the message either.
  mailOff();
  const chat = channel('staffChat');
  const { send } = chat;
  chat.send = async () => {
    throw new Error('Missing Access');
  };
  try {
    const kept = await written({ name: 'Bez Discorda' });
    assert.equal(kept.name, 'Bez Discorda');
  } finally {
    chat.send = send;
  }
});

test('limits per address: 3 messages in 10 minutes, 10 a day – said honestly; a wrong form does not count', async () => {
  const from = '10.200.0.1';
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    await write({ email: 'literówka' }, { from });
    await write({ message: 'krótka' }, { from });
    for (let i = 0; i < 3; i += 1) assert.equal((await write({}, { from })).status, 200);
    const fourth = await write({}, { from });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error, 'Za dużo wiadomości w krótkim czasie – następną możesz wysłać za 10 minut.');
    assert.equal((await write({}, { from: '10.200.0.2' })).status, 200, 'somebody else writes freely');
    // Ten minutes later it works again – as promised.
    skew += 10 * 60_000 + 1000;
    for (let sent = 3; sent < 10; sent += 1) {
      if (sent % 3 === 0 && sent > 3) skew += 10 * 60_000 + 1000;
      assert.equal((await write({}, { from })).status, 200, `message ${sent + 1}`);
    }
    skew += 10 * 60_000 + 1000;
    const eleventh = await write({}, { from });
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.error, 'To już dużo wiadomości jak na jeden dzień – następną możesz wysłać jutro. Pilna sprawa? Napisz do nas na Discordzie.');
    skew += 86_400_000;
    assert.equal((await write({}, { from })).status, 200, 'the next day');
    // Everybody together: a flood from many addresses stops at 30 an hour.
    contact._reset();
    const before = webStore.messageList().length;
    const flood = await Promise.all(Array.from({ length: 34 }, () => write({})));
    assert.equal(flood.filter((r) => r.status === 200).length, 30);
    const over = flood.find((r) => r.status === 429);
    assert.match(over.body.error, /wyjątkowo dużo wiadomości – spróbuj ponownie za godzinę/);
    await contact.settled();
    assert.equal(webStore.messageList().length, before + 30);
    // …and at 200 a day: an hour later there is room again, until the day's limit.
    for (let hour = 1; hour <= 6; hour += 1) {
      skew += 3_600_000 + 1000;
      const more = await Promise.all(Array.from({ length: 30 }, () => write({})));
      assert.equal(more.filter((r) => r.status === 200).length, hour < 6 ? 30 : 20, `hour ${hour}`);
      if (hour === 6) assert.match(more.find((r) => r.status === 429).body.error, /Dostaliśmy dziś wyjątkowo dużo wiadomości – spróbuj ponownie jutro/);
    }
    await contact.settled();
  } finally {
    Date.now = realNow;
    contact._reset();
  }
});

test('the store keeps the newest 300 – and lets go of read ones first', () => {
  const state = webStore._state();
  const kept = state.messages;
  try {
    state.messages = [];
    const first = webStore.addMessage({ name: 'pierwsza', email: 'a@b.pl', topic: 'other', text: 'x'.repeat(10) });
    const second = webStore.addMessage({ name: 'druga', email: 'a@b.pl', topic: 'other', text: 'x'.repeat(10) });
    webStore.updateMessage(second.id, { read: true });
    for (let i = 0; i < webStore.MAX_MESSAGES - 1; i += 1) webStore.addMessage({ name: `n${i}`, email: 'a@b.pl', topic: 'other', text: 'x'.repeat(10) });
    assert.equal(webStore.messageList().length, webStore.MAX_MESSAGES);
    assert.ok(webStore.getMessage(first.id), 'the oldest one is unread – it stays');
    assert.equal(webStore.getMessage(second.id), null, 'the read one made room');
    webStore.addMessage({ name: 'ostatnia', email: 'a@b.pl', topic: 'other', text: 'x'.repeat(10) });
    assert.equal(webStore.getMessage(first.id), null, 'nothing read is left: the oldest goes');
    assert.deepEqual([webStore.messageList().length, webStore.messageList()[0].name, webStore.unreadMessages()], [webStore.MAX_MESSAGES, 'ostatnia', webStore.MAX_MESSAGES]);
  } finally {
    state.messages = kept;
  }
});

test('the panel\'s „Wiadomości”: the team reads and marks, only the owner deletes and tests e-mail', async () => {
  webStore._state().messages = [];
  mailOff();
  const older = await written({ name: 'Starsza', topic: 'collab', message: 'Proponuję współpracę.' });
  const newer = await written({ name: 'Nowsza', email: 'nowsza@example.com' }, { who: 'member' });
  // Who gets in.
  assert.equal((await call('GET', '/api/admin/messages')).status, 401);
  assert.equal((await call('GET', '/api/admin/messages', { who: 'member' })).status, 403);
  assert.equal((await call('GET', '/api/admin/messages/count', { who: 'member' })).status, 403);
  const asAdmin = await call('GET', '/api/admin/messages', { who: 'admin' });
  assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
  assert.deepEqual([asAdmin.body.unread, asAdmin.body.canDelete, asAdmin.body.canTest, asAdmin.body.max], [2, false, false, 300]);
  assert.deepEqual(asAdmin.body.messages.map((m) => m.name), ['Nowsza', 'Starsza'], 'newest first');
  const row = asAdmin.body.messages[0];
  assert.deepEqual(
    [row.id, row.email, row.topic, row.topicLabel, row.text, row.user, row.read, row.readBy, row.mail],
    [newer.id, 'nowsza@example.com', 'launcher', 'Pomoc z launcherem', GOOD.message, { id: MEMBER.id, name: 'Gracz', username: 'gracz' }, false, null, 'off'],
  );
  assert.deepEqual(asAdmin.body.topics.map((t) => t.id), ['launcher', 'plus', 'bug', 'collab', 'other']);
  assert.deepEqual([asAdmin.body.mail.ready, asAdmin.body.mail.to, asAdmin.body.mail.hasPassword], [false, ADDRESS, false]);
  assert.ok(!JSON.stringify(asAdmin.body).includes(PASS));
  assert.deepEqual((await call('GET', '/api/admin/messages/count', { who: 'admin' })).body, { unread: 2, total: 2 });
  const asOwner = await admin('GET', 'messages');
  assert.deepEqual([asOwner.body.canDelete, asOwner.body.canTest], [true, true]);

  // Marking as read: the team may; who and when stays on the message. Only from the panel itself.
  assert.equal((await admin('PUT', `messages/${newer.id}`, { body: { read: true }, origin: null })).status, 403);
  assert.equal((await admin('PUT', `messages/${newer.id}`, { body: { read: true }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/messages/${newer.id}`, { who: 'member', body: { read: true } })).status, 403);
  const read = await call('PUT', `/api/admin/messages/${newer.id}`, { who: 'admin', body: { read: true } });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.item.read, read.body.item.readBy, read.body.unread], [true, { id: ADMIN.id, name: 'Adminka' }, 1]);
  assert.ok(Math.abs(read.body.item.readAt - Date.now()) < 5000);
  const unread = await call('PUT', `/api/admin/messages/${newer.id}`, { who: 'admin', body: { read: false } });
  assert.deepEqual([unread.body.item.read, unread.body.item.readBy, unread.body.unread], [false, null, 2]);
  assert.equal((await admin('PUT', 'messages/msg_nie_ma', { body: { read: true } })).status, 404);
  assert.deepEqual((await call('POST', '/api/admin/messages/read-all', { who: 'admin', body: {} })).body, { unread: 0 });
  assert.ok(webStore.messageList().every((m) => m.read && m.readBy === ADMIN.id));

  // Deleting: the owner only – written to the log with who did it, the visitor's name as plain text.
  webStore.updateMessage(older.id, { name: 'Zły [link](https://evil.example) @everyone' });
  assert.equal((await call('DELETE', `/api/admin/messages/${older.id}`, { who: 'admin' })).status, 403);
  assert.equal((await admin('DELETE', `messages/${older.id}`, { origin: null })).status, 403);
  assert.ok(webStore.getMessage(older.id));
  const gone = await admin('DELETE', `messages/${older.id}`);
  assert.deepEqual([gone.status, gone.body], [200, { ok: true, unread: 0 }]);
  assert.equal(webStore.getMessage(older.id), null);
  assert.equal((await admin('DELETE', `messages/${older.id}`)).status, 404);
  assert.match(channelText('serverLogs'), /Panel admina[\s\S]*Usunięto wiadomość ze strony od \*\*Zły linkhttpsevil\.example everyone\*\* \(Współpraca\) · <@1>/);
  assert.deepEqual((await admin('GET', 'messages')).body.messages.map((m) => m.id), [newer.id]);

  // An e-mail that never left because the bot was restarted is not "on its way" for ever.
  webStore.updateMessage(newer.id, { mail: 'pending', at: Date.now() - 6 * 60_000 });
  const stale = (await admin('GET', 'messages')).body.messages[0];
  assert.deepEqual([stale.mail, stale.mailError], ['failed', 'Bot został uruchomiony ponownie, zanim e-mail wyszedł.']);
});

test('„Wyślij testowy e-mail”: the owner sees the real result – sent, no password, a wrong password, a closed port', async () => {
  const test = (opts = {}) => admin('POST', 'messages/test', { body: {}, ...opts });
  assert.equal((await test({ who: 'admin' })).status, 403);
  assert.equal((await test({ who: 'member' })).status, 403);
  assert.equal((await test({ origin: null })).status, 403);
  // Not set up: says what is missing.
  const off = await test();
  assert.deepEqual([off.status, off.body.ok, off.body.to], [200, false, ADDRESS]);
  assert.match(off.body.reason, /brakuje linii MAIL_PASS/);
  // Set up: the message arrives.
  mailOn();
  smtp.messages.length = 0;
  const ok = await test();
  assert.deepEqual(ok.body, { ok: true, to: ADDRESS, reason: null });
  assert.equal(smtp.messages.length, 1);
  assert.equal(smtp.messages[0].subject, 'Test – e-mail ze strony Hammer Launcher działa');
  assert.match(smtp.messages[0].text, /To jest testowa wiadomość wysłana z panelu admina/);
  assert.equal((await admin('GET', 'messages')).body.mail.last.ok, true);
  assert.match(channelText('serverLogs'), /Testowy e-mail wysłany z panelu · <@1>/);
  // A wrong password, then a port nothing answers on: the cause is in the answer and stays on the status line.
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    mailOn('zwykle-haslo');
    const wrong = await test();
    assert.deepEqual([wrong.status, wrong.body.ok], [200, false]);
    assert.match(wrong.body.reason, /nie przyjął hasła z pliku \.env \(MAIL_PASS\)[\s\S]*hasło do aplikacji/);
    assert.ok(!wrong.body.reason.includes('zwykle-haslo'));
    const status = (await admin('GET', 'messages')).body.mail;
    assert.deepEqual([status.ready, status.last.ok], [true, false]);
    assert.equal(status.last.reason, wrong.body.reason);
    mailOn();
    env.mail.port = 9; // nothing listens there
    mail._test({ plain: true, connectMs: 500 });
    const blocked = await test();
    assert.equal(blocked.body.ok, false);
    assert.match(blocked.body.reason, /Nie udało się połączyć z serwerem poczty[\s\S]*hosting blokuje wysyłanie poczty/);
  } finally {
    Object.assign(console, { warn, log });
  }
  // No more than a few tries a minute from one place.
  mailOff();
  const from = '10.201.0.1';
  for (let i = 0; i < 5; i += 1) assert.equal((await test({ from })).status, 200);
  assert.equal((await test({ from })).status, 429);
});

async function buyPlus(plan, nick, who = 'buyer') {
  const res = await call('POST', '/api/shop/checkout', { who, body: { kind: 'plus', plan, nick, requestId: crypto.randomUUID() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sessionId = res.body.url.split('/').pop();
  fakes.pay(sessionId);
  const verified = await call('POST', '/api/shop/verify', { who, body: { sessionId } });
  return { ...verified, orderId: res.body.order };
}

test('a Hammer+ purchase is e-mailed to the owner: the order, the account, the amount, who and when – and the code', async () => {
  webStore.setPlusPlans([{ id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1499 }, { id: 'px', name: 'Hammer+ na zawsze', days: 0, price: 7999 }]);
  // E-mail off: a purchase is a purchase, nothing is sent anywhere.
  smtp.messages.length = 0;
  const quiet = await buyPlus('p30', 'Notch');
  assert.deepEqual([quiet.status, quiet.body.paid], [200, true]);
  assert.equal(website.purchaseMail(webStore.getOrder(quiet.orderId)), null);
  assert.equal(smtp.messages.length, 0);

  mailOn();
  const arriving = smtp.next();
  const paid = await buyPlus('p30', 'steve');
  assert.deepEqual([paid.status, paid.body.paid], [200, true]);
  const sent = await arriving;
  const order = webStore.getOrder(paid.orderId);
  assert.equal(sent.subject, '[Zakup] Hammer+ 30 dni – Steve – 14,99 PLN');
  assert.deepEqual([sent.from, sent.to, sent.headers['reply-to']], [ADDRESS, [ADDRESS], undefined]);
  for (const line of [`Zamówienie: ${order.id}`, 'Co: Hammer+ na 30 dni – Steve', 'Konto Minecraft: Steve', 'Kupiony czas: 30 dni', 'Kwota: 14,99 PLN (płatność online na stronie)', `Kupujący: Kupiec (@kupiec) · Discord ID ${BUYER.id}`, 'Kod: wystawiony', `Panel admina: ${base}/admin#zamowienia`]) {
    assert.ok(sent.text.includes(line), `${line}\n---\n${sent.text}`);
  }
  assert.match(sent.text, /Kiedy: \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  assert.match(sent.text, /Hammer\+ na tym koncie: do \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  // The owner asked for the code too („z kluczem”) – the same code as on the page and in the DM.
  const mine = (await call('GET', '/api/shop/orders', { who: 'buyer' })).body.orders.find((o) => o.id === order.id);
  assert.ok(sent.text.includes(`Kod Hammer+ (gdyby kupujący napisał, że go nie ma):\n${mine.plus.code}`), sent.text);
  assert.equal(plus.verify(mine.plus.code).mc, MC.Steve);
  assert.ok(sent.text.includes('E-mail kupującego: brak – Stripe go nie podał'), 'this payment came without an address');
  // Forever, and an amount with a different price.
  const next = smtp.next();
  await buyPlus('px', 'Steve');
  const forever = await next;
  assert.equal(forever.subject, '[Zakup] Hammer+ na zawsze – Steve – 79,99 PLN');
  assert.ok(forever.text.includes('Kupiony czas: na zawsze') && forever.text.includes('Hammer+ na tym koncie: na zawsze'));
  // A shop order (products, a ticket on Discord) reads the same way.
  const shop = { id: 'HS-TEST000001', kind: 'products', status: 'paid', userId: BUYER.id, amount: 4550, currency: 'eur', paidAt: Date.now(), items: [{ name: 'Gra A', quantity: 2, price: 1500 }, { name: 'Bot B', quantity: 1, price: 1550 }], ticketNumber: '0007', ticketUrl: 'https://discord.com/channels/1/2' };
  assert.deepEqual(await website.purchaseMail(shop), { ok: true });
  const products = smtp.messages.at(-1);
  assert.equal(products.subject, '[Zakup] 2 produkty – 45,50 EUR');
  for (const line of ['Zamówienie: HS-TEST000001', 'Co: 2× Gra A\n    1× Bot B', 'Kwota: 45,50 EUR (płatność online na stronie)', 'Ticket: #0007 – https://discord.com/channels/1/2']) assert.ok(products.text.includes(line), `${line}\n---\n${products.text}`);
  assert.equal(website.purchaseMail({ ...shop, status: 'pending' }), null, 'only a paid order');
});

test('mail being down never touches a purchase: paid, the code issued, the buyer told – and the owner still reads it on Discord', async () => {
  webStore.setPlusPlans([{ id: 'p30', name: 'Hammer+ na 30 dni', days: 30, price: 1499 }]);
  mailOn('zle-haslo');
  const { warn } = console;
  console.warn = () => {};
  try {
    const sessions = smtp.sessions.length;
    const paid = await buyPlus('p30', 'Notch');
    assert.deepEqual([paid.status, paid.body.paid], [200, true]);
    const order = webStore.getOrder(paid.orderId);
    assert.deepEqual([order.status, order.delivered, Boolean(order.plus.grantedAt)], ['paid', true, true]);
    const mine = (await call('GET', '/api/shop/orders', { who: 'buyer' })).body.orders.find((o) => o.id === paid.orderId);
    assert.equal(plus.verify(mine.plus.code).mc, MC.Notch);
    assert.match(channelText('serverLogs'), /Hammer\+ kupiony na stronie/);
    assert.equal((await website.purchaseMail(order)).ok, false, 'the e-mail itself resolves with the reason – it does not throw');
    assert.ok(smtp.sessions.length > sessions, 'it was tried');
    // A slow mail server: the buyer has the answer before the e-mail is even on its way – and it still arrives.
    mailOn();
    smtp.behave = { greetDelay: 2000 };
    let arrived = false;
    const slow = smtp.next(8000).then((m) => {
      arrived = true;
      return m;
    });
    const fast = await buyPlus('p30', 'Notch');
    assert.equal(fast.body.paid, true);
    assert.equal(arrived, false, 'nobody waited for the mail server');
    assert.match((await slow).subject, /^\[Zakup\] Hammer\+ 30 dni – Notch/);
    // A paid order the bot could not finish (the code could not be signed): the owner is told what to do.
    smtp.behave = {};
    const pending = webStore.createOrder({ userId: BUYER.id, kind: 'plus', items: [{ id: 'plus:p30', name: 'Hammer+ na 30 dni – Steve', price: 1499, quantity: 1 }], amount: 1499, currency: 'pln', requestId: 'r-brak-kodu', plus: { plan: 'p30', days: 30, mc: MC.Steve, nick: 'Steve' } });
    webStore.markPaid(pending.id);
    const { grantKnown } = hammerplus;
    hammerplus.grantKnown = () => {
      throw new Error('brak klucza');
    };
    const arriving = smtp.next();
    try {
      await website.onPaid(webStore.getOrder(pending.id));
    } finally {
      hammerplus.grantKnown = grantKnown;
    }
    const alarm = await arriving;
    assert.ok(alarm.text.includes('Kod: NIE ZOSTAŁ WYSTAWIONY – wystaw go ręcznie na Discordzie: /hammerplus nadaj nick:Steve dni:30'), alarm.text);
  } finally {
    console.warn = warn;
  }
});

test('a claimed referral reward is e-mailed too – without the code', async () => {
  mailOn();
  webStore.addReferralDays(MEMBER.id, 7, { earned: true, balance: true });
  const arriving = smtp.next();
  const claimed = await call('POST', '/api/shop/referrals/claim', { who: 'member', body: { nick: 'notch' } });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const sent = await arriving;
  assert.equal(sent.subject, '[Polecenia] Odebrano 7 dni Hammer+ – Notch');
  for (const line of ['Konto Minecraft: Notch', 'Odebrane dni: 7', `Kto: Gracz (@gracz) · Discord ID ${MEMBER.id}`]) assert.ok(sent.text.includes(line), line);
  assert.doesNotMatch(sent.text, /HP1\./);
  assert.match(claimed.body.code, /^HP1\./);
});
