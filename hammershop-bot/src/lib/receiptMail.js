'use strict';

/**
 * The buyer's e-mail after a paid website order (src/features/website.js buyerMail): one message in two versions –
 * HTML for Gmail and phones, plain text for every other mail app (src/lib/mail.js sends both as
 * multipart/alternative). Only what Gmail keeps: tables and inline styles, no <style> block, no pictures from
 * anywhere, no scripts – the logo is text. Dark with the orange of the website; one column that fits a phone.
 *
 *   plusReceipt({ brand, orderId, amount, paidAt, plan, nick, until, code, problem, pageUrl, help }) → { subject, text, html }
 *   shopReceipt({ brand, orderId, amount, paidAt, items, delivery, ticketUrl, help })              → { subject, text, html }
 *
 * help = { ticket: the ticket type's name, discord: an invite link | null, email: the contact address | null }.
 * Everything that goes into the HTML is escaped here; links are only http(s) and mailto: to a plain address.
 */

const C = { page: '#0e0b09', card: '#1a1410', inset: '#120d0a', line: '#3a2a1e', text: '#fbf4ee', soft: '#dcc7b4', muted: '#a8988a', accent: '#ff9a3c', gold: '#ffd166', ink: '#1f1206' };
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "Consolas,'SFMono-Regular',Menlo,'Courier New',monospace";

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const webUrl = (value) => (typeof value === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(value) ? value : null);
const PLAIN_ADDRESS = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const mailto = (address) => (typeof address === 'string' && PLAIN_ADDRESS.test(address) ? address : null);
const plDateTime = (ms) => new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }).format(new Date(ms));

/** "Hammer Launcher" → Hammer + an orange "Launcher" (the website's logo, as text). */
function logo(brand) {
  const m = /^(Hammer)\s?(.+)$/.exec(String(brand ?? ''));
  const style = `font-family:${FONT};font-size:20px;line-height:1.2;font-weight:800;color:${C.text};letter-spacing:-0.2px;`;
  return m ? `<span style="${style}">${esc(m[1])}<span style="color:${C.accent};">${esc(m[2])}</span></span>` : `<span style="${style}">${esc(brand)}</span>`;
}

const p = (html, { size = 15, color = C.soft, margin = '0 0 14px', weight = 400 } = {}) => `<p style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.55;font-weight:${weight};color:${color};">${html}</p>`;
const link = (url, label) => `<a href="${esc(url)}" style="color:${C.accent};text-decoration:underline;">${esc(label)}</a>`;

/** Label – value rows (the plan, the account, the dates). */
function facts(rows) {
  const cells = rows
    .filter(([, value]) => value)
    .map(([label, value], i) => `<tr><td style="padding:9px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:1.4;color:${C.muted};width:42%;vertical-align:top;">${esc(label)}</td><td style="padding:9px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:14px;line-height:1.4;color:${C.text};font-weight:600;vertical-align:top;word-break:break-word;">${esc(value)}</td></tr>`)
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">${cells}</table>`;
}

