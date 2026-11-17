'use strict';

/**
 * A local SMTP server for the tests – plain TCP by default, TLS from the first byte ({ implicit: true }) or STARTTLS
 * ({ starttls: true }) with a throwaway certificate made on the spot (selfSigned() – nothing is kept in the repository).
 *
 *   const smtp = await startSmtp({ user, pass });
 *   smtp.port            where it listens (127.0.0.1)
 *   smtp.messages        what was accepted: { from, to, raw, headers (unfolded, lower-case names), subject, text }
 *   smtp.sessions        every connection: { commands [...], secure, closed }
 *   smtp.behave          change how it answers from now on: { rejectAuth, noPlain, rejectRcpt, rejectData, silent,
 *                        hangAfterHello, greetDelay (ms) }
 *   await smtp.next()    the next accepted message
 */

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

// ── A self-signed certificate for 127.0.0.1 / localhost, written by hand (DER) so the tests need no openssl ──
const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (let n of rest) {
    const part = [n & 0x7f];
    while ((n >>= 7)) part.unshift((n & 0x7f) | 0x80);
    bytes.push(...part);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utcTime = (ms) => tlv(0x17, Buffer.from(`${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

function selfSigned() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // (a name of its own: two of these certificates trusted side by side must not be mistaken for each other)
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(`fake-smtp-${crypto.randomBytes(4).toString('hex')}`)))));
  const algorithm = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const altNames = seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = tlv(0xa3, seq(
    seq(oid('2.5.29.17'), tlv(0x04, altNames)),
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))), // its own CA: the client is told to trust exactly this one
  ));
  const body = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), algorithm, name, seq(utcTime(Date.now() - 3_600_000), utcTime(Date.now() + 86_400_000)), name, publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const signature = crypto.sign('sha256', body, privateKey);
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', seq(body, algorithm, tlv(0x03, Buffer.from([0]), signature))) };
}

// ── Reading what arrived ──
const decodeWords = (value) => value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=(\s+(?==\?))?/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));

function parse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = rest.join('\r\n\r\n');
  const text = /base64/i.test(headers['content-transfer-encoding'] ?? '') ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : body;
  return { raw, headers, headerLines: head.split('\r\n'), bodyLines: body.split('\r\n').filter(Boolean), subject: decodeWords(headers.subject ?? ''), text: text.replace(/\r\n/g, '\n') };
}

function startSmtp({ user = 'kontakt@example.com', pass = 'app-password', implicit = false, starttls = false } = {}) {
  const cert = implicit || starttls ? selfSigned() : null;
  const state = { messages: [], sessions: [], behave: {}, waiters: [], cert: cert?.cert ?? null };

  const serve = (socket, session) => {
    let buffer = '';
    let stage = 'command'; // 'command' | 'data' | 'login-user' | 'login-pass' | 'plain'
    let mail = null;
    let loginUser = '';
    let authed = false;
    let active = socket;
    const say = (...lines) => active.write(lines.map((l, i) => `${l.slice(0, 3)}${i === lines.length - 1 ? ' ' : '-'}${l.slice(4)}\r\n`).join(''));
    const checkPlain = (b64) => {
      const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
      return u === user && p === pass;
    };
    const signedIn = (ok) => {
      authed = ok && !state.behave.rejectAuth;
      say(authed ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted');
    };
    const onLine = (line) => {
      if (stage === 'data') {
        if (line === '.') {
          stage = 'command';
          if (state.behave.rejectData) return say('554 5.7.0 Message refused');
          const message = { from: mail.from, to: mail.to, ...parse(mail.lines.join('\r\n')) };
          state.messages.push(message);
          for (const w of state.waiters.splice(0)) w(message);
          return say('250 2.0.0 OK queued');
        }
        return mail.lines.push(line.startsWith('.') ? line.slice(1) : line);
      }
      if (stage === 'login-user') {
        loginUser = Buffer.from(line, 'base64').toString('utf8');
        session.commands.push('<user>');
        stage = 'login-pass';
        return say('334 UGFzc3dvcmQ6');
      }
      if (stage === 'login-pass') {
        session.commands.push('<pass>');
        stage = 'command';
        return signedIn(loginUser === user && Buffer.from(line, 'base64').toString('utf8') === pass);
      }
      const verb = line.split(' ')[0].toUpperCase();
      session.commands.push(verb === 'AUTH' ? line.split(' ').slice(0, 2).join(' ').toUpperCase() : line);
      if (verb === 'EHLO') {
        if (state.behave.hangAfterHello) return null;
        const methods = state.behave.noPlain ? 'LOGIN' : 'PLAIN LOGIN';
        return say('250 fake.smtp.test', '250 SIZE 35882577', ...(starttls && !session.secure ? ['250 STARTTLS'] : [`250 AUTH ${methods}`]), '250 8BITMIME');
      }
      if (verb === 'STARTTLS' && starttls && !session.secure) {
        say('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        active = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(cert) });
        session.secure = true;
        active.on('data', onData);
        active.on('error', () => {});
        return null;
      }
      if (verb === 'AUTH') {
        if (starttls && !session.secure) return say('530 5.7.0 Must issue a STARTTLS command first');
        const [, method, initial] = line.split(' ');
        if (method.toUpperCase() === 'PLAIN') return state.behave.noPlain ? say('504 5.7.4 Unrecognized authentication type') : signedIn(checkPlain(initial ?? ''));
        if (method.toUpperCase() === 'LOGIN') {
          stage = 'login-user';
          return say('334 VXNlcm5hbWU6');
        }
        return say('504 5.7.4 Unrecognized authentication type');
      }
      if (verb === 'MAIL') {
        if (!authed) return say('530 5.7.0 Authentication Required');
        mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [], lines: [] };
        return say('250 2.1.0 OK');
      }
      if (verb === 'RCPT') {
        if (!mail) return say('503 5.5.1 MAIL first');
        if (state.behave.rejectRcpt) return say('550 5.1.1 The email account that you tried to reach does not exist');
        mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        return say('250 2.1.5 OK');
      }
      if (verb === 'DATA') {
        if (!mail?.to.length) return say('503 5.5.1 RCPT first');
        stage = 'data';
        return say('354 Go ahead');
      }
      if (verb === 'QUIT') {
        say('221 2.0.0 Bye');
        return active.end();
      }
      return say('502 5.5.1 Unrecognized command');
    };
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      for (let i = buffer.indexOf('\r\n'); i !== -1; i = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.on('close', () => (session.closed = true));
    if (state.behave.greetDelay) setTimeout(() => say('220 fake.smtp.test ESMTP ready'), state.behave.greetDelay);
    else if (!state.behave.silent) say('220 fake.smtp.test ESMTP ready');
  };

  const onConnection = (socket) => {
    const session = { commands: [], secure: implicit, closed: false };
    state.sessions.push(session);
    serve(socket, session);
  };
  const server = implicit ? tls.createServer(cert, onConnection) : net.createServer(onConnection);
  server.on('tlsClientError', () => {});
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(Object.assign(state, {
        port: server.address().port,
        user,
        pass,
        close: () => server.close(),
        /** The next message the server accepts (or one it already has that nobody asked for yet). */
        next: (ms = 5000) =>
          new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('No e-mail arrived at the fake SMTP server')), ms);
            state.waiters.push((m) => {
              clearTimeout(timer);
              done(m);
            });
          }),
      }));
    }),
  );
}

/** A port on which nothing listens. */
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

module.exports = { startSmtp, closedPort, selfSigned, decodeWords };
