'use strict';

// E-mail from the website (src/lib/mail.js): the SMTP client against a local fake server – signing in, the message on
// the wire, the other port when one is closed, and every way it can fail. Nothing here reaches a real mail server.
process.env.HS_TEST_PROFILE = 'launcher'; // the profile that has a contact address (config.launcher.json)

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const { env, mailSettings } = require('../src/env');
const config = require('../src/lib/config');
const mail = require('../src/lib/mail');
const { startSmtp, closedPort, decodeWords } = require('./helpers/fakeSmtp');

const ADDRESS = 'hammerlauncherclient@gmail.com';
const PASS = 'abcdefghijklmnop';
let smtp;

/** What the console was told while fn ran (and nothing of it in the test output). */
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
const send = async (message) => (await quietly(() => mail.send(message))).result;
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** .env as the owner has it: only the password – everything else comes from config.launcher.json and the defaults. */
function configure(server = smtp, extra = {}) {
  Object.assign(env.mail, { pass: PASS, user: '', to: '', host: '127.0.0.1', port: server.port });
  mail._test({ plain: true, ...extra });
}

test.before(async () => {
  smtp = await startSmtp({ user: ADDRESS, pass: PASS });
});
test.after(() => smtp?.close());
test.beforeEach(() => {
  smtp.behave = {};
  configure();
});

