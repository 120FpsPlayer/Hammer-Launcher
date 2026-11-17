/* What has to happen before anything is drawn – the start page and the Funkcje page load this in their <head>
   (the pages' own script, launcher.js, runs after the page is on the screen).

   The start page – old addresses. The site used to be one long page, so links in installed launchers, on Discord and
   in bookmarks point at its sections (/launcher#plus, /#polecaj …), and a sign-in or a payment started before the
   change comes back to it. A # never reaches the server, so this goes straight to the page (or the part of a page)
   that has that section now. The query string is kept (?connected=1, ?payment=return&session_id=…).

   The Funkcje page – which of its three parts is shown: the one the address names (#hammer-client, #wyglad), the
   launcher's otherwise. It is written on <html data-part="…">, launcher.css hides the other two and launcher.js
   switches between them. Without scripts nothing is written and all three parts simply follow one another. */
(function () {
  'use strict';
  var root = document.documentElement;
  var base = root.getAttribute('data-base') || '';
  var page = root.getAttribute('data-page');
  var hash = location.hash.slice(1);
  var query = location.search;

  if (page === 'funkcje') {
    var part = hash === 'hammer-client' || hash === 'wyglad' ? hash : 'launcher';
    // Back from a Discord sign-in started on one of the parts: that part again.
    if (!hash && /[?&](connected|auth)=/.test(query)) {
      try { part = { 'hammer-client': 'hammer-client', wyglad: 'wyglad' }[sessionStorage.getItem('hs_part')] || part; } catch (e) { /* private mode */ }
    }
    root.setAttribute('data-part', part);
    return;
  }
  if (page !== 'start') return;

  var SECTIONS = { plus: 'hammer-plus', polecaj: 'polecaj', faq: 'pomoc', funkcje: 'funkcje', klient: 'funkcje#hammer-client', wyglad: 'funkcje#wyglad', start: 'funkcje#start', aktualnosci: 'aktualnosci' };
  if (!base) SECTIONS.hammershop = 'hammershop'; // a page of Hammer Launcher's own site only
  var target = Object.prototype.hasOwnProperty.call(SECTIONS, hash) ? SECTIONS[hash] : null;
  if (!target && /[?&]payment=/.test(query)) target = 'hammer-plus';
  // Signed in because of a "Kup" click on the old page: the plan waits on the Hammer+ page.
  if (!target && /[?&]connected=/.test(query)) {
    try { if (sessionStorage.getItem('hs_plan')) target = 'hammer-plus'; } catch (e) { /* private mode */ }
  }
  if (!target) return;
  root.className += ' leaving'; // nothing of the start page shows in the meantime (launcher.css)
  var parts = target.split('#');
  location.replace(base + '/' + parts[0] + query + (parts[1] ? '#' + parts[1] : ''));
})();
