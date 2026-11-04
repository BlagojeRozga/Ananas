const { vectorStore, executionState } = $utilities;
const { query, wrapup } = $variables;

/* ---------- AnanasBazaZnanja (merged-per-wrap-up, GPT-5.4) ----------
   Baza je spojena u ~30 tema-klastera, JEDAN po wrap-up kodu (kb/Ananas_v2_5_4.json).
   Svaki klaster: pageContent = SVE formulacije te teme (ovo se embeduje/pretrazuje),
   metadata.answer = SVI odgovori te teme spojeni (ovo model cita), metadata.wrapup =
   wrap-up kod (i identitet i native wrap-up). Odgovori oznaceni za agenta su izdvojeni
   u zaseban '· ask'/'· force' chunk (metadata.forceToAgent/askForAgent).

   Filozofija: retrieval je backup, klasifikacija je primarna. Model kroz `wrapup`
   (enum od ~30 kodova) imenuje temu; kod GARANTUJE da taj klaster ude u kontekst,
   plus doda najblize vektorski. Zato promasaj skoro nemoguc. Broj klastera je fiksan
   (~30), pa se KOLIKO nikad ne pre-stimuje kad se dodaje sadrzaj. */

const KB_KOLEKCIJA = 'Ananas_v3';   // jedino mesto za izmenu (npr. na produ)
const KOLIKO = 10;     // koliko klastera vratiti modelu (uz zagarantovan model-ov `wrapup`).
                       //   Izmereno (rang_sweep, 20 tema): NAJDUBLJI potreban klaster je rang #7
                       //   („otkazivanje" i „rok isporuke" — zakopani u velikim klasterima). Nista 8+.
                       //   Zato 10 = najgori slucaj (7) + margina 2-3, bezbedno i jeftinije od 15/40.
                       //   Distanca ne valja kao prag (ti #7 su na ~0.47 > 0.4) — biramo po BROJU.
                       //   `kbRang` debug ispisuje pun rang sa rastojanjima (za dalje pracenje).
const SVIH = 50;       // povuci sve klastere (~30) da `wrapup` bude zagarantovano dostupan

/* Cirilica u upitu -> srpska latinica SA kvacicama (baza je latinica; cirilicni
   upit inace dobija losija rastojanja). Kvacice se zadrzavaju (ć/č/š) da upit
   izgleda kao tekst u bazi. */
const CIRILICA_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'đ', 'е': 'e',
  'ж': 'ž', 'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj',
  'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's',
  'т': 't', 'ћ': 'ć', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'č',
  'џ': 'dž', 'ш': 'š'
};
function presloviUpit(s) {
  let out = '';
  for (const z of String(s || '')) {
    const malo = z.toLowerCase();
    const lat = CIRILICA_LAT[malo];
    if (lat === undefined) { out += z; continue; }
    out += (z === malo ? lat : lat.charAt(0).toUpperCase() + lat.slice(1));
  }
  return out;
}

const upit = presloviUpit(query || '');
const wrapTrazen = String(wrapup || '').trim();

/* Povuci SVE klastere rangirane po relevantnosti (ima ih ~30, jeftino) — tako je
   `wrapup` klaster uvek medu rezultatima pa moze da se zagarantuje. */
const hits = await vectorStore.findSimilar({
  collectionName: KB_KOLEKCIJA,
  query: upit,
  searchOptions: { limit: SVIH, distanceType: 'Cosine' },
});

function wrapupOd(r) {
  /* Wrap-up kod reda. U serviranoj `Ananas_v3` kolekciji svaki red ima
     `metadata.wrapup`; `documentId` (== isti kod, uz mogući ' · ask/force'
     sufiks) je backstop. Stari ključevi `tema`/`wrap-up1` uklonjeni 27 Aug —
     ne postoje u `Ananas_v3` (spoji_po_wrapup.py ih preimenuje u `wrapup`). */
  const m = (r && r.metadata) || {};
  return m.wrapup || r.documentId || '';
}
function kljucOd(r) {
  /* jedinstven po chunku (ne po wrapup-u) — normalan i '· ask'/'· force' chunk
     istog wrapup-a moraju oba da mogu u kontekst, pa dedup ide po documentId. */
  return (r && r.documentId) || wrapupOd(r);
}
function odgovorOd(r) {
  const m = (r && r.metadata) || {};
  return m.answer || r.pageContent || '';
}
function transferMod(r) {
  const m = (r && r.metadata) || {};
  return m.forceToAgent === true ? 'force' : (m.askForAgent === true ? 'ask' : '');
}

