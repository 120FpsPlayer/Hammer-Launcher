'use strict';

/**
 * The launcher's part of the website – one short page per subject (it used to be one long page):
 *
 *   start          /               the download button, the numbers, where to go next
 *   funkcje        /funkcje        what the launcher does (the clips) and how to start in 3 steps
 *   hammer-client  /hammer-client  the client in the game, what others see on your character
 *   wyglad         /wyglad         themes, capes and cosmetics in the launcher
 *   hammer-plus    /hammer-plus    what Hammer+ gives, the plans, „Twoje kody”
 *   polecaj        /polecaj        „Zaproś znajomego”
 *   aktualnosci    /aktualnosci    the current version and the news
 *   pomoc          /pomoc          frequent questions, where to get help
 *   kontakt        /kontakt        the contact form
 *   hammershop     /hammershop     HammerShop, the co-creator (Hammer Launcher's own site only)
 *
 * On Hammer Launcher's own site (BOT_PROFILE=launcher) they are the site itself; on HammerShop's site the same pages
 * live under /launcher (/launcher/hammer-plus …) – BASE below is the only difference.
 *
 * The sources are in web/pages/ – outside web/public, so a browser can never fetch a raw file with both sites' parts
 * in it: layout.html (head, icons, header, footer) and one file per page with what goes into <main>. In them:
 *
 *   {{base}} {{home}}      '' and '/' on the launcher's own site, '/launcher' and '/launcher' on HammerShop's
 *   {{title}} …            the page's own title, description and address (see `render`)
 *   <!--shop-->…<!--/shop-->, <!--launcher-->…<!--/launcher-->   only on that site
 *   <!--contact-->…<!--/contact-->                               only when a contact address is set (config.contact.email)
 *   data-nav="<page>"      on links: the current page's link gets aria-current="page"
 *
 * Addresses the one long page had (/launcher, /#plus, ?payment=return …) still work: what the server can see is
 * answered here (`resolve`), a # is handled by the start page itself (web/public/assets/launcher-redirect.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const profile = require('../lib/profile');
const config = require('../lib/config');
const { stampAssets, ASSET_REF } = require('./stamp');

const DIR = path.join(__dirname, '..', '..', 'web', 'pages');
const BASE = profile.launcher ? '' : '/launcher';
const HOME = BASE || '/';
const BRAND = 'Hammer Launcher';

/** title: what the tab and a shared link say; description: the line under it in a search result or on Discord. */
const PAGES = [
  {
    id: 'start', slug: '', file: 'start.html', head: '<script src="/assets/launcher-redirect.js"></script>',
    title: profile.launcher ? 'Hammer Launcher – nasz własny launcher Minecrafta' : 'Hammer Launcher – launcher Minecrafta od HammerShop',
    ogTitle: 'Hammer Launcher – nasz własny launcher Minecrafta',
    description: 'Hammer Launcher (beta) – nasz własny launcher Minecrafta: instancje, ponad tysiąc modów z Modrinth, FPS boost jednym kliknięciem i własny klient w grze. Pobierz za darmo na Windows.',
  },
  {
    id: 'funkcje', slug: 'funkcje', file: 'funkcje.html',
    title: `Funkcje – ${BRAND}`,
    description: 'Co potrafi Hammer Launcher: osobne instancje, ponad tysiąc modów z Modrinth, FPS boost jednym kliknięciem i gra w 3 krokach. Zobacz krótkie nagrania z launchera.',
  },
  {
    id: 'hammer-client', slug: 'hammer-client', file: 'hammer-client.html',
    title: `Hammer Client – ${BRAND}`,
    description: 'Hammer Client w grze: własne menu, ponad 50 modułów, edytor HUD, zoom, waypointy i znaczek Hammer na liście graczy. Launcher dodaje go sam w instancjach Fabric i Quilt.',
  },
  {
    id: 'wyglad', slug: 'wyglad', file: 'wyglad.html',
    title: `Wygląd: motywy i peleryny – ${BRAND}`,
    description: 'Motywy launchera z ruchomym tłem – Nether, End, Ocean, Wiśniowy gaj i Głęboki mrok – oraz peleryny i dodatki na postać. Sam wygląd, zero przewagi w grze.',
  },
  {
    id: 'hammer-plus', slug: 'hammer-plus', file: 'hammer-plus.html',
    title: `Hammer+ – ${BRAND}`,
    description: 'Hammer+ to dodatek do Hammer Launchera: motywy z ruchomym tłem, ruchome peleryny, kopie światów i chmura ustawień. Kod dostajesz od razu po zakupie – tutaj i na Discordzie.',
  },
  {
    id: 'polecaj', slug: 'polecaj', file: 'polecaj.html',
    title: `Zaproś znajomego – ${BRAND}`,
    description: 'Wyślij znajomemu swój link do Hammer Launchera. Za każdego, kto kupi Hammer+, dostajesz 7 dni Hammer+ za darmo.',
  },
  {
    id: 'aktualnosci', slug: 'aktualnosci', file: 'aktualnosci.html',
    title: `Aktualności – ${BRAND}`,
    description: 'Co nowego w Hammer Launcherze: aktualna wersja, lista zmian i ogłoszenia.',
  },
  {
    id: 'pomoc', slug: 'pomoc', file: 'pomoc.html',
    title: `Pomoc i częste pytania – ${BRAND}`,
    description: 'Odpowiedzi na częste pytania o Hammer Launcher: pobieranie, instalacja, konto Microsoft, aktualizacje i Hammer+. Nie ma Twojego pytania? Napisz do nas.',
  },
  {
    id: 'kontakt', slug: 'kontakt', file: 'kontakt.html',
    title: `Kontakt – ${BRAND}`,
    description: 'Napisz do zespołu Hammer Launchera: pomoc z launcherem, Hammer+ i płatności, zgłoszenia błędów i współpraca. Odpiszemy na Twój e-mail.',
  },
  {
    id: 'hammershop', slug: 'hammershop', file: 'hammershop.html', only: 'launcher',
    title: 'HammerShop – współtwórca Hammer Launchera',
    description: 'HammerShop współtworzy Hammer Launcher. Na co dzień to sklep dla wszystkich, którzy prowadzą własny serwer Minecraft albo Discord: pluginy, skrypty, boty i serwery.',
  },
].filter((p) => !p.only || p.only === profile.name);

