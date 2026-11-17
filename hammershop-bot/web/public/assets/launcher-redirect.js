/* Old addresses. The site used to be one long page, so links in installed launchers, on Discord and in bookmarks point
   at its sections (/launcher#plus, /#polecaj …), and a sign-in or a payment started before the change comes back to
   it. A # never reaches the server, so the start page loads this in its <head> – before anything is drawn – and goes
   straight to the page that has that part now. The query string is kept (?connected=1, ?payment=return&session_id=…). */
(function () {
  'use strict';
  var root = document.documentElement;
  var base = root.getAttribute('data-base') || '';
  var SECTIONS = { plus: 'hammer-plus', polecaj: 'polecaj', faq: 'pomoc', funkcje: 'funkcje', klient: 'hammer-client', wyglad: 'wyglad', start: 'funkcje#start', aktualnosci: 'aktualnosci' };
  if (!base) SECTIONS.hammershop = 'hammershop'; // a page of Hammer Launcher's own site only
  var target = Object.prototype.hasOwnProperty.call(SECTIONS, location.hash.slice(1)) ? SECTIONS[location.hash.slice(1)] : null;
  var query = location.search;
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
