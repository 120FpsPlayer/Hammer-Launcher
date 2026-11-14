'use strict';

/**
 * Does a ticket message ask for a real person? The AI assistant's safety net: when it does, the bot calls the team
 * itself – without asking the model – and the assistant goes quiet in that ticket.
 *
 * Catches the usual ways to say it, with or without Polish letters: „chcę rozmawiać z człowiekiem”, „prawdziwa osoba”,
 * „ktoś z zespołu”, „zawołaj admina”, „potrzebuję moderatora”, a bare „admin” / „administracja”… A word like „admin”
 * counts only right after a request for that person (or in a very short message), so „jak zostać adminem?”, „mój kolega
 * jest adminem… gdzie go znajdę?” or „człowieku, nie działa mi launcher” don't call anyone.
 */

const fold = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9\s?!.,+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Words that may stand between a request and whom it is for: „zawołaj TU admina”, „potrzebuję POMOCY OD admina”.
const FILLER = '(?: (?:mi|tu|tutaj|jakis|jakiegos|jakas|jakiejs|kogos|ktos|ktoregos|z|ze|do|od|sie|pomocy|pomoc|prosze|szybko|pilnie))*';
/** How people ask for someone – the request itself, right before whom it is for. */
const ASK =
  '(?:chce|chcialbym|chcialabym|wolalbym|wolalabym|potrzebuje|potrzebny|potrzebna|potrzebujemy|poprosze|prosze o|prosze|daj|dajcie|zawolaj\\w*|zawolac|wezwij\\w*|wezwac|wolam|wolac|szukam|' +
  'niech|gdzie jest|gdzie sa|czy jest|czy sa|jest tu|jest ktos|rozmawiac z|porozmawiac z|pogadac z|gadac z|pisac z|napisac do|napisze do|kontakt z|kontaktu z|przekaz\\w*|polacz\\w* z|polaczyc z)';
/** Whom they may ask for (any case of the word). */
const ROLE = '(?:admin\\w*|administrac\\w*|administrator\\w*|moderator\\w*|moderac\\w*|moda|modow|wlasciciel\\w*|ceo|owner\\w*|staff\\w*|zespol\\w*|support\\w*|obslug\\w*|ekip\\w*)';
/** „Admin mi pomoże?”, „niech ktoś z zespołu odpisze” – the role first, then what they should do. */
const ACT = '(?:pomoze|pomozecie|pomozcie|pomoz|odpisze|odpiszcie|odezwie|odezwijcie|przyjdzie|zajrzy|sprawdzi|zobaczy)';

/** On their own they mean "a person, please". „Człowiek” counts only as the one asked for – not „człowieku” (slang) or „jestem człowiekiem”. */
const STRONG = [
  /\b(z|ze) (prawdziwym |zywym |normalnym |jakims )?czlowiekiem\b/,
  /\b(prawdziw\w*|zyw\w*) (osob\w*|ludz\w*|czlowiek(a|iem)?\b|admin\w*|pracownik\w*|konsultant\w*|support\w*)/,
  new RegExp(`\\b${ASK}${FILLER} (czlowieka|czlowiek|osoby|osobe|ludzi)\\b`),
  /\b(ktos|kogos|kims|ktokolwiek) (z|ze) (zespolu|ekipy|administracji|supportu|obslugi|teamu|staffu|moderacji|wlascicieli)/,
  /\b(kogos|ktos|kims) (prawdziw\w*|zyw\w*|normaln\w*)/,
  /\b(rozmawiac|porozmawiac|pogadac|gadac|pisac|napisac|kontakt\w*) (z|ze) (admin\w*|moderator\w*|modem|wlasciciel\w*|zespol\w*|supportem|obsluga|osoba|kims|ceo|ownerem|staffem|ekipa|pracownikiem)/,
  /\bnie (chce|bede|zamierzam) (rozmawiac|gadac|pisac) (z|ze) (bot\w*|ai|sztuczn\w*|automat\w*|maszyn\w*)/,
  /\bnie (z|ze) (botem|ai|automatem|maszyna)\b/,
  /\b(chce|chcialbym|chcialabym|prosze o|poprosze o|potrzebuje) (rozmow\w*|kontakt\w*) (z|ze) /,
  /\b(talk|speak|chat) (to|with) (a |an )?(human|person|real|admin|staff|moderator|someone)/,
  /\breal (person|human)\b|\bhuman please\b/,
  new RegExp(`\\b${ASK}${FILLER} ${ROLE}\\b`), // „zawołaj admina”, „potrzebuję pomocy od moderatora”, „gdzie jest administracja”
  new RegExp(`\\b${ROLE}(?: (?:mi|tu|tutaj|sie|w koncu))* ${ACT}\\b`), // „czy admin mi pomoże?”
];

/** true when the message asks for a person from the team. */
function asksForHuman(text) {
  const t = fold(text).replace(/[?!.,]+/g, (m) => (m.includes(',') || m.includes('.') ? ' , ' : ' ')).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (STRONG.some((re) => re.test(t))) return true;
  // A very short message that is just the call: „człowiek”, „ADMIN!!”, „administracja pls” – not a question about it.
  const words = t.split(' ').filter((w) => /[a-z0-9]/.test(w));
  if (words.length > 3 || /\b(jak|kto|kim|kiedy|ile|czemu|dlaczego|zostac|zostane|byc|bycia|jestem|jestes|dzieki|dziekuje|dziekujemy|thx|thanks)\b/.test(t)) return false;
  return /\b(czlowiek|czlowieka)\b/.test(t) || new RegExp(`\\b${ROLE}\\b`).test(t);
}

module.exports = { asksForHuman, fold };