/** What an address that is no page gets (status 404). */
const NOT_FOUND = { id: 'nie-ma', slug: null, file: '404.html', title: `Nie ma takiej strony – ${BRAND}`, description: 'Pod tym adresem nic nie ma. Wróć na stronę główną Hammer Launchera.', missing: true };

const byId = new Map(PAGES.map((p) => [p.id, p]));
const bySlug = new Map(PAGES.map((p) => [p.slug, p]));

/** The address of a page: pathOf('hammer-plus') → '/hammer-plus' (or '/launcher/hammer-plus'); the start page for an unknown one. */
const pathOf = (id) => {
  const page = byId.get(id);
  return page?.slug ? `${BASE}/${page.slug}` : HOME;
};

/**
 * Which page an address is: { page } – one of PAGES, or NOT_FOUND for an address in the launcher's part of the site
 * that is nothing; { redirect } – an address from before the pages were split; null – not the launcher's (the shop's
 * own page, a file …). On the launcher's own site every address that is no file belongs to it.
 */
function resolve(pathname) {
  const clean = String(pathname).replace(/\/+$/, '') || '/';
  if (profile.launcher) {
    if (clean === '/') return { page: byId.get('start') };
    // The page's old addresses: installed launchers, Discord cards and bookmarks open /launcher (#plus, #polecaj).
    if (['/launcher', '/launcher.html', '/index.html'].includes(clean)) return { redirect: HOME };
    const old = /^\/launcher\/([a-z0-9-]+)$/.exec(clean);
    if (old) return bySlug.has(old[1]) ? { redirect: pathOf(bySlug.get(old[1]).id) } : { page: NOT_FOUND };
    const page = bySlug.get(clean.slice(1));
    if (page) return { page };
    return clean.startsWith('/assets/') ? null : { page: NOT_FOUND };
  }
  if (clean === BASE) return { page: byId.get('start') };
  if (clean === '/launcher.html') return { redirect: HOME };
  if (!clean.startsWith(`${BASE}/`)) return null;
  return { page: bySlug.get(clean.slice(BASE.length + 1)) ?? NOT_FOUND };
}