/** The orange button – a link, the one place a click is asked for. */
const button = (url, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px;"><tr><td bgcolor="${C.accent}" style="background:${C.accent};border-radius:10px;"><a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:700;color:${C.ink};text-decoration:none;border-radius:10px;">${esc(label)}</a></td></tr></table>`;

/** The whole page around a card: the logo, the card, the help and the small print under it. */
function page({ title, preheader, brand, card, help, footer }) {
  return [
    '<!doctype html>',
    '<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">',
    `<title>${esc(title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">`,
    // What the inbox shows next to the subject (hidden in the message itself).
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};font-size:1px;line-height:1px;">${esc(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};"><tr><td align="center" style="padding:24px 12px 32px;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">',
    `<tr><td style="padding:0 6px 16px;">${logo(brand)}</td></tr>`,
    `<tr><td bgcolor="${C.accent}" style="background:${C.accent};height:4px;line-height:4px;font-size:0;border-radius:16px 16px 0 0;">&nbsp;</td></tr>`,
    `<tr><td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:28px 24px 22px;">${card}</td></tr>`,
    `<tr><td style="padding:20px 6px 0;">${help}</td></tr>`,
    `<tr><td style="padding:14px 6px 0;">${p(footer, { size: 12, color: C.muted, margin: '0' })}</td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('\n');
}

/** "Potrzebujesz pomocy?" – the Discord ticket and the contact address, in both versions. */
function helpParts(help = {}, orderId) {
  const discord = webUrl(help.discord);
  const email = mailto(help.email);
  const ticket = help.ticket || 'Pomoc';
  const text = [
    'Potrzebujesz pomocy?',
    `Otwórz ticket „${ticket}” na naszym Discordzie${discord ? ` (${discord})` : ''}${email ? ` albo odpisz na tego e-maila / napisz na ${email}` : ''}. Podaj numer zamówienia ${orderId}.`,
  ];
  const html = p(`<b style="color:${C.text};">Potrzebujesz pomocy?</b> Otwórz ticket <b style="color:${C.text};">„${esc(ticket)}”</b> na ${discord ? link(discord, 'naszym Discordzie') : 'naszym Discordzie'}${email ? ` albo odpisz na tego e-maila (${link(`mailto:${email}`, email)})` : ''}. Podaj numer zamówienia <b style="color:${C.text};">${esc(orderId)}</b>.`, { size: 13, color: C.muted, margin: '0' });
  return { text, html };
}

/** The three steps in the launcher, numbered. */
function steps(list) {
  const rows = list
    .map((html, i) => `<tr><td style="width:34px;padding:0 0 10px;vertical-align:top;"><div style="width:24px;height:24px;border-radius:12px;background:${C.accent};color:${C.ink};font-family:${FONT};font-size:13px;font-weight:800;line-height:24px;text-align:center;">${i + 1}</div></td><td style="padding:2px 0 10px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.soft};vertical-align:top;">${html}</td></tr>`)
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;">${rows}</table>`;
}

/**
 * Hammer+ bought on the website. code: the code for the buyer's Minecraft account – null when it could not be issued
 * (then `problem` says what happens next, and the e-mail asks the buyer to write to the team).
 */
function plusReceipt({ brand, orderId, amount, paidAt, plan, nick, until, code, problem = null, pageUrl = null, help = {} }) {
  const page_ = webUrl(pageUrl);
  const paid = `${amount} · płatność online · ${plDateTime(paidAt ?? Date.now())}`;
  const help_ = helpParts(help, orderId);
  const subject = code ? 'Dziękujemy za zakup Hammer+ – Twój kod' : 'Dziękujemy za zakup Hammer+ – płatność przyjęta';
  const how = ['Otwórz Hammer Launcher i wejdź w zakładkę Hammer+.', 'Kliknij „Mam kod” i wklej kod.', 'Kliknij „Aktywuj” – gotowe.'];

  const text = [
    'Dziękujemy za zakup Hammer+!',
    '',
    code ? `Płatność przeszła pomyślnie. Oto Twój kod Hammer+ dla konta Minecraft ${nick}:` : `Płatność przeszła pomyślnie. ${problem ?? `Kod Hammer+ dla konta ${nick} wystawi nasz zespół.`}`,
    ...(code ? ['', code, ''] : ['']),
    `Plan: ${plan}`,
    `Konto Minecraft: ${nick}`,
    code && until ? `Ważny: ${until}` : null,
    `Numer zamówienia: ${orderId}`,
    `Zapłacono: ${paid}`,
    ...(code ? ['', 'Jak aktywować:', ...how.map((s, i) => `${i + 1}. ${s}`), `Kod działa tylko na koncie Minecraft ${nick}.`] : []),
    ...(page_ ? ['', `Twoje kody są też na stronie (po zalogowaniu przez Discord): ${page_}`] : []),
    '',
    ...help_.text,
    '',
    `Zespół ${brand}`,
  ].filter((l) => l !== null).join('\n');

  const codeBox = code
    ? [
        p(`Płatność przeszła pomyślnie. Oto Twój kod <b style="color:${C.text};">Hammer+</b> dla konta Minecraft <b style="color:${C.text};">${esc(nick)}</b>:`),
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;"><tr><td bgcolor="${C.inset}" style="background:${C.inset};border:2px dashed ${C.accent};border-radius:12px;padding:16px;font-family:${MONO};font-size:15px;line-height:1.5;font-weight:700;color:${C.gold};word-break:break-all;-webkit-user-select:all;user-select:all;">${esc(code)}</td></tr></table>`,
        p('Skopiuj cały kod – od „HP1.” do ostatniego znaku (na telefonie przytrzymaj go palcem).', { size: 12, color: C.muted, margin: '0 0 22px' }),
      ].join('')
    : p(`Płatność przeszła pomyślnie. ${esc(problem ?? `Kod Hammer+ dla konta ${nick} wystawi nasz zespół.`)}`, { margin: '0 0 22px' });
  const card = [
    `<h1 style="margin:0 0 10px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;color:${C.text};">Dziękujemy za zakup! 🎉</h1>`,
    codeBox,
    facts([['Plan', plan], ['Konto Minecraft', nick], ['Ważny', code ? until : null], ['Numer zamówienia', orderId], ['Zapłacono', paid]]),
    code ? `<h2 style="margin:0 0 12px;font-family:${FONT};font-size:16px;line-height:1.3;font-weight:800;color:${C.text};">Jak aktywować</h2>` : '',
    code ? steps([`Otwórz <b style="color:${C.text};">Hammer Launcher</b> i wejdź w zakładkę <b style="color:${C.text};">Hammer+</b>.`, `Kliknij <b style="color:${C.text};">„Mam kod”</b> i wklej kod.`, `Kliknij <b style="color:${C.text};">„Aktywuj”</b> – gotowe.`]) : '',
    code ? p(`Kod działa tylko na koncie Minecraft <b style="color:${C.text};">${esc(nick)}</b>.`, { size: 13, color: C.muted, margin: '0 0 18px' }) : '',
    page_ ? button(page_, 'Moje kody na stronie') : '',
  ].join('\n');
  const html = page({
    title: subject,
    preheader: code ? `Twój kod Hammer+ dla konta ${nick} – wklej go w launcherze: Hammer+ → „Mam kod”.` : `Płatność za Hammer+ dla konta ${nick} przyjęta.`,
    brand,
    card,
    help: help_.html,
    footer: `Dostajesz tę wiadomość, bo kupiłeś(-aś) Hammer+ na stronie ${esc(brand)}, podając ten adres przy płatności. Zachowaj ją – to Twoje potwierdzenie zakupu.`,
  });
  return { subject, text, html };
}

/** A shop order (products) paid on the website: what was bought, for how much, and where it is delivered. */
function shopReceipt({ brand, orderId, amount, paidAt, items = [], delivery = null, ticketUrl = null, help = {} }) {
  const ticket = webUrl(ticketUrl);
  const paid = `${amount} · płatność online · ${plDateTime(paidAt ?? Date.now())}`;
  const help_ = helpParts(help, orderId);
  const subject = `Dziękujemy za zakup – zamówienie ${orderId}`;
  const lines = items.map((i) => `${i.quantity}× ${i.name}`);
  const text = [
    'Dziękujemy za zakup!',
    '',
    `Płatność za zamówienie ${orderId} przeszła pomyślnie.`,
    '',
    'Co kupiłeś(-aś):',
    ...lines.map((l) => `- ${l}`),
    '',
    `Zapłacono: ${paid}`,
    delivery ? `Dostawa: ${delivery}` : null,
    ticket ? `Ticket na Discordzie: ${ticket}` : null,
    '',
    ...help_.text,
    '',
    `Zespół ${brand}`,
  ].filter((l) => l !== null).join('\n');
  const card = [
    `<h1 style="margin:0 0 10px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;color:${C.text};">Dziękujemy za zakup! 🎉</h1>`,
    p(`Płatność za zamówienie <b style="color:${C.text};">${esc(orderId)}</b> przeszła pomyślnie.`),
    facts([...lines.map((l, n) => [n ? '' : 'Co', l]).map(([label, value]) => [label || ' ', value]), ['Zapłacono', paid]]),
    delivery ? p(esc(delivery), { margin: '0 0 18px' }) : '',
    ticket ? button(ticket, 'Otwórz ticket na Discordzie') : '',
  ].join('\n');
  const html = page({ title: subject, preheader: `Zamówienie ${orderId} opłacone – ${lines.join(', ')}`.slice(0, 140), brand, card, help: help_.html, footer: `Dostajesz tę wiadomość, bo kupiłeś(-aś) coś na stronie ${esc(brand)}, podając ten adres przy płatności. Zachowaj ją – to Twoje potwierdzenie zakupu.` });
  return { subject, text, html };
}

module.exports = { plusReceipt, shopReceipt, esc, plDateTime };