/* Izbor: prvo zagarantovan NORMALAN klaster za modelov wrapup (documentId ===
   wrapup, bez ' · ask/force' sufiksa), pa najblizi vektorski, dedup po documentId,
   do KOLIKO. Transfer chunk ude sam ako je vektorski blizu (kupac ga je pogodio). */
const izabrani = [];
const vidjeno = new Set();
function dodaj(r) {
  const k = kljucOd(r);
  if (!k || vidjeno.has(k)) return;
  vidjeno.add(k);
  izabrani.push(r);
}
if (wrapTrazen) {
  const pogodjen = hits.find(r => r.documentId === wrapTrazen);
  if (pogodjen) dodaj(pogodjen);
}
for (const r of hits) {
  if (izabrani.length >= KOLIKO) break;
  dodaj(r);
}

/* Prebacivanje na agenta: NATIVE, po VEKTORSKOJ blizini — pali se SAMO ako je
   NAJBLIZI pogodak (hits[0]) chunk sa zastavicom I dovoljno blizu (kupac je pogodio
   bas te formulacije). Prag je stroziji od znanja (0.4) jer je transfer skup: labav
   pogodak („promena adrese" ~ „promena broja telefona") ne sme da prebaci. Ne pali
   se po modelovom `wrapup` (da imenovanje teme ne bi samo od sebe prebacivalo). */
const PRAG_TRANSFER = 0.3;
const najblizi = hits[0];
const dist = (najblizi && typeof najblizi.distance === 'number') ? najblizi.distance : Infinity;
const mod = (najblizi && dist < PRAG_TRANSFER) ? transferMod(najblizi) : '';

/* Wrap-up: wrapup koji je model naznacio (ako je stvarno naden), inace najblizi. */
const wrapKod = (wrapTrazen && vidjeno.has(wrapTrazen))
  ? wrapTrazen
  : (izabrani[0] ? wrapupOd(izabrani[0]) : '');
/* Genesys očekuje "intent|wrapup" (deli GraiaUUI po '|') — kao v2. Intent uzimamo
   iz metapodataka baš tog klastera; ako intenta nema, šalje se samo wrapup. */
const klasterWrap = izabrani.find(r => wrapupOd(r) === wrapKod)
  || hits.find(r => wrapupOd(r) === wrapKod) || izabrani[0];
const intentKod = (klasterWrap && klasterWrap.metadata && klasterWrap.metadata.intent) || '';
const wrapupCode = [intentKod, wrapKod].filter(Boolean).join('|');
try {
  if (wrapupCode) executionState.set('output', 'wrapup-code', wrapupCode);
  executionState.set('output', 'kbTeme', izabrani.map(wrapupOd).join(' | '));
  // DIJAGNOSTIKA: pun rang svih klastera sa rastojanjima — da vidimo koji KOLIKO je dovoljan
  executionState.set('output', 'kbRang', hits.map((r, i) =>
    `${i + 1}.${wrapupOd(r)}#${(typeof r.distance === 'number' ? r.distance : 0).toFixed(3)}`).join(' | '));
  executionState.set('output', 'kbUpit', String(upit || ''));
  executionState.set('output', 'kbTransfer', mod);      // '', 'ask' ili 'force' (za trag/izvestaj)
  executionState.set('transient', 'kbPozvan', '1');
} catch (e) { /* ignore */ }

/* Radno vreme: RadnoVreme upiše transient `workingHours` (Open|Closed) pre agenta.
   Kada je ZATVORENO, ⟦AGENT⟧ marker se NE prosleđuje — pravilo o radnom vremenu je IZNAD
   KB force/ask zastavice; bez ovoga bi bot nudio/prebacivao agenta van radnog vremena, što
   ne sme (sesija 82efb903: ananas_81 „ask" ponudio agenta u 03h). */
let radnoVreme = '';
try { radnoVreme = String(executionState.get('transient', 'workingHours') || '').trim(); } catch (e) { /* ignore */ }
if (!radnoVreme) { try { radnoVreme = String(($variables && $variables.workingHours) || '').trim(); } catch (e) { /* ignore */ } }
const zatvoreno = radnoVreme.toLowerCase() === 'closed';
try { executionState.set('output', 'kbTransferZatvoreno', zatvoreno ? '1' : '0'); } catch (e) { /* ignore */ }

/* Modelu se salju SAMO tekstovi odgovora izabranih tema. Ako je najblizi pogodak oznacen
   za agenta I radno vreme je OTVORENO, prvi element je marker ⟦AGENT: ask|force⟧. */
const tekstovi = izabrani.map(odgovorOd).filter(Boolean);
if (mod && !zatvoreno) tekstovi.unshift('⟦AGENT: ' + mod + '⟧');
return tekstovi;
