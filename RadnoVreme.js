/* ------------------------------------------------------------------------
   RadnoVreme (v3) — JS „Executor" čvor IZMEĐU Start i Tools Calling Agent.

   Računa da li podrška TRENUTNO radi, na SVAKOM potezu, iz tekućeg vremena
   (Europe/Belgrade). Ne oslanja se na Genesys (radno vreme se NE prosleđuje) —
   jer bi vrednost stampovana na ulazu bila zastarela: kupac koji dođe u 19:55
   i nastavi posle 20:00 bio bi i dalje „Open" i slao bi se u zatvoren red.

   Rezultat: session `workingHours` (Open|Closed) i `ccRadi` ('1' samo za Open);
   vraćeni `workingHours` prompt čita kao `{workingHours}`. Start izlaz se prosleđuje.
   ======================================================================== */

/* ============ PODEŠAVANJA — UREDI OVDE ============
   Radno vreme podrške po danu. Format „HH:MM". Za neradni dan stavi null.
   (Menjaš samo ovaj blok kada se promeni radno vreme; logika ispod se ne dira.) */
const RADNO_VREME = {
  ponedeljak: { od: '08:00', do: '20:00' },
  utorak:     { od: '08:00', do: '20:00' },
  sreda:      { od: '08:00', do: '20:00' },
  cetvrtak:   { od: '08:00', do: '20:00' },
  petak:      { od: '08:00', do: '20:00' },
  subota:     { od: '08:00', do: '18:00' },
  nedelja:    { od: '08:00', do: '18:00' }
};

/* Državni praznici (neradni dani), format „YYYY-MM-DD", vreme Beograda.
   ODRŽAVATI PO GODINAMA — posebno pomične pravoslavne praznike (Vaskrs).
   2026 (pomični: Veliki petak 10.4, Vaskrs 12.4, Uskršnji ponedeljak 13.4 — proveriti): */
const PRAZNICI = [
  '2026-01-01', '2026-01-02', // Nova godina
  '2026-01-07',               // Božić
  '2026-02-15', '2026-02-16', // Sretenje / Dan državnosti
  '2026-04-10', '2026-04-12', '2026-04-13', // Veliki petak, Vaskrs, Uskršnji ponedeljak
  '2026-05-01', '2026-05-02', // Praznik rada
  '2026-11-11'                // Dan primirja
];
/* ================================================== */

function pp(k, v) { try { $utilities.executionState.set('output', 'pp_' + k, String(v)); } catch (e) { /* ignore */ } }
function uMinute(s) { const d = String(s || '').split(':'); return (parseInt(d[0], 10) || 0) * 60 + (parseInt(d[1], 10) || 0); }

const DANI = { Mon: 'ponedeljak', Tue: 'utorak', Wed: 'sreda', Thu: 'cetvrtak', Fri: 'petak', Sat: 'subota', Sun: 'nedelja' };

// Tekuće vreme u Beogradu, razloženo na delove
const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
}).formatToParts(new Date()).reduce((o, p) => { o[p.type] = p.value; return o; }, {});

const datum = `${parts.year}-${parts.month}-${parts.day}`;   // YYYY-MM-DD
const minuti = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
const dan = DANI[parts.weekday];
const praznik = new Set(PRAZNICI).has(datum);

const cfg = RADNO_VREME[dan];
let izracunato = 'Closed';
if (cfg && !praznik && minuti >= uMinute(cfg.od) && minuti < uMinute(cfg.do)) izracunato = 'Open';

// Test-override (harness/ručno): ako je prosleđen `TestWorkingHours`, koristi njega umesto sata.
const forsirano = (typeof $variables === 'object' && $variables && $variables.TestWorkingHours)
  ? String($variables.TestWorkingHours).trim() : '';
const workingHours = forsirano || izracunato;
const radi = (workingHours.toLowerCase() === 'open');

pp('now', `${datum} ${parts.hour}:${parts.minute} ${dan}`);
pp('praznik', praznik);
pp('workingHours', workingHours);
pp('ccRadi', radi ? '1' : '0');

try {
  $utilities.executionState.set('session', 'workingHours', workingHours);
  $utilities.executionState.set('session', 'ccRadi', radi ? '1' : '0');
} catch (e) { /* ignore */ }

/* I u TRANSIENT (isto izvršenje) — da ga `PripremaOdgovora` može pročitati OVOG poteza:
   session se vidi tek sledeći potez, transient je signal unutar istog izvršenja. */
try {
  $utilities.executionState.set('transient', 'workingHours', workingHours);
} catch (e) { /* ignore */ }

const prosledi = (typeof $variables === 'object' && $variables) ? $variables : {};
return Object.assign({}, prosledi, { workingHours: workingHours, ccRadi: radi });