test('ready: the contact address from the config and MAIL_PASS – that one line is all the owner adds', async () => {
  assert.equal(config.contact.email, ADDRESS, 'the launcher profile has the contact address');
  assert.equal(mail.ready(), true);
  assert.deepEqual([mail.status().to, mail.status().from], [ADDRESS, ADDRESS]);
  assert.ok(!JSON.stringify(mail.status()).includes(PASS), 'the status never has the password');
  env.mail.pass = '';
  assert.equal(mail.ready(), false);
  const before = smtp.sessions.length;
  const off = await mail.send({ subject: 'x', text: 'y' });
  assert.deepEqual([off.ok, off.code], [false, 'off']);
  assert.match(off.reason, /brakuje linii MAIL_PASS/);
  assert.equal(smtp.sessions.length, before, 'nothing is even tried');
  // A site without a contact address (the shop): a password alone is not enough – MAIL_USER and MAIL_TO are.
  env.mail.pass = PASS;
  config.contact.email = '';
  try {
    assert.equal(mail.ready(), false);
    assert.match((await mail.send({ subject: 'x', text: 'y' })).reason, /brakuje adresu/);
    Object.assign(env.mail, { user: 'sklep@example.com', to: 'szef@example.com' });
    assert.equal(mail.ready(), true);
    assert.deepEqual([mail.status().from, mail.status().to], ['sklep@example.com', 'szef@example.com']);
  } finally {
    config.contact.email = ADDRESS;
  }
  // Defaults: Gmail's server, port 465 – and an app password pasted the way Google shows it, in four groups.
  const parsed = mailSettings({ MAIL_PASS: ' abcd efgh ijkl mnop ' });
  assert.deepEqual(parsed, { pass: 'abcdefghijklmnop', user: '', to: '', host: '', port: null });
  assert.equal(mailSettings({ MAIL_PASS: 'moje haslo ze spacjami' }).pass, 'moje haslo ze spacjami', 'any other password is left as it is');
  assert.deepEqual(mailSettings({ MAIL_USER: 'a@b.pl', MAIL_TO: 'c@d.pl', MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587' }), { pass: '', user: 'a@b.pl', to: 'c@d.pl', host: 'smtp.example.com', port: 587 });
  Object.assign(env.mail, parsed);
  const status = mail.status();
  assert.deepEqual([status.ready, status.host, status.port, status.to, status.from], [true, 'smtp.gmail.com', 465, ADDRESS, ADDRESS]);
});

test('a message on the wire: sign-in, envelope, headers, UTF-8 subject, base64 body – and the connection is closed', async () => {
  const text = 'Cześć!\r\n.linia zaczyna się od kropki\n\nZażółć gęślą jaźń 😀\n..\n.';
  const subject = '[Kontakt] Zgłoszenie błędu – Zażółć gęślą jaźń, czyli bardzo długi temat wiadomości z polskimi znakami 😀';
  assert.deepEqual(await mail.send({ subject, text, replyTo: 'kuba@example.com' }), { ok: true });
  const m = smtp.messages.at(-1);
  const session = smtp.sessions.at(-1);
  assert.match(session.commands[0], /^EHLO \S+$/);
  assert.deepEqual(session.commands.slice(1), ['AUTH PLAIN', `MAIL FROM:<${ADDRESS}>`, `RCPT TO:<${ADDRESS}>`, 'DATA', 'QUIT']);
  assert.deepEqual([m.from, m.to], [ADDRESS, [ADDRESS]]);
  assert.equal(m.headers.from, `"Hammer Launcher" <${ADDRESS}>`, 'the brand name from the config');
  assert.equal(m.headers.to, `<${ADDRESS}>`);
  assert.equal(m.headers['reply-to'], '<kuba@example.com>');
  assert.match(m.headers.date, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.ok(Math.abs(new Date(m.headers.date).getTime() - Date.now()) < 60_000);
  assert.match(m.headers['message-id'], /^<[0-9a-f]{24}\.\d+@gmail\.com>$/);
  assert.equal(m.headers['mime-version'], '1.0');
  assert.equal(m.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(m.headers['content-transfer-encoding'], 'base64');
  // The subject: RFC 2047 words, every line within 76 characters, the text intact.
  assert.equal(m.subject, subject);
  const subjectLines = m.headerLines.slice(m.headerLines.findIndex((l) => l.startsWith('Subject:')), m.headerLines.findIndex((l) => l.startsWith('Date:')));
  assert.ok(subjectLines.length > 1, 'a long subject is folded');
  for (const line of subjectLines) {
    assert.ok(line.length <= 76, line);
    assert.match(line, /^(Subject: | )=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  }
  assert.ok(!/[^\x20-\x7e\r\n]/.test(m.raw), 'nothing but plain ASCII goes over the wire');
  // The body: base64 in lines of at most 76 characters; the text comes out as it went in (line ends as CRLF on the way).
  assert.ok(m.bodyLines.length > 1 && m.bodyLines.every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)));
  assert.equal(m.text, text.replace(/\r\n/g, '\n'));
  await tick();
  assert.equal(session.closed, true);
  // A short ASCII subject stays readable; a brand with Polish letters becomes encoded words too.
  const brand = config.brand.name;
  config.brand.name = 'Młot "Launcher"';
  try {
    await mail.send({ subject: 'Test 1', text: 'ok' });
  } finally {
    config.brand.name = brand;
  }
  const plain = smtp.messages.at(-1);
  assert.ok(plain.headerLines.includes('Subject: Test 1'));
  assert.equal(decodeWords(plain.headers.from), `Młot "Launcher" <${ADDRESS}>`);
  assert.equal(plain.headers['reply-to'], undefined);
});

test('dot-stuffing: a line that starts with a dot cannot end the message early', () => {
  assert.equal(mail.dotStuff('.a\r\nb\r\n.\r\n..c\r\nd.\r\n'), '..a\r\nb\r\n..\r\n...c\r\nd.\r\n');
  const raw = mail.compose({ from: ADDRESS, fromName: 'X', to: ADDRESS, subject: 's', text: '.\n.\n' });
  assert.ok(!mail.dotStuff(raw).split('\r\n').includes('.'), 'no line of a composed message is a lone dot');
});

test('nothing a visitor typed becomes a header: line breaks in the subject, the reply address, the recipient', async () => {
  const evil = 'Temat\r\nBcc: ofiara@example.com\r\n\r\nTreść od atakującego';
  assert.equal((await mail.send({ subject: evil, text: 'x', replyTo: 'kuba@example.com\r\nBcc: ofiara@example.com' })).ok, true);
  const m = smtp.messages.at(-1);
  assert.deepEqual(Object.keys(m.headers), ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding'], 'the usual headers and no other – the broken reply address is left out');
  assert.equal(m.headerLines.filter((l) => !l.startsWith(' ')).length, 8, 'eight header lines (the subject folds onto lines that start with a space)');
  assert.ok(!/^bcc/im.test(m.raw));
  assert.equal(m.subject, 'Temat Bcc: ofiara@example.com Treść od atakującego', 'one line');
  assert.equal(m.text, 'x');
  assert.deepEqual(m.to, [ADDRESS]);
  for (const replyTo of ['a@b.pl>\r\nRCPT TO:<x@y.pl', 'Kuba <kuba@example.com>', 'kuba@example.com, inny@example.com', 'kuba@localhost', 'kuba example.com', 42, null, { a: 1 }]) {
    await mail.send({ subject: 's', text: 't', replyTo });
    assert.equal(smtp.messages.at(-1).headers['reply-to'], undefined, String(replyTo));
  }
  // A recipient that is not one plain address is refused before any connection.
  const sessions = smtp.sessions.length;
  for (const to of ['ofiara@example.com>\r\nRCPT TO:<druga@example.com', 'a@b.pl, c@d.pl', '']) {
    const res = await mail.send({ subject: 's', text: 't', to });
    assert.deepEqual([res.ok, res.code], [false, 'address'], to);
  }
  assert.equal(smtp.sessions.length, sessions);
  assert.equal((await mail.send({ subject: 's', text: 't', to: 'ktos@example.com' })).ok, true);
  assert.deepEqual([smtp.messages.at(-1).to, smtp.messages.at(-1).headers.to], [['ktos@example.com'], '<ktos@example.com>']);
});

test('a server that does not take AUTH PLAIN is signed in to with AUTH LOGIN', async () => {
  smtp.behave.noPlain = true;
  assert.equal((await mail.send({ subject: 'login', text: 'x' })).ok, true);
  assert.deepEqual(smtp.sessions.at(-1).commands.slice(1, 4), ['AUTH LOGIN', '<user>', '<pass>']);
  assert.equal(smtp.messages.at(-1).subject, 'login');
});

test('a wrong password: said plainly, once – and send() resolves, never throws', async () => {
  env.mail.pass = 'zwykle-haslo-do-gmaila';
  const first = await quietly(() => mail.send({ subject: 'x', text: 'y' }));
  assert.deepEqual([first.result.ok, first.result.code], [false, 'auth']);
  assert.match(first.result.reason, /nie przyjął hasła z pliku \.env \(MAIL_PASS\)/);
  assert.match(first.result.reason, /hasło do aplikacji/);
  assert.match(first.result.reason, /535 5\.7\.8 Username and Password not accepted/, 'the server\'s own answer is there');
  assert.ok(!first.result.reason.includes('zwykle-haslo'), 'the password is never repeated');
  assert.equal(first.said.length, 1);
  assert.match(first.said[0], /E-mail nie został wysłany/);
  assert.ok(!first.said[0].includes('zwykle-haslo'));
  assert.deepEqual(smtp.sessions.at(-1).commands.slice(1), ['AUTH PLAIN'], 'refused: no second guess with another method, nothing sent');
  // The same cause again: the console is not told twice. The panel can still read it.
  const again = await quietly(() => mail.send({ subject: 'x', text: 'y' }));
  assert.equal(again.result.ok, false);
  assert.deepEqual(again.said, []);
  assert.equal(mail.status().last.ok, false);
  assert.match(mail.status().last.reason, /MAIL_PASS/);
  // Fixed: one line that it works again.
  env.mail.pass = PASS;
  const fixed = await quietly(() => mail.send({ subject: 'x', text: 'y' }));
  assert.equal(fixed.result.ok, true);
  assert.equal(fixed.said.length, 1);
  assert.match(fixed.said[0], /znowu działa/);
  assert.equal(mail.status().last.ok, true);
  // Whatever it is given, it answers – it does not throw.
  for (const junk of [undefined, null, {}, { subject: 5, text: { a: 1 } }, { subject: null, text: undefined, replyTo: [] }]) {
    const res = await send(junk);
    assert.equal(typeof res.ok, 'boolean');
  }
});

test('the configured port is closed: the other one is tried once, then remembered', async () => {
  const dead = await closedPort();
  env.mail.port = dead;
  mail._test({ plain: true, other: { [dead]: smtp.port } });
  const first = await quietly(() => mail.send({ subject: 'przez drugi port', text: 'x' }));
  assert.deepEqual(first.result, { ok: true });
  assert.equal(smtp.messages.at(-1).subject, 'przez drugi port');
  assert.equal(first.said.length, 1);
  assert.match(first.said[0], new RegExp(`port ${dead} serwera 127\\.0\\.0\\.1 nie odpowiada – wysyłam przez port ${smtp.port}`));
  assert.equal(mail.status().port, smtp.port, 'the panel shows the port that works');
  const second = await quietly(() => mail.send({ subject: 'od razu', text: 'x' }));
  assert.equal(second.result.ok, true);
  assert.deepEqual(second.said, [], 'the working port is used straight away – nothing to say');
  // Without the fake's own port numbers: 465 pairs with 587 and the other way round, any other port has no second try.
  mail._test({ plain: true, connectMs: 200 });
  const alone = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([alone.ok, alone.code], [false, 'connect']);
  assert.match(alone.reason, new RegExp(`\\(port ${dead}: połączenie odrzucone\\)`));
});

test('both ports closed: one clear sentence about the hosting – and a purchase would not have noticed', async () => {
  const [a, b] = [await closedPort(), await closedPort()];
  env.mail.port = a;
  mail._test({ plain: true, other: { [a]: b } });
  const res = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([res.ok, res.code], [false, 'connect']);
  assert.match(res.reason, new RegExp(`Nie udało się połączyć z serwerem poczty 127\\.0\\.0\\.1 \\(porty ${a} i ${b}: połączenie odrzucone\\)`));
  assert.match(res.reason, /hosting blokuje wysyłanie poczty/);
  // The second port answers but says no: that answer is the cause, not "cannot connect".
  env.mail.pass = 'zle';
  mail._test({ plain: true, other: { [a]: smtp.port } });
  assert.equal((await send({ subject: 'x', text: 'y' })).code, 'auth');
});

test('a server that says nothing, stops half-way or refuses the message: a reason every time, the socket closed', async () => {
  mail._test({ plain: true, connectMs: 150, replyMs: 150 });
  const sessions = smtp.sessions.length;
  smtp.behave = { silent: true }; // accepts the connection and never greets – a firewall that swallows everything
  const silent = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([silent.ok, silent.code], [false, 'timeout']);
  assert.match(silent.reason, /Nie udało się połączyć z serwerem poczty .*brak odpowiedzi/);
  smtp.behave = { hangAfterHello: true };
  const hung = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([hung.ok, hung.code], [false, 'timeout']);
  assert.match(hung.reason, /przerwane w trakcie wysyłania \(brak odpowiedzi/);
  smtp.behave = { rejectRcpt: true };
  const noSuch = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([noSuch.ok, noSuch.code], [false, 'rejected']);
  assert.match(noSuch.reason, /nie przyjął wiadomości\. Odpowiedź serwera: 550 5\.1\.1/);
  smtp.behave = { rejectData: true };
  const refused = await send({ subject: 'x', text: 'y' });
  assert.deepEqual([refused.ok, refused.code], [false, 'rejected']);
  assert.match(refused.reason, /554 5\.7\.0 Message refused/);
  // A host that does not exist: no second port, a hint about MAIL_HOST. (No network: the name cannot be looked up.)
  env.mail.host = 'smtp.nie-ma-takiego-serwera.invalid';
  const lost = await send({ subject: 'x', text: 'y' });
  assert.equal(lost.ok, false);
  assert.ok(['dns', 'connect', 'timeout'].includes(lost.code), lost.code);
  await tick(100);
  assert.equal(smtp.sessions.length, sessions + 4);
  assert.ok(smtp.sessions.slice(sessions).every((s) => s.closed), 'every connection was closed by the client');
});

test('real TLS: port 465 style (TLS from the first byte) and STARTTLS – the certificate is checked, the password never goes out in the clear', async () => {
  const implicit = await startSmtp({ user: ADDRESS, pass: PASS, implicit: true });
  const upgrade = await startSmtp({ user: ADDRESS, pass: PASS, starttls: true });
  try {
    const modes = { [implicit.port]: 'tls', [upgrade.port]: 'starttls', [smtp.port]: 'starttls' };
    // Each server has its own throwaway certificate; the client is told to trust exactly these two.
    configure(implicit, { plain: false, modes, ca: [implicit.cert, upgrade.cert] });
    assert.deepEqual(await mail.send({ subject: 'TLS od pierwszego bajtu', text: 'żółw' }), { ok: true });
    assert.deepEqual([implicit.messages[0].subject, implicit.messages[0].text, implicit.sessions[0].secure], ['TLS od pierwszego bajtu', 'żółw', true]);

    env.mail.port = upgrade.port;
    assert.deepEqual(await mail.send({ subject: 'STARTTLS', text: 'żółw' }), { ok: true });
    assert.deepEqual(upgrade.sessions[0].commands.slice(0, 4).map((c) => c.split(' ')[0]), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH'], 'hello, encryption, hello again, only then the password');
    assert.equal(upgrade.messages[0].subject, 'STARTTLS');

    // A certificate nobody vouches for: refused, and nothing after the handshake is said.
    mail._test({ modes });
    const untrusted = await send({ subject: 'x', text: 'y' });
    assert.deepEqual([untrusted.ok, untrusted.code], [false, 'tls']);
    assert.match(untrusted.reason, /Nie udało się nawiązać szyfrowanego połączenia/);
    assert.deepEqual(upgrade.sessions.at(-1).commands.map((c) => c.split(' ')[0]), ['EHLO', 'STARTTLS']);
    env.mail.port = implicit.port;
    assert.equal((await send({ subject: 'x', text: 'y' })).code, 'tls');
    assert.equal(implicit.messages.length, 1);

    // A port that should offer STARTTLS and does not: no sign-in at all.
    env.mail.port = smtp.port;
    const before = smtp.sessions.length;
    const bare = await send({ subject: 'x', text: 'y' });
    assert.deepEqual([bare.ok, bare.code], [false, 'tls']);
    assert.match(bare.reason, /nie oferuje szyfrowania \(STARTTLS\)/);
    assert.ok(smtp.sessions.slice(before).every((s) => !s.commands.some((c) => c.startsWith('AUTH'))), 'the password stayed here');
  } finally {
    implicit.close();
    upgrade.close();
  }
});

test('a picture inside the HTML (the server icon): multipart/related next to the plain text, Content-ID, base64 – and nothing odd gets into the headers', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const raw = mail.compose({
    from: ADDRESS, fromName: 'Hammer Launcher', to: ADDRESS, subject: 'Dziękujemy za zakup', text: 'Tekst', html: '<p><img src="cid:logo"> Treść</p>',
    inline: [{ cid: 'logo', type: 'image/png', data: png, name: 'logo.png' }, { cid: 'zły\r\nBcc: ktoś@x.pl', type: 'image/png', data: png }, { cid: 'x', type: 'text/html', data: png }],
  });
  const head = raw.split('\r\n\r\n')[0];
  assert.match(head, /^Content-Type: multipart\/alternative; boundary="(=_hs_[0-9a-f]+)"$/m);
  assert.match(raw, /Content-Type: multipart\/related; boundary="=_hs_[0-9a-f]+"/);
  assert.match(raw, /Content-Type: image\/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <logo>\r\nContent-Disposition: inline; filename="logo\.png"\r\n\r\niVBORw0KGgo/);
  assert.equal((raw.match(/Content-ID:/g) ?? []).length, 1, 'only the valid picture goes in');
  assert.doesNotMatch(raw, /Bcc:/);
  // The plain text still comes first; without pictures the message is as before.
  assert.ok(raw.indexOf('text/plain') < raw.indexOf('multipart/related'));
  assert.doesNotMatch(mail.compose({ from: ADDRESS, to: ADDRESS, subject: 's', text: 't', html: '<p>h</p>' }), /multipart\/related/);
});
