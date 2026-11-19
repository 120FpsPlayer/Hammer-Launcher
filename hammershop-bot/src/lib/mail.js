'use strict';

/**
 * E-mail from the website – a small SMTP client with no dependencies (node:net / node:tls). The site writes to its own
 * contact address (config.json → contact.email) when somebody sends the contact form or buys something, and to the
 * buyer – the address they typed on Stripe's page – with their confirmation (src/web/contact.js,
 * src/features/website.js; plain text, or text + HTML).
 *
 * .env (src/env.js → env.mail):
 *   MAIL_PASS   the password – for Gmail an "app password" (Google account → 2-step verification → App passwords).
 *               The only line that has to be added.
 *   MAIL_USER   the account that sends       (default: contact.email)
 *   MAIL_TO     where the messages go        (default: contact.email)
 *   MAIL_HOST   the SMTP server              (default: smtp.gmail.com)
 *   MAIL_PORT   465 – TLS from the first byte; anything else – STARTTLS (default: 465). When the port cannot be
 *               reached (hosting panels often block one of the two), the other of 465 / 587 is tried once and then
 *               remembered.
 *
 * send() never throws and never rejects – a purchase or a contact message must not fail because mail is down. It
 * resolves { ok: true } or { ok: false, code, reason }: reason is a Polish sentence with the real cause (the admin
 * panel's „Wyślij testowy e-mail” shows it as is), written to the console once per cause. The password is sent only
 * over TLS and is never logged. A failure that is only for now – an SMTP "4xx, try again later" (Gmail says so when
 * many messages go out at once), a dropped or silent connection – is tried twice more, after RETRY_MS: the buyer's
 * confirmation with the code is not lost to a busy minute.
 */

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const { env } = require('../env');
const config = require('./config');

const DEFAULT_HOST = 'smtp.gmail.com';
const DEFAULT_PORT = 465;
const CONNECT_MS = 10_000; // to the server's greeting
const REPLY_MS = 20_000; // each answer after that
const SUBJECT_MAX = 200;
const RETRY_MS = [15_000, 45_000]; // the waits before the 2nd and the 3rd try – all within the 5 minutes an order's e-mail may stay "on its way"
/** A deliberately plain address: nothing in it can end a header, an SMTP command or a mailto: link. */
const ADDRESS = /^[A-Za-z0-9._+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const isAddress = (value) => typeof value === 'string' && value.length <= 254 && ADDRESS.test(value);

/** A value on its way into a header: line breaks and control characters become spaces – nobody adds a header of their own. */
const oneLine = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);

// Tests only (never set from .env): { plain: true } talks to a local fake without TLS; { modes: { port: 'tls' |
// 'starttls' }, other: { port: port }, ca } puts real TLS on the fake's ports; connectMs / replyMs shorten the waits;
// retryMs: the waits before trying again (under _test there are no second tries unless it is given).
let test = {};
let testing = false;
const modeOf = (port) => (test.plain ? 'plain' : test.modes?.[port] ?? (port === 465 ? 'tls' : 'starttls'));
const otherPort = (port) => test.other?.[port] ?? { 465: 587, 587: 465 }[port] ?? null;

/** What is in force: .env first, then the contact address from config.json, Gmail's server and port 465. */
function settings() {
  const m = env.mail ?? {};
  const contact = oneLine(config.contact?.email);
  const user = m.user || contact;
  return {
    host: m.host || DEFAULT_HOST,
    port: Number(m.port) || DEFAULT_PORT,
    user,
    pass: m.pass || '',
    to: m.to || contact,
    from: isAddress(user) ? user : contact, // a login that is not an address (some mail services) still sends from the contact address
  };
}

/** An address to send from and to, and the password. */
function ready() {
  const s = settings();
  return Boolean(s.pass && s.user && isAddress(s.from) && isAddress(s.to));
}