/**
 * Where a Discord sign-in may come back to (?next=<name>): every page by its id, plus launcher (the start page) and
 * download (the start page, which then starts the download itself). A fixed list – never an address from outside.
 */
function signInTargets() {
  return { ...Object.fromEntries(PAGES.map((p) => [p.id, pathOf(p.id)])), launcher: HOME, download: `${HOME}?download=1` };
}

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const https = (url) => (/^https:\/\/[^\s"<>]+$/.test(String(url ?? '')) ? String(url) : '');

/** <!--name-->…<!--/name-->: kept (without the markers) when on, cut out when off. */
function blocks(html, on) {
  for (const [name, keep] of Object.entries(on)) {
    html = keep ? html.replace(new RegExp(`<!--/?${name}-->`, 'g'), '') : html.replace(new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`, 'g'), '');
  }
  return html;
}

/** What is only for one of the two sites (see the top of this file) – also used for the admin panel's page. */
const forProfile = (html) => blocks(html, { shop: profile.shop, launcher: profile.launcher });

/**
 * A page as the browser gets it: the layout around the page's own part, for this site, with its title, description
 * and address (origin: the site's public address – canonical and the link preview want whole addresses), the current
 * page's link marked and every /assets/… address stamped. page: one of PAGES or NOT_FOUND.
 */
function render(page, origin = '') {
  const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
  const partner = config.partner ?? {};
  const contact = String(config.contact?.email ?? '').trim();
  const values = {
    title: esc(page.title),
    og_title: esc(page.ogTitle ?? page.title),
    description: esc(page.description),
    canonical: esc(`${origin}${page.missing ? HOME : pathOf(page.id)}`),
    origin: esc(origin),
    robots: page.missing ? '<meta name="robots" content="noindex">' : '',
    head: page.head ?? '',
    page: page.id,
    next: page.missing ? 'start' : page.id, // where "Zaloguj przez Discord" in the header comes back to
    base: BASE,
    home: HOME,
    contact: esc(contact),
    partner_url: esc(https(partner.url) || 'https://hammershop.pl'),
    partner_discord: esc(https(partner.discord)),
  };
  let html = read('layout.html').replace('{{main}}', () => read(page.file));
  html = blocks(forProfile(html), { contact: Boolean(contact), 'partner-discord': Boolean(values.partner_discord) });
  html = html.replace(/\{\{([a-z_]+)\}\}/g, (token, name) => (name in values ? values[name] : token));
  html = html.replace(/ data-nav="([a-z0-9-]+)"/g, (attr, id) => (id === page.id ? ' aria-current="page"' : ''));
  return html.replace(ASSET_REF, (url) => stampAssets(url));
}

/** robots.txt of the launcher's own site: everything but the admin panel and the API. */
const robots = (origin) => `User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /join\nDisallow: /r/\n\nSitemap: ${origin}/sitemap.xml\n`;

/** sitemap.xml: the pages, with whole addresses. */
function sitemap(origin) {
  const urls = PAGES.map((p) => `  <url><loc>${esc(`${origin}${pathOf(p.id)}`)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

module.exports = { PAGES, NOT_FOUND, BASE, HOME, DIR, pathOf, resolve, signInTargets, render, forProfile, robots, sitemap };
