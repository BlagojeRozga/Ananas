/* ---------- PripremaOdgovora (chat_v4 — GPT-5.4, prosta verzija) ----------
   Jedini posao: pretvori tekst modela u HTML za čet. Nikakva logika, nikakve
   lestvice, nikakav „tool wins" — model je već napisao ceo odgovor.
     0. normalizuj obeleživač liste na početku reda (—/–/• -> -)
     1. escape (&, <, >)   2. linkuj URL-ove   3. **masno** -> <b>masno</b>
     4. podebljaj brojeve porudžbina   5. novi red -> <br>
   Wrap-up NE radi ovaj čvor — postavlja ga `AnanasBazaZnanja` (native, iz
   Workflowdata) tokom svog izvršavanja. Intent takođe NE dira (v. dole) —
   ovde se samo formatira poruka. */

/* ---------- Podešavanje ---------- */
// Poruka koju šaljemo stranom (engleskom) kupcu kada je podrška zatvorena
// (umesto slanja u zatvoren agentski red). Menjaj ovde.
const PORUKA_VAN_RADNOG_VREMENA = 'Our customer support is currently offline. Our working hours start at 8 AM.';
// Srpska poruka kada je podrška zatvorena a model ipak najavi transfer (v. fallback dole).
// Preuzeto iz prompta (pravilo o radnom vremenu) — činjenica: podrška ne radi, vraća se u 8h.
const PORUKA_VAN_RADNOG_VREMENA_SR = 'Naš tim za podršku trenutno ne radi. Radno vreme počinje već od 8 ujutru.';
// Poruka kada je model umesto odgovora ispisao SIROV JSON (v. „zaštita“ dole).
// Registar „ti“, bez emodžija, bez objašnjavanja šta se tehnički desilo.
const PORUKA_TEHNICKA_GRESKA = 'Izvini, došlo je do tehničke greške pri pripremi odgovora. Možeš li da ponoviš pitanje?';
// Koliko proze mora da ostane posle odbačenog JSON-a da bi se poruka spasla
// umesto da se cela zameni. Kraće od ovoga nije odgovor, nego ostatak.
const OSTATAK_MIN = 40;

/* Odgovor modela se čita iz istorije poruka (isto kao 4.1 PripremaOdgovora):
   poslednja poruka agenta (role „ai", name „Ananas"). NE iz $variables — tamo ga
   nema, pa je odgovor izlazio prazan. */
const messages = ($utilities.executionState && $utilities.executionState.messages) || [];
const lastAgent = [...messages].reverse().find(m => m.role === 'ai' && m.name === 'Ananas')
  || [...messages].reverse().find(m => m.role === 'ai');
let ulaz = (lastAgent && lastAgent.content && lastAgent.content[0] && lastAgent.content[0].text) || '';
ulaz = String(ulaz).replace(/\s+$/, '').trim();

/* ---------- ZAŠTITA: sirov JSON umesto odgovora ----------
   Model povremeno ISPIŠE poziv alata kao tekst umesto da ga pozove — tada kupcu
   ode `{"query":"…","wrapup":"…"}`. Ovaj čvor je poslednja tačka pre kupca i
   jedini koji uopšte može da pogleda OBLIK teksta (ostali koraci gledaju samo
   `**`, linkove i crte), pa provera stoji ovde.

   Hvataju se dva oblika: (1) CELA poruka je JSON; (2) poruka POČINJE JSON-om pa
   sledi proza — tada se odbacuje samo JSON deo. JSON u SREDINI teksta se NE dira:
   lažni pogodak na urednom odgovoru je gori od propuštenog retkog kvara.
   Sve u try/catch — svaka greška ovde mora da padne na nepromenjen tekst. */
const JSON_OGRADA_POCETAK = /^\s*```(?:json)?\s*/i;
const JSON_OGRADA_KRAJ = /\s*```\s*$/;

/* Kraj JSON vrednosti koja počinje na indeksu 0 (poštuje navodnike i escape).
   Vraća indeks IZA zatvarajuće zagrade, ili -1 ako se nikad ne zatvori. */
function krajJsona(s) {
  const otvara = s.charAt(0);
  if (otvara !== '{' && otvara !== '[') return -1;
  const zatvara = otvara === '{' ? '}' : ']';
  let dubina = 0, uNizu = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const z = s.charAt(i);
    if (escape) { escape = false; continue; }
    if (z === '\\') { escape = true; continue; }
    if (z === '"') { uNizu = !uNizu; continue; }
    if (uNizu) continue;
    if (z === otvara) dubina++;
    else if (z === zatvara) { dubina--; if (dubina === 0) return i + 1; }
  }
  return -1;
}