// ───────────── The message ─────────────
/** RFC 2047 "encoded words" for a header that has more than plain ASCII; `used` – characters already on its first line. */
function encodedWords(value, used) {
  const words = [];
  let chunk = '';
  let room = Math.floor((76 - used - 12) / 4) * 3; // bytes that fit one encoded word on a 76-character line
  for (const ch of value) {
    if (chunk && Buffer.byteLength(chunk + ch) > room) {
      words.push(chunk);
      chunk = '';
      room = 45; // the following lines: a space and a whole word
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
const ascii = (value) => /^[\x20-\x7e]*$/.test(value) && !value.includes('=?');
const headerText = (name, value) => `${name}: ${ascii(value) ? value : encodedWords(value, name.length + 2)}`;
/** The name in front of an address: "Hammer Launcher" <…> */
const displayName = (name, used) => (ascii(name) ? `"${name.replace(/[\\"]/g, '\\$&')}"` : encodedWords(name, used));

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');
/** "Tue, 17 Nov 2026 08:41:05 +0000" */
const rfcDate = (d) => `${DAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;

/**
 * The whole message as it goes on the wire (CRLF lines, before dot-stuffing): UTF-8 subject, a plain-text body in
 * base64. Whatever a visitor typed is either an address that passed isAddress (Reply-To) or goes through oneLine /
 * base64 – it cannot start a header of its own.
 *
 * With html the body is multipart/alternative: the plain text first, then the HTML (mail apps show the last part they
 * can display, so Gmail shows the HTML and anything simpler the text). Both parts are base64, and the boundary has a
 * "_" in it – a character base64 never makes – so nothing in either part can end a part or the message early.
 */
const lines = (value) => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  .replace(/\n/g, '\r\n');
const base64Lines = (value) => (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/**
 * Pictures inside the HTML (the logo at the top): [{ cid, type, data: Buffer, name }] → shown with <img src="cid:…">.
 * Only plain names and image types – nothing from outside goes into these headers.
 */
const inlineOk = (img) => img && /^[A-Za-z0-9._-]{1,60}$/.test(img.cid ?? '') && /^image\/(png|jpeg|gif)$/.test(img.type ?? '') && Buffer.isBuffer(img.data) && img.data.length <= 512 * 1024;

function compose({ from, fromName, to, replyTo, subject, text, html = null, inline = [], date = new Date() }) {
  const name = oneLine(fromName, 100);
  const body = lines(text);
  const headers = [
    `From: ${name ? `${displayName(name, 6)} ` : ''}<${from}>`,
    `To: <${to}>`,
    isAddress(replyTo) ? `Reply-To: <${replyTo}>` : null,
    headerText('Subject', oneLine(subject, SUBJECT_MAX) || '(bez tematu)'),
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}.${date.getTime()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  if (html == null || String(html).trim() === '') {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${base64Lines(body)}\r\n`;
  }
  const boundary = `=_hs_${crypto.randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type, content, b = boundary) => [`--${b}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(content)].join('\r\n');
  const images = (inline ?? []).filter(inlineOk);
  // With pictures the HTML and its pictures travel together (multipart/related) as the second alternative.
  let rich = part('text/html', lines(html));
  if (images.length) {
    const related = `=_hs_${crypto.randomBytes(12).toString('hex')}`;
    const picture = (img) =>
      [`--${related}`, `Content-Type: ${img.type}`, 'Content-Transfer-Encoding: base64', `Content-ID: <${img.cid}>`, `Content-Disposition: inline; filename="${String(img.name || img.cid).replace(/[^A-Za-z0-9._-]/g, '')}"`, '', (img.data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')].join('\r\n');
    rich = [`--${boundary}`, `Content-Type: multipart/related; boundary="${related}"`, '', part('text/html', lines(html), related), ...images.map(picture), `--${related}--`].join('\r\n');
  }
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', body)}\r\n${rich}\r\n--${boundary}--\r\n`;
}

/** SMTP's "a line with only a dot ends the message": a line that starts with a dot gets one more. */
const dotStuff = (message) => message.replace(/(^|\r\n)\./g, '$1..');

// ───────────── The conversation ─────────────
/** kind: 'connect' | 'dns' | 'tls' | 'timeout' | 'broken' | 'auth' | 'rejected'. */
const problem = (kind, detail, extra = {}) => Object.assign(new Error(detail || kind), { kind, detail: detail || '', ...extra });
const replyText = (reply) => oneLine(`${reply.code} ${reply.lines.join(' ')}`, 200);

/** Replies of the server, one at a time: { code, lines } – each waited for no longer than replyMs. */
function channel(socket, replyMs) {
  let buffer = '';
  let lines = [];
  const replies = [];
  let waiting = null;
  let dead = null;
  const hand = () => {
    if (!waiting || (!replies.length && !dead)) return;
    const w = waiting;
    waiting = null;
    clearTimeout(w.timer);
    if (replies.length) w.resolve(replies.shift());
    else w.reject(dead);
  };
  const onData = (chunk) => {
    buffer += chunk.toString('latin1');
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lines.push(line.slice(4));
      if (/^\d{3}(?: |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      } else if (!/^\d{3}-/.test(line)) dead ??= problem('broken', 'serwer odpowiedział czymś, co nie jest SMTP');
    }
    if (buffer.length > 16_384 || lines.length > 200) dead ??= problem('broken', 'serwer odpowiedział czymś, co nie jest SMTP');
    hand();
  };
  const onError = (err) => {
    dead ??= err;
    hand();
  };
  const onClose = () => onError(problem('broken', 'serwer zamknął połączenie'));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  const read = (ms = replyMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null;
        reject(problem('timeout', `brak odpowiedzi przez ${Math.max(1, Math.round(ms / 1000))} s`));
      }, ms);
      waiting = { resolve, reject, timer };
      hand();
    });
  return {
    read,
    /** Sends one line and waits for the answer; `codes` – the answers that mean "go on" (anything else is refused → thrown). */
    async command(line, codes = null, kind = 'rejected', ms = replyMs) {
      socket.write(`${line}\r\n`);
      const reply = await read(ms);
      if (codes && !codes.includes(reply.code)) throw problem(kind, replyText(reply), { reply });
      return reply;
    },
    /** Before the socket becomes a TLS socket: whatever came unencrypted is dropped with this reader. */
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    },
  };
}

