/* ---------- StatusPosiljke (GPT-5.4, PROSTA verzija — v3 stil, 22.8.2026) ----------
   Odluka korisnika: NE odlucuje kod, NE pretrazuje kod. Alat povuce SVE kupceve
   porudzbine iz poslednjih 180 dana i vrati ih kao citljiv tekst (broj, stanje,
   razlog otkazivanja, artikli, rok isporuke, placanje). MODEL dobija sve u kontekst
   i sam bira o kojoj porudzbini kupac govori — po broju, poziciji („prva/treca"),
   nazivu artikla („patike"), stanju, „poslednjoj" itd. Nema lestvice, nema pretrage,
   nema „vidim samo poslednjih 5". Od 9.9.2026 API vraca i `createdAt` (datum/vreme
   PORUCIVANJA — order i suborder nivo): prikazujemo ga kao „Kreirana", po njemu
   sortiramo/filtriramo prozor, pa „iz jula/juce/poslednja" model SADA moze tacno.
   Dodati i `deliveryMethod` (-> „Nacin isporuke") i `isAnanasPlus` (-> „Ananas+").
   Sporna isporuka (tvrdi da nije stiglo a stanje je „isporučena") -> resava PROMPT
   (ponuda agenta), model to vidi iz statusa. Identitet/auth kao pre.            */
const axios = require('axios');

const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
const ENV = runtimeEnv.ANANAS_ENV || 'prod'; // 'qa' | 'qa2' | 'prod'
const HTTP_TIMEOUT = 8000;
const TEST_CUSTOMER_ID = '';    // PRE PUSTANJA U RAD OSTAVITI PRAZAN
const PROZOR_DANA = 180;        // koliko unazad se gledaju porudzbine (po roku isporuke)