/* „Liči na poziv alata": počinje zagradom, zagrada se zatvara, i unutra postoji
   ključ u navodnicima (`"query":`). Rečenica koja slučajno počne zagradom nema
   taj oblik, pa ne pada pod ovo pravilo. */
function jsonNaPocetku(t) {
  const s = String(t || '').trim()
    .replace(JSON_OGRADA_POCETAK, '').replace(JSON_OGRADA_KRAJ, '').trim();
  const kraj = krajJsona(s);
  if (kraj < 0) return null;
  const glava = s.slice(0, kraj);
  if (!/"\s*:/.test(glava)) return null;
  return { glava: glava, ostatak: s.slice(kraj).trim() };
}

try {
  const nalaz = jsonNaPocetku(ulaz);
  if (nalaz) {
    ulaz = (nalaz.ostatak.length >= OSTATAK_MIN) ? nalaz.ostatak : PORUKA_TEHNICKA_GRESKA;
    // Zastavica za merenje: koliko puta se desilo i šta je tačno bilo ispisano.
    try { $utilities.executionState.set('output', 'sirovJson', 'da'); } catch (e) { /* ignore */ }
    try { $utilities.executionState.set('output', 'sirovJsonTekst', nalaz.glava.slice(0, 300)); } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore — tekst ostaje nepromenjen */ }

/* Broj porudžbine se podebljava (npr. WZ5L3-E63J4-DS-1). Ne diramo ono što je već
   u <b>…</b> (model ga je sam podebljao sa **), da ne bude dvostruko. */
const ID_PORUDZBINE = /\b[A-Z0-9]{5,6}-[A-Z0-9]{5,6}(?:-[A-Z]{2,3}-\d+)?\b/g;
function podebljajBrojeve(html) {
  return String(html).split(/(<b>[\s\S]*?<\/b>)/).map(deo => {
    if (deo.indexOf('<b>') === 0) return deo;             // već podebljano
    return deo.replace(ID_PORUDZBINE, m => (/\d/.test(m) ? `<b>${m}</b>` : m));
  }).join('');
}

function uHtml(text) {
  let s = String(text || '');
  // 0. sve duge crte -> hyphen: prvo obeleživač liste na POČETKU reda (—/–/• -> "- "),
  //    pa SVE preostale em/en crte (separator u stavkama „BROJ — status", crte u prozi) -> "-".
  //    Razmaci oko „ — " se čuvaju („ - "); brojevi porudžbina i datumi su već hyphen, ne diraju se.
  s = s.replace(/(^|\r?\n)([ \t]*)[—–•][ \t]*/g, '$1$2- ');
  s = s.replace(/[—–]/g, '-');
  // 1. escape
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 2. linkovi (pre bolda; escape ne dira URL). URL se zaustavlja i na `*`, da
  //    okolni `**` (model podebljao link) ne uđe u href i ne pokvari ga.
  s = s.replace(/(https?:\/\/[^\s<*]+)/g, '<a href="$1">$1</a>');
  // 3. **masno** -> <b>masno</b>, ali SAMO kratak segment (ključan podatak/izraz);
  //    bold koji prelazi granicu rečenice (cela rečenica / gotova rečenica alata) ili
  //    je predugačak se NE boldira — skida se ** i ostaje čist tekst. Model bira KOJI
  //    segment (jedna ili više reči); kod samo sprečava „bold celog pasusa".
  s = s.replace(/\*\*([^*]+)\*\*/g, (m, x) => {
    const preko = /[.!?]\s+[A-ZŠĐČĆŽ„]/.test(x);     // prelazi granicu rečenice
    const dugo  = x.trim().split(/\s+/).length > 12; // rezerva za razvučen ceo iskaz
    return (preko || dugo) ? x : `<b>${x}</b>`;
  });
  s = s.replace(/\*\*/g, '');
  // 4. brojevi porudžbina -> <b> (van već postojećih <b>…</b>)
  s = podebljajBrojeve(s);
  // 5. novi red -> <br>
  s = s.replace(/\r?\n/g, '<br>');
  return s;
}

let html = uHtml(ulaz);
let izlazTekst = ulaz;

/* INTENT ovaj čvor po pravilu NE dira — prosleđivanje agentu odlučuje alat
   `TransferAgent`. JEDINI izuzetak je USKA provera dole: ENGLESKI TRANSFER + ZATVORENA
   PODRŠKA. Strani transfer prepoznajemo REGEXOM nad botovom porukom (engleski transfer
   na agenta — jedini transfer koji ide na engleskom), radno vreme čitamo iz TRANSIENT
   (`workingHours`, postavlja `RadnoVreme` u istom izvršenju). Ako je oboje, ne šaljemo
   kupca u zatvoren agentski red: zamenimo poruku engleskim obaveštenjem o radnom vremenu
   i poništimo transfer. Sve u try/catch — bezbedan pad na normalno ponašanje. */
function citaj(scope, key) {
  try { return $utilities.executionState.get(scope, key); } catch (e) { return undefined; }
}
/* Zatvoreno? Čitamo `workingHours` iz TRANSIENT (RadnoVreme ga upiše u ISTO izvršenje,
   pa je čitljiv OVOG poteza — za razliku od `session`, koji se vidi tek sledeći potez),
   pa iz `$variables`. Radno vreme se NE računa ovde — jedini izvor je RadnoVreme. Ako je
   vrednost prazna/nečitljiva, tretiramo kao NE-zatvoreno (bezbedan pad: normalan transfer). */
function zatvorenaPodrska() {
  const wh = String(
    citaj('transient', 'workingHours') ||
    (typeof $variables !== 'undefined' && $variables.workingHours) || ''
  ).toLowerCase();
  return wh !== '' && wh !== 'open';
}
/* Engleska poruka o agentu/podršci: pominje agent/support i NEMA srpskih slova
   (č/ć/ž/š/đ). Bot na engleskom piše SAMO kod stranog transfera, pa svaka engleska
   poruka koja pominje agent/support (npr. „…connecting you to support agent",
   „Our support agent will help you shortly") je transfer na stranom jeziku. Srpski
   transfer „Preusmeravam te na agenta podrške…" ima srpska slova, pa ga ne hvatamo. */
function engleskiTransfer(t) {
  return /\b(agent|support)\b/i.test(t)
    && !/[čćžšđČĆŽŠĐ]/.test(t);
}
/* SRPSKA najava transfera: deklarativna (sadašnje vreme, 1. lice) — „Preusmeravam/
   Prebacujem/Povezujem/Spajam/Prosleđujem te … agent". NIJE ponuda („mogu da te
   povežem", „ako želiš") ni pitanje. Stem-based, da pokrije nastavke. */
function srpskiTransferNajava(t) {
  const s = String(t || '').toLowerCase();
  const najava = /(preusmeravam|prebacujem|povezujem|spajam|prosle[dđ]ujem)\s+te\b/.test(s)
    && /\bagent/.test(s);
  const ponuda = /\bmogu\b|ako želiš|da li želiš|\?/.test(s);
  return najava && !ponuda;
}
/* Da li je TransferAgent VEĆ postavio transfer ovog poteza (piše transient.agent_transfer)? */
function transferVecPostavljen() {
  const v = citaj('transient', 'agent_transfer');
  return v === true || v === 'true';
}
try {
  if (engleskiTransfer(ulaz) && zatvorenaPodrska()) {
    // (1) ENGLESKI transfer + ZATVORENO -> engleska poruka o radnom vremenu, poništi transfer.
    izlazTekst = PORUKA_VAN_RADNOG_VREMENA;
    html = uHtml(izlazTekst);
    try { $utilities.executionState.set('output', 'intent', 'general_conversation'); } catch (e) { /* ignore */ }
    try { $utilities.executionState.set('transient', 'agent_transfer', false); } catch (e) { /* ignore */ }
  } else if (srpskiTransferNajava(ulaz) && zatvorenaPodrska()) {
    // (2) SRPSKA najava transfera + ZATVORENO -> srpska poruka o radnom vremenu, poništi transfer.
    //     Poništava i ako je model IPAK pozvao TransferAgent — u zatvoreno se NE prebacuje.
    izlazTekst = PORUKA_VAN_RADNOG_VREMENA_SR;
    html = uHtml(izlazTekst);
    try { $utilities.executionState.set('output', 'intent', 'general_conversation'); } catch (e) { /* ignore */ }
    try { $utilities.executionState.set('transient', 'agent_transfer', false); } catch (e) { /* ignore */ }
  } else if (srpskiTransferNajava(ulaz) && !transferVecPostavljen()) {
    // (3) FALLBACK (OTVORENO): model je NAJAVIO srpski transfer ali NIJE pozvao TransferAgent
    //     -> forsiraj transfer da najava i stvarnost budu iste. Tekst modela se NE dira.
    try { $utilities.executionState.set('output', 'intent', 'agent_transfer'); } catch (e) { /* ignore */ }
    try { $utilities.executionState.set('transient', 'agent_transfer', true); } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore */ }

try {
  $utilities.executionState.addMessage('output', {
    name: 'Ana', role: 'ai', content: [{ type: 'text', text: html }]
  });
} catch (e) { /* ignore */ }

return { actionCallResponse: { result: izlazTekst } };