const tlsOptions = (host) => ({ host, ...(net.isIP(host) ? {} : { servername: host }), ...(test.ca && { ca: test.ca }), minVersion: 'TLSv1.2' });

/** A socket that is connected (and, with secure, encrypted) within ms – or the reason it is not. */
function open(make, event, ms) {
  return new Promise((resolve, reject) => {
    const socket = make();
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(problem('timeout', `brak odpowiedzi przez ${Math.max(1, Math.round(ms / 1000))} s`)), ms);
    socket.once('error', fail);
    socket.once(event, () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      socket.on('error', () => {}); // from here the reader hears about errors; this keeps a late one from crashing the bot
      resolve(socket);
    });
  });
}

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const UNSUPPORTED = [500, 501, 502, 504]; // "I don't know this way of signing in"

/** AUTH PLAIN; LOGIN where the server does not take PLAIN. */
async function signIn(io, capabilities, { user, pass }) {
  const offered = String(capabilities.get('AUTH') ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  if (offered.includes('PLAIN') || !offered.includes('LOGIN')) {
    const reply = await io.command(`AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`);
    if (reply.code === 235) return;
    if (!UNSUPPORTED.includes(reply.code)) throw problem('auth', replyText(reply), { reply });
  }
  await io.command('AUTH LOGIN', [334], 'auth');
  await io.command(b64(user), [334], 'auth');
  await io.command(b64(pass), [235], 'auth');
}

/** EHLO → what the server can do: Map { 'AUTH' → 'PLAIN LOGIN', 'STARTTLS' → '', … } */
async function hello(io) {
  const name = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(os.hostname()) ? os.hostname() : '[127.0.0.1]';
  const reply = await io.command(`EHLO ${name}`, [250]);
  return new Map(reply.lines.slice(1).map((l) => {
    const m = /^([A-Za-z0-9-]+)(?:[ =](.*))?$/.exec(l.trim());
    return m ? [m[1].toUpperCase(), m[2] ?? ''] : [l, ''];
  }));
}

/** One whole delivery over one connection. Throws a problem(); the socket is closed whatever happens. */
async function talk(cfg, port, envelope, data) {
  const mode = modeOf(port);
  const connectMs = test.connectMs ?? CONNECT_MS;
  const replyMs = test.replyMs ?? REPLY_MS;
  const sockets = [];
  let greeted = false;
  try {
    // (autoSelectFamily: a server whose IPv6 address cannot be reached from this machine is tried over IPv4 too)
    const where = { port, autoSelectFamily: true };
    const socket = await open(() => (mode === 'tls' ? tls.connect({ ...where, ...tlsOptions(cfg.host) }) : net.connect({ ...where, host: cfg.host })), mode === 'tls' ? 'secureConnect' : 'connect', connectMs);
    sockets.push(socket);
    let io = channel(socket, replyMs);
    const greeting = await io.read(connectMs);
    if (greeting.code !== 220) throw problem('connect', replyText(greeting));
    greeted = true;
    let capabilities = await hello(io);
    if (mode === 'starttls') {
      // The password never goes out unencrypted: no STARTTLS, no sign-in.
      if (!capabilities.has('STARTTLS')) throw problem('tls', 'serwer nie oferuje szyfrowania (STARTTLS)');
      await io.command('STARTTLS', [220], 'tls');
      io.detach();
      const secure = await open(() => tls.connect({ socket, ...tlsOptions(cfg.host) }), 'secureConnect', connectMs);
      sockets.push(secure);
      io = channel(secure, replyMs);
      capabilities = await hello(io);
    }
    await signIn(io, capabilities, cfg);
    await io.command(`MAIL FROM:<${envelope.from}>`, [250]);
    await io.command(`RCPT TO:<${envelope.to}>`, [250, 251]);
    await io.command('DATA', [354]);
    await io.command(`${dotStuff(data)}.`, [250]); // (data ends with a line break of its own)
    await io.command('QUIT', null, null, Math.min(replyMs, 3000)).catch(() => null); // the message is accepted – a goodbye that does not come changes nothing
  } catch (err) {
    const kind = err.kind ?? (['ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ? 'dns' : /CERT|SSL|TLS|SIGN|VERIFY|EPROTO/i.test(`${err.code}`) ? 'tls' : greeted ? 'broken' : 'connect');
    // Until the server has said hello the port counts as "cannot be reached" – the other one is worth a try.
    throw Object.assign(err, { kind, port, unreachable: !greeted && kind !== 'dns', detail: err.detail || (kind === 'tls' ? err.message : err.code ?? err.message) });
  } finally {
    for (const s of sockets) s.destroy();
  }
}

// ───────────── What went wrong, in Polish ─────────────
const NETWORK = { ECONNREFUSED: 'połączenie odrzucone', ETIMEDOUT: 'brak odpowiedzi', ERR_SOCKET_CONNECTION_TIMEOUT: 'brak odpowiedzi', EHOSTUNREACH: 'serwer nieosiągalny', ENETUNREACH: 'sieć nieosiągalna', ECONNRESET: 'połączenie zerwane', EACCES: 'brak dostępu do sieci', EPERM: 'brak dostępu do sieci' };

function reasonOf(err, cfg, ports) {
  const detail = NETWORK[err.detail] ?? err.detail;
  switch (err.kind) {
    case 'auth':
      return `Serwer poczty ${cfg.host} nie przyjął hasła z pliku .env (MAIL_PASS). Dla konta Gmail musi to być 16-literowe „hasło do aplikacji” ze strony myaccount.google.com/apppasswords – nie zwykłe hasło do poczty – a MAIL_USER musi być adresem tego samego konta (teraz: ${cfg.user}). Odpowiedź serwera: ${detail}`;
    case 'connect':
    case 'timeout':
    case 'broken':
      if (!err.unreachable) return `Połączenie z serwerem poczty ${cfg.host} zostało przerwane w trakcie wysyłania (${detail}). Spróbuj ponownie za chwilę.`;
      return `Nie udało się połączyć z serwerem poczty ${cfg.host} (${ports.length > 1 ? `porty ${ports.join(' i ')}` : `port ${ports[0]}`}: ${detail}). Najczęściej to hosting blokuje wysyłanie poczty – napisz do jego pomocy z prośbą o odblokowanie portu ${ports.length > 1 ? ports.join(' albo ') : ports[0]} (SMTP) dla ${cfg.host}.`;
    case 'dns':
      return `Nie znaleziono serwera poczty „${cfg.host}” – sprawdź MAIL_HOST w pliku .env i to, czy serwer ma dostęp do internetu.`;
    case 'tls':
      return `Nie udało się nawiązać szyfrowanego połączenia z serwerem poczty ${cfg.host} (port ${err.port}): ${detail}.`;
    default: // 'rejected'
      return `Serwer poczty ${cfg.host} nie przyjął wiadomości. Odpowiedź serwera: ${detail}`;
  }
}

/** Worth another try a little later: the server said "4xx – not now", or the connection broke or stayed silent. */
function temporary(err) {
  if (err?.reply?.code >= 400 && err.reply.code < 500) return true;
  if (/^4\d\d /.test(String(err?.detail ?? ''))) return true; // a greeting like "421 Too many connections"
  if (err?.kind === 'dns') return err.code === 'EAI_AGAIN';
  return ['connect', 'timeout', 'broken'].includes(err?.kind);
}

function offReason(cfg) {
  if (!isAddress(cfg.from) || !isAddress(cfg.to)) return 'E-mail nie jest włączony: brakuje adresu – wpisz go w config.json („contact” → „email”) albo w pliku .env jako MAIL_USER i MAIL_TO.';
  return 'E-mail nie jest włączony: w pliku .env brakuje linii MAIL_PASS (hasło do aplikacji z konta Google).';
}

// ───────────── Sending ─────────────
let workingPort = null; // { key: 'host:port' as configured, port: the one that answered instead }
let last = { ok: null, at: null, reason: null }; // the newest attempt – the admin panel shows it
let said = null; // the cause the console was told about last

async function deliver({ subject, text, html, inline, replyTo, to }) {
  const cfg = settings();
  if (!ready()) return { ok: false, code: 'off', reason: offReason(cfg) };
  const rcpt = to == null ? cfg.to : oneLine(to);
  if (!isAddress(rcpt)) return { ok: false, code: 'address', reason: 'Nieprawidłowy adres odbiorcy.' };
  const data = compose({ from: cfg.from, fromName: config.brand?.name, to: rcpt, replyTo: oneLine(replyTo), subject, text, html, inline });
  const envelope = { from: cfg.from, to: rcpt };
  const key = `${cfg.host}:${cfg.port}`;
  const first = workingPort?.key === key ? workingPort.port : cfg.port;
  const second = first === cfg.port ? otherPort(cfg.port) : cfg.port;
  try {
    await talk(cfg, first, envelope, data);
    return { ok: true };
  } catch (err) {
    if (!err.unreachable || second == null) return { ok: false, code: err.kind, reason: reasonOf(err, cfg, [first]), temporary: temporary(err) };
    try {
      await talk(cfg, second, envelope, data);
      if (workingPort?.port !== second || workingPort.key !== key) console.log(`✉️ Poczta: port ${first} serwera ${cfg.host} nie odpowiada – wysyłam przez port ${second}.`);
      workingPort = second === cfg.port ? null : { key, port: second };
      return { ok: true };
    } catch (err2) {
      // Both closed: one story. The second port answered and said no: that is the real cause.
      return { ok: false, code: err2.kind, reason: reasonOf(err2.unreachable ? err : err2, cfg, err2.unreachable ? [first, second] : [second]), temporary: temporary(err2) };
    }
  }
}

/**
 * send({ subject, text, html?, inline?, replyTo?, to?, retry? }) → { ok: true } | { ok: false, code, reason }. Never
 * throws. inline: pictures the HTML shows with <img src="cid:…"> (compose()).
 * to: default MAIL_TO; replyTo: where "Reply" goes (left out when it is not a plain address); html: the same message
 * as a web page – sent next to the text, never instead of it; retry: false – one try only, the answer right away
 * (the admin panel's test e-mail – the owner waits for it).
 */
async function send(message = {}) {
  let result;
  const waits = message.retry === false ? [] : test.retryMs ?? (testing ? [] : RETRY_MS);
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await deliver(message);
    } catch (err) {
      result = { ok: false, code: 'error', reason: `Nie udało się wysłać e-maila: ${oneLine(err?.message, 200)}` };
    }
    if (result.ok || !result.temporary || attempt >= waits.length) break;
    await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
  }
  delete result.temporary;
  if (result.code !== 'off') {
    last = { ok: result.ok, at: Date.now(), reason: result.ok ? null : result.reason };
    // Once per cause: a mailbox that is down for a day must not fill the console with the same line.
    if (result.ok && said) console.log('✉️ Poczta znowu działa – e-mail wysłany.');
    else if (!result.ok && said !== result.reason) console.warn(`✉️ E-mail nie został wysłany. ${result.reason}`);
    said = result.ok ? null : result.reason;
  }
  return result;
}

/** "jan.kowalski@gmail.com" → "ja***@gmail.com" – enough for the owner of the address to recognise it, on a public page. */
function mask(address) {
  if (!isAddress(address)) return null;
  const [local, domain] = address.split('@');
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***@${domain}`;
}

/** Why nothing can be sent right now (a Polish sentence) – null when e-mail is set up. */
const whyOff = () => (ready() ? null : offReason(settings()));

/** For the admin panel and npm run check – never the password. */
function status() {
  const s = settings();
  return { ready: ready(), to: s.to || null, from: s.from || null, host: s.host, port: workingPort?.key === `${s.host}:${s.port}` ? workingPort.port : s.port, hasPassword: Boolean(s.pass), last: { ...last } };
}

module.exports = {
  send, ready, whyOff, status, isAddress, mask, oneLine, compose, dotStuff,
  /** Tests only – see `test` above; no argument puts everything back. */
  _test: (options = {}) => {
    test = options;
    testing = true;
    workingPort = null;
    last = { ok: null, at: null, reason: null };
    said = null;
  },
};