function requiredEnv(name) {
  const value = runtimeEnv[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const GENESYS = {
  tokenUrl: 'https://login.mypurecloud.de/oauth/token',
  apiBase:  'https://api.mypurecloud.de/api/v2',
  clientId: '244b5a1d-8b52-4078-958f-0e2e131e00f4',
  secret:   requiredEnv('GENESYS_CLIENT_SECRET')
};
const ANANAS_ENVS = {
  qa:   { base: 'https://api.svc.qa.ananastest.com', clientId: '4pcncro5jt4ied02m3uvgkbip', secretEnv: 'ANANAS_QA_CLIENT_SECRET' },
  qa2:  { base: 'https://api.svc.qa.ananastest.com', clientId: '3p41opkk2ih90t381bo22t889f', secretEnv: 'ANANAS_QA2_CLIENT_SECRET' },
  prod: { base: 'https://api.svc.ananas.rs',         clientId: '69mlak9lq5cmonokkaqmn16jj2', secretEnv: 'ANANAS_PROD_CLIENT_SECRET' }
};
const ananasConfig = ANANAS_ENVS[ENV];
if (!ananasConfig) throw new Error(`Unsupported ANANAS_ENV: ${ENV}`);
const ANANAS = { ...ananasConfig, secret: requiredEnv(ananasConfig.secretEnv) };

const PORUKA_GRESKA = 'Trenutno ne mogu da pristupim podacima o porudžbinama. Molim te pokušaj za nekoliko minuta.';
const PORUKA_PRAZNO = 'Trenutno ne vidim nijednu porudžbinu na tvom nalogu.';
const PORUKA_NEPOZNAT_NALOG =
`Interno (ne pokazuješ kupcu): nalog ovog kupca ne može da se poveže sa sistemom porudžbina.
Ovo NIJE privremena smetnja i ponovni pokušaj neće pomoći — zato kupcu NE govoriš da pokuša
ponovo za nekoliko minuta, niti da sačeka.
Kratko se izviniš, kažeš da trenutno ne možeš da vidiš njegove porudžbine, i ponudiš mu agenta
podrške (prebacuješ tek na „da“). Ako podrška ne radi, agenta ne nudiš — važi pravilo o radnom vremenu.
Ne pominješ tehničke razloge, prijavu, nalog preko Google-a ili Facebook-a, niti bilo kakav ID.
Ako kupac pita nešto opšte o porudžbinama, na to normalno odgovaraš iz baze znanja.`;

function dbg(k, v) { try { $utilities.executionState.set('output', 'sp_' + k, String(v)); } catch (e) { /* ignore */ } }

/* ---------- IDENTITET + TOKEN ---------- */
function readCustomerIdOverride() {
  const k = [TEST_CUSTOMER_ID, $variables?.TestCustomerID, $variables?.testCustomerId, $variables?.CustomerID];
  for (const v of k) if (typeof v === 'string' && v.trim().length === 36) return v.trim();
  return null;
}
async function getGenesysCustomerId(conversationId) {
  const tok = await axios.post(GENESYS.tokenUrl, 'grant_type=client_credentials',
    { auth: { username: GENESYS.clientId, password: GENESYS.secret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: HTTP_TIMEOUT });
  const conv = await axios.get(`${GENESYS.apiBase}/conversations/${conversationId}`,
    { headers: { Authorization: `Bearer ${tok.data.access_token}` }, timeout: HTTP_TIMEOUT });
  return conv.data?.participants?.[0]?.attributes?.CustomerID || null;
}
async function getAnanasToken() {
  const res = await axios.post(`${ANANAS.base}/iam/api/v1/auth/token`,
    { clientId: ANANAS.clientId, clientSecret: ANANAS.secret, grantType: 'CLIENT_CREDENTIALS', scope: 'order/AI_DATA_VIEWER' },
    { headers: { 'Content-Type': 'application/json' }, timeout: HTTP_TIMEOUT });
  return res.data.access_token || res.data.token;
}

/* ---------- STANJE / PLACANJE / OTKAZ -> citljiv srpski (nikad sirov kod) ---------- */
const STANJE = {
  CREATED: 'kreirana, u obradi', CONFIRMED: 'potvrđena, u obradi',
  PARTIALLY_CONFIRMED: 'delimično potvrđena, u obradi', AWAITING_PAYMENT: 'neplaćena, čeka uplatu',
  PACKING_INITIATED: 'u pripremi za slanje (pakovanje)', PACKED: 'spakovana', PARTIALLY_PACKED: 'delimično spakovana',
  PACKED_IN_TRANSIT: 'spakovana, u transportu', PARTIALLY_PACKED_IN_TRANSIT: 'delimično spakovana, u transportu',
  PACKED_ON_THE_BORDER: 'spakovana, na carini', PARTIALLY_PACKED_ON_THE_BORDER: 'delimično spakovana, na carini',
  COLLECTED: 'u transportu, kod kurira', COLLECTED_LOCKER: 'u transportu, kod kurira', COLLECTED_PUDO: 'u transportu, kod kurira',
  ON_DELIVERY: 'na isporuci (kurir je nosi)', ON_DELIVERY_LOCKER: 'na isporuci', ON_DELIVERY_PUDO: 'na isporuci',
  DELIVERED_LOCKER: 'u paketomatu, čeka preuzimanje', DELIVERED_PUDO: 'u paket zoni, čeka preuzimanje',
  READY_FOR_COLLECTION: 'spremna za preuzimanje', SHIPMENT_IS_IN_POSTA: 'u pošti',
  DELIVERED_TO_POSTA_BY_THE_COURIER: 'u pošti', DELIVERED: 'isporučena',
  COMPLETED_LOCKER: 'preuzeta iz paketomata', COMPLETED_PUDO: 'preuzeta iz paket zone',
  CANCELLED: 'otkazana', LOST: 'izgubljena u transportu', DAMAGED: 'oštećena',
  RETURN_TO_SELLER: 'vraćena trgovcu', REJECTED_DELIVERY: 'isporuka odbijena', REJECTED_DELIVERY_PUDO: 'isporuka odbijena',
  ATTEMPTED_DELIVERY: 'pokušana isporuka', CUSTOMER_ADDRESS_INVALID: 'neispravna adresa za isporuku',
  REDIRECTED_DELIVERY: 'preusmerena isporuka', DELAYED_DELIVERY: 'isporuka odložena'
};
function stanjeOpis(st) { return STANJE[st] || 'u obradi'; }

const PLACANJE = {
  PBC: 'kartica (unapred)', IPS_QR: 'IPS / instant plaćanje', INSTLLMNTS: 'na rate', VIREMENT: 'uplatnica / virman',
  GIFT_CARD: 'gift kartica', GIFT: 'gift kartica', COD: 'pouzeće (pri preuzimanju)', POS: 'kartica pri preuzimanju', VOUCHER: 'vaučer'
};
function placanjeOpis(order) {
  return [...new Set((order.paymentMethods || []).map(p => PLACANJE[String(p).toUpperCase()]).filter(Boolean))].join(', ');
}
/* Nacin isporuke (order-level `deliveryMethod`). Mapiramo poznate kodove; nepoznat
   kôd prosledimo SIROVO (interno je, model svejedno moze da ga koristi) — cim vidimo
   prave vrednosti na TEST-u, dopunimo mapu. */
const DOSTAVA = {
  HOME: 'dostava na adresu', ADDRESS: 'dostava na adresu',
  LOCKER: 'paketomat', PAKETOMAT: 'paketomat',
  PUDO: 'paket zona', PACKAGE_ZONE: 'paket zona', PAKET_ZONA: 'paket zona',
  POSTA: 'pošta', POST: 'pošta'
};
function dostavaOpis(order) {
  const dm = order && order.deliveryMethod;
  if (!dm) return '';
  return DOSTAVA[String(dm).toUpperCase()] || String(dm);
}
/* Razlog otkazivanja — SAMO konteksti za koje znamo zvanično značenje (mapiranje
   iz chat_v2 / „StatusiMapiranja" xlsx). `MANUALLY_BY_EMPLOYEE`, `CRON_JOB` i
   nepoznato NAMERNO nemaju razlog (radije ništa nego pogođen/izmišljen razlog —
   „nije na zahtev kupca" je bila naša izmišljotina, ne postoji taj kontekst). */
const OTKAZ = {
  MANUALLY_BY_MERCHANT: 'od strane trgovca',
  MANUALLY_BY_CUSTOMER: 'na tvoj zahtev',
  MISSING_ITEMS: 'jer traženi artikal nije bio dostupan'
};
function datum(iso) {
  if (!iso) return null;
  const d = new Date(iso); if (isNaN(d)) return null;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}.`;
}
/* Datum + vreme kreiranja (poručivanja) u BEOGRADSKOJ zoni — `createdAt` je UTC („…Z").
   Fallback na UTC ako Intl padne. Format: „DD.MM.YYYY. u HH:MM". */
function datumVreme(iso) {
  if (!iso) return null;
  const d = new Date(iso); if (isNaN(d)) return null;
  try {
    const f = new Intl.DateTimeFormat('sr-RS', { timeZone: 'Europe/Belgrade',
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const p = f.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.day}.${p.month}.${p.year}. u ${p.hour}:${p.minute}`;
  } catch (e) {
    const z = n => String(n).padStart(2, '0');
    return `${z(d.getUTCDate())}.${z(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}. u ${z(d.getUTCHours())}:${z(d.getUTCMinutes())} (UTC)`;
  }
}
/* KASNI = rok isporuke je prosao a posiljka NIJE u konacnom/preuzetom stanju. Skup
   ispod = statusi koji NIKAD nisu kasnjenje (⟦KASNI⟧ se ne postavlja) — poravnato sa
   xlsx listom „Probijen rok" (konacni „samo procitaj status" + POSTA), plus (po docu
   27.8) paketomat/paket-zona koji su STIGLI: DELIVERED_LOCKER/PUDO — njihov DP je vreme
   dolaska u locker/zonu, ne preuzimanja od kupca, pa ih ne tretiramo kao kasnjenje.
   Sve ostalo, ako je rok prosao, jeste kasnjenje -> prompt ODMAH prebacuje na agenta. */
const NE_KASNI = new Set([
  'DELIVERED', 'COMPLETED_LOCKER', 'COMPLETED_PUDO',
  'CANCELLED', 'LOST', 'DAMAGED', 'RETURN_TO_SELLER',
  'SHIPMENT_IS_IN_POSTA', 'DELIVERED_TO_POSTA_BY_THE_COURIER',
  'DELIVERED_LOCKER', 'DELIVERED_PUDO'
]);
function jeKasni(sub) {
  const st = String(sub.status || '');
  if (NE_KASNI.has(st)) return false;
  const rok = sub.deliveryDateUpper || sub.deliveryDateLower;
  const t = rok ? new Date(rok).getTime() : NaN;
  return !isNaN(t) && t < Date.now();
}
/* Link za ZAMENSKI proizvod (isti artikal kod drugih prodavaca) — za negativne
   statuse koji NISU krivica kupca (vraćena/oštećena/izgubljena/otkazana ne od
   strane kupca). Gradi se iz productEan. #1499: ako EAN fali, NE vraćamo link
   (inače bi bio „…query=" — prazan, pokvaren). */
function zamenaLink(sub) {
  const st = String(sub.status || '');
  const eligibilan = st.startsWith('RETURN_TO_SELLER') || st.startsWith('DAMAGED')
    || st.startsWith('LOST') || (st === 'CANCELLED' && sub.cancellationContext !== 'MANUALLY_BY_CUSTOMER');
  if (!eligibilan) return null;
  const ean = String((sub.items || [])[0]?.productEan || '').trim();
  if (!ean) return null;                          // nema EAN -> nema linka (bez pokvarenog linka)
  return `https://ananas.rs/search?query=${ean}`;
}
/* KONTEKST ZA ODGOVOR (iz chat_v2 Ananas-vetovanih poruka, sažeto — NE doslovno):
   izvinjenje kod negativnih statusa + suština „sledećeg koraka". Model ovo utkne
   SVOJIM rečima (sme da preformuliše), ali izvinjenje kad ga ima zadržava, a
   razlog otkazivanja ne izmišlja. Prazno = uredan status, samo se saopšti. */
const MEJL_NAJAVA = 'čim je porudžbina kreirana, na imejl unet u porudžbini ODMAH stiže potvrda o prijemu porudžbine; kada kurir preuzme paket, na mejl stiže fiskalni račun/potvrda, a na dan isporuke mejl „Hej danas ti stiže paket"';
function kontekstZaStatus(sub) {
  const st = String(sub.status || ''), cc = sub.cancellationContext;
  switch (st) {
    case 'CANCELLED':
      return cc === 'MANUALLY_BY_CUSTOMER'
        ? 'porudžbinu si sam/a otkazao/la; ako zatreba, rado pomažem oko nove porudžbine'
        : 'žao mi je zbog nastale situacije — do ovoga dolazi usled izazova u obradi ili kad je poslednji/izložbeni komad; ponudi pomoć oko zamenskog proizvoda ili nove porudžbine';
    case 'LOST':
      return 'izgubljena u transportu; žao mi je zbog nastale situacije; ponudi zamenski proizvod';
    case 'DAMAGED':
      return 'oštećena i nije bila adekvatna za dalju isporuku; žao mi je zbog nastale situacije; ponudi zamenski proizvod';
    case 'RETURN_TO_SELLER':
      return 'vraća se trgovcu (najčešće neuspešan pokušaj isporuke ili neadekvatna za dalju isporuku); žao mi je zbog nastale situacije; ponudi zamenski proizvod';
    case 'REJECTED_DELIVERY':
      return 'isporuka odbijena; sledeći korak je povrat trgovcu; ponudi pomoć oko nove porudžbine';
    case 'REJECTED_DELIVERY_PUDO':
      return 'poteškoće u isporuci na paket zonu; žao mi je zbog toga; tim radi na isporuci u najkraćem mogućem roku';
    case 'ATTEMPTED_DELIVERY':
      return 'pokušaj isporuke nije uspeo jer kurir nije uspeo da te kontaktira; žao mi je; moguć je lični dogovor s kurirom, a predviđena su dva pokušaja isporuke';
    case 'CUSTOMER_ADDRESS_INVALID':
      return 'adresa za isporuku nije ispravna; potrebno je proveriti i ispraviti podatke za isporuku';
    case 'PARTIALLY_CONFIRMED':
    case 'PARTIALLY_PACKED':
      return 'neki proizvodi nisu dostupni pa je porudžbina delimično potvrđena/spakovana; žao mi je; ' + MEJL_NAJAVA;
    case 'PARTIALLY_PACKED_IN_TRANSIT':
    case 'PARTIALLY_PACKED_ON_THE_BORDER':
      return 'neki proizvodi nisu dostupni (delimično spakovano); žao mi je; roba ide kroz međunarodni tranzit i carinjenje pa je rok duži; ' + MEJL_NAJAVA;
    case 'CREATED':
    case 'CONFIRMED':
    case 'PACKED':
    case 'PACKING_INITIATED':
    case 'READY_FOR_COLLECTION':
      return 'sledeći korak je pakovanje i priprema za preuzimanje od kurira; ' + MEJL_NAJAVA;
    case 'AWAITING_PAYMENT':
      return 'odabrana je uplatnica — potrebno je izvršiti uplatu po instrukcijama sa mejla; po evidentiranju uplate ide pakovanje; ' + MEJL_NAJAVA;
    case 'COLLECTED':
      return 'kurir je preuzeo paket; sledeći korak je isporuka na adresu; na dan isporuke stiže mejl i poziv kurira';
    case 'ON_DELIVERY':
      return 'isporuka je planirana za danas (08–16h); očekuj poziv kurira pre isporuke';
    case 'PACKED_IN_TRANSIT':
    case 'PACKED_ON_THE_BORDER':
      return 'roba ide preko inostranih dobavljača — međunarodni tranzit i carinjenje, pa je rok isporuke duži; ' + MEJL_NAJAVA;
    case 'COLLECTED_LOCKER':
    case 'ON_DELIVERY_LOCKER':
      return 'na putu je ka paketomatu; po dolasku stižu instrukcije (PIN) SMS-om ili Viberom za preuzimanje';
    case 'DELIVERED_LOCKER':
      return 'stigla je u paketomat; za preuzimanje uneseš PIN dobijen SMS-om/Viberom na terminalu';
    case 'COLLECTED_PUDO':
    case 'ON_DELIVERY_PUDO':
      return 'na putu je ka paket zoni; po zaprimanju stiže mejl sa QR kodom, adresom lokacije i rokom preuzimanja';
    case 'DELIVERED_PUDO':
      return 'stigla je na paket zonu; za preuzimanje pokažeš QR kod iz mejla (uz plaćanje na zoni ako je tako izabrano)';
    default:
      return '';
  }
}
function opisSubordera(order, sub) {
  const st = String(sub.status || ''), L = [];
  L.push(`Porudžbina ${sub.suborderId}`);
  // Razlog otkazivanja se UTAPA u „Stanje" da zvuči prirodno („otkazana od strane
  // trgovca" / „otkazana na tvoj zahtev" / „otkazana jer traženi artikal…"), a ne
  // kao nezgrapno „Razlog otkazivanja: od strane trgovca" (to je „ko", ne „zašto").
  const otk = (st === 'CANCELLED' && OTKAZ[sub.cancellationContext]) ? ` ${OTKAZ[sub.cancellationContext]}` : '';
  L.push(`  Stanje: ${stanjeOpis(st)}${otk}${jeKasni(sub) ? '  ⟦KASNI⟧' : ''}`);
  const kreirana = datumVreme(sub.createdAt || order.createdAt);
  if (kreirana) L.push(`  Kreirana: ${kreirana}`);
  const items = (sub.items || []).map(i => `    - ${i.productName || 'proizvod'}${i.quantity ? ` (${i.quantity} kom)` : ''}${(i.grandTotal || i.basePrice) ? `, ${i.grandTotal || i.basePrice} RSD` : ''}`);
  if (items.length) { L.push('  Artikli:'); L.push(...items); }
  const od = datum(sub.deliveryDateLower), doo = datum(sub.deliveryDateUpper);
  if (od || doo) L.push(`  Procenjeni rok isporuke: ${[od, doo].filter(Boolean).join(' - ')}`);
  const dm = dostavaOpis(order);
  if (dm) L.push(`  Način isporuke: ${dm}`);
  const pm = placanjeOpis(order);
  if (pm) L.push(`  Način plaćanja: ${pm}`);
  if (order.isAnanasPlus) L.push('  Ananas+ : da (porudžbina uz Ananas+ članstvo)');
  if (order.isFinalSplitPassedForPayment) L.push('  (refundacija za ovu porudžbinu ide preko trgovca)');
  const zl = zamenaLink(sub);
  if (zl) L.push(`  Zamenski proizvod (isti artikal kod drugih prodavaca): ${zl}`);
  const kx = kontekstZaStatus(sub);
  if (kx) L.push(`  Kontekst za odgovor: ${kx}`);
  return L.join('\n');
}

/* ---------- GLAVNI TOK ---------- */
const conversationId = $utilities.sessionId;
const rucni = readCustomerIdOverride();
let customerId, token;
try {
  [customerId, token] = await Promise.all([
    rucni ? Promise.resolve(rucni) : getGenesysCustomerId(conversationId),
    getAnanasToken()
  ]);
} catch (e) { dbg('authError', e && e.message); return PORUKA_GRESKA; }
if (!customerId || typeof customerId !== 'string' || customerId.length !== 36) { dbg('customerId', String(customerId)); return PORUKA_NEPOZNAT_NALOG; }
dbg('customerId', customerId);   // uspesno razresen customerId -> output.sp_customerId (za trag/debug)

let orders;
try {
  const res = await axios.get(`${ANANAS.base}/order/api/v1/ai-data-provider/orders`,
    { params: { customerId }, headers: { Authorization: `Bearer ${token}`, 'x-ananas-market': 'RS' }, timeout: HTTP_TIMEOUT });
  orders = Array.isArray(res.data) ? res.data : [res.data];
} catch (e) { dbg('ordersError', e && e.message); return PORUKA_GRESKA; }

/* Prozor od 180 dana po datumu PORUČIVANJA (`createdAt`; fallback rok isporuke).
   Suborder BEZ ijednog datuma se NIKAD ne odbacuje (digitalna roba, otkazane pre
   slanja) — nema po cemu da se sudi, a o njima kupac sme da pita. Nema kod-pretrage
   ni kapice: model dobija SVE iz prozora i sam bira. */
const cutoff = Date.now() - PROZOR_DANA * 24 * 3600 * 1000;
const stavke = [];
for (const order of orders.filter(Boolean)) {
  for (const sub of (order.suborders || [])) {
    // Prozor/redosled po STVARNOM datumu poručivanja (`createdAt`, suborder pa order);
    // fallback rok isporuke ako createdAt fali. Bez ijednog datuma → nikad se ne odbacuje.
    const iso = sub.createdAt || order.createdAt || sub.deliveryDateLower;
    const kljuc = iso ? new Date(iso).getTime() : NaN;
    if (!isNaN(kljuc) && kljuc < cutoff) continue;      // stariji od 180 dana
    stavke.push({ order, sub, kljuc });
  }
}
// NAJNOVIJE PRVO (po datumu PORUČIVANJA) — da „prvih 5" budu 5 NAJSKORIJIH i da
// „poslednja" bude tačna; bez datuma ide na kraj. (redosled kao Refundacija)
const kdatum = x => (isNaN(x.kljuc) ? -Infinity : x.kljuc);
stavke.sort((a, b) => kdatum(b) - kdatum(a));
const blokovi = stavke.map(x => opisSubordera(x.order, x.sub));
dbg('brojPorudzbina', blokovi.length);
if (!blokovi.length) return PORUKA_PRAZNO;

/* Uputstvo za model putuje UZ podatke (kao PRAVILA u Refundaciji) — kako da čita
   ovaj spisak. Nije za kupca; ne pokazuje se. */
const UPUTSTVO =
`Kako da koristiš ovaj spisak (interno, ne pokazuješ kupcu):
- Ovde su SAMO fizičke porudžbine/pošiljke. Ako ono što kupac traži nije pošiljka, toga nema ovde — NE nabrajaš pakete, nego odgovor tražiš u bazi znanja.
- Biraš porudžbinu o kojoj kupac govori — po broju, poziciji („prva", „druga"), nazivu artikla ili stanju.
- Kada kupac imenuje konkretno STANJE, odgovaraš SAMO za porudžbine baš tog stanja — ne mešaš različita stanja (svako ima svoja pravila). Kada pita za OTKAZANE/VRAĆENE (negativne) porudžbine — otkazana, vraćena trgovcu, oštećena, izgubljena — bilo jednu vrstu ili više njih zajedno, prikaži najviše **2 NAJNOVIJE** takve (ne 5).
- Svaku porudžbinu opisuješ stvarnim nazivom artikla iz polja „Artikli" — nikada ne prenosiš kupčevu reč o vrsti artikla na porudžbinu koja joj ne odgovara. Ako kupac pita za određenu vrstu artikla, u grupu uključuješ samo porudžbine čiji artikal stvarno odgovara toj vrsti; ostale ne svrstavaš tu ni kada ih biraš po drugom kriterijumu (stanje, razlog otkazivanja). Kada je kupac SAM naveo broj porudžbine **i taj broj si našao u spisku**, u odgovoru ne ponavljaš taj broj nego navedeš koji je artikal u njoj; kada je SAM naveo artikal ili vrstu, ne ponavljaš naziv artikla nego navedeš broj porudžbine. **Nađen je i NEPOTPUN broj** (samo početak, kako ga kupac prepiše iz imejla) **i broj sa dodatkom ili zalepljenom rečju** — dovoljno je da se poklapa sa nekim brojem iz spiska. **Ako ga u spisku NISI našao, odgovor NE vezuješ ni za jednu porudžbinu**: kažeš da taj broj ne vidiš među njegovim pošiljkama, navedeš ga i pitaš na koju porudžbinu ili artikal misli.
- Ako NIJE jasno na koju misli (ima ih više), prikaži kupcu samo PRVIH 5 (spisak je već poređan od NAJNOVIJE ka starijoj) i pitaj na koju misli — ne sipaš ceo spisak. Na TOM pregledu daješ samo KRATKO (broj + stanje + naziv artikla), **BEZ punih detalja** (cene, rok isporuke, način plaćanja) i **BEZ zamenskog linka**. Pune detalje i zamenski link daješ TEK kada kupac izabere KONKRETNU porudžbinu (jednu ili par).
- **NIKADA ne nabrajaš ceo spisak** — čak i kada kupac izričito kaže „daj mi sve" / „šta sve imam", prikazuješ najviše **PRVIH 5 (najskorijih)** i ponudiš detalje za konkretnu. Ako kupac traži baš porudžbinu koje nema među tih 5, tu porudžbinu nađeš po broju ili opisu artikla i pokažeš je.
- Kada kupac pita za AKTIVNE pošiljke ili za dolazak/dostavu („kada mi stiže", „gde mi je paket", „šta mi je u toku") — prikazuješ **SAMO aktivne** (one koje još NISU završene: nisu isporučene/preuzete niti otkazane/vraćene/izgubljene/oštećene/odbijene). Ako nema nijedne aktivne, **kažeš da trenutno nema pošiljki u dostavi — NE nabrajaš isporučene/otkazane**.
- „⟦KASNI⟧" = rok isporuke prošao a porudžbina nije isporučena (interni signal, nikada ga ne pokazuješ kupcu).
- Uz porudžbinu stoji i „Kreirana" (datum i vreme PORUČIVANJA) — po njemu je spisak poređan (najnovije prvo) i po njemu tačno odgovaraš na „kada sam poručila/kupila", „iz jula", „juče", „koja je poslednja/najnovija". „Način isporuke" (dostava na adresu / paketomat / paket zona / pošta) i „Ananas+ : da" (porudžbina uz Ananas+ članstvo) koristiš kada kupac pita baš to; ne raspisuješ ih na pregledu.
- **Stanje pošiljke saopštavaš SVOJIM rečima, kao rečenicu** — oznaka uz „Stanje" ti je podatak, ne formulacija. NE lepiš je doslovno iza „Status je…" (tako nastaju neprirodne rečenice tipa „Status je u transportu, kod kurira"). Kažeš šta se sa paketom dešava: „Paket je preuzeo kurir i nosi ga na tvoju adresu.", „Paket te čeka u paketomatu.", „Porudžbina čeka tvoju uplatu." Smisao i sve činjenice ostaju isti — menjaš samo oblik rečenice, ništa ne dodaš i ne izostavljaš.
- Status „isporučena/preuzeta" je UREDAN status: na obično pitanje o statusu SAMO saopštiš status i sadržaj pošiljke — NE prebacuješ na agenta i NE pominješ agenta. Na agenta (uz izvinjenje) prebacuješ ISKLJUČIVO ako kupac U OVOM POTEZU sam izričito kaže da pošiljka NIJE stigla / nije preuzeta / nije je dobio. **NE izmišljaš tu tvrdnju** i NE dodaješ hipotetičko „ako paket nije stvarno preuzet" — ako kupac to nije rekao, NEMA prebacivanja.
- Negativan status pošiljke znači da pošiljka NIJE isporučena (oštećena, izgubljena u transportu, vraćena trgovcu, otkazana). Kupac tada nema šta da reklamira — **ne upućuješ ga na „Pokreni reklamaciju"** i **ne tvrdiš da je reklamacija uslov za povraćaj novca** (nije — za unapred plaćenu porudžbinu povraćaj ide automatski). Ako pita šta dalje ili za novac, pravila su u Refundaciji. **Reklamacija ostaje ispravan put samo kada je pošiljka isporučena/preuzeta, a kupac kaže da sa proizvodom nešto nije u redu.**
- Zamenski link: kada kupac pita za KONKRETNU porudžbinu (jednu ili par) i uz nju u spisku stoji „Zamenski proizvod … link", **obavezno** mu ponudiš taj link (isti proizvod kod drugih prodavaca) — ne izostavljaš ga. Na PREGLEDU (više porudžbina) link NE prikazuješ. Ako linka nema uz porudžbinu, ne izmišljaš ga.
- Uz porudžbinu ponekad stoji „Kontekst za odgovor" (izvinjenje kod negativnih statusa i suština sledećeg koraka). To **utkaš u odgovor SVOJIM rečima** kada kupac pita baš za tu porudžbinu — ne moraš doslovno, ali **izvinjenje kad ga ima OBAVEZNO zadržavaš**. Ko je/zašto je porudžbina otkazana navodiš SAMO ako to piše uz „Stanje" (npr. „otkazana od strane trgovca", „otkazana na tvoj zahtev"); ako uz „Stanje" stoji samo „otkazana", **ne nagađaš razlog**. Na PREGLEDU (više porudžbina) kontekst ne raspisuješ — čuvaš ga za odgovor o konkretnoj porudžbini.`;
return `${UPUTSTVO}\n\nPorudžbine kupca:\n\n${blokovi.join('\n\n')}`;
