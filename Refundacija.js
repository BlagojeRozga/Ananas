/* ---------- Refundacija (GPT-5.4, PROSTA verzija — 22.8.2026) ----------
   Kao StatusPosiljke: NE odlucuje kod. Alat povuce SVE porudzbine i vrati ih sa
   podacima bitnim za refundaciju (nacin placanja, konacna podela, stanje, artikli)
   plus PRAVILA i tacne, Ananasom odobrene RECENICE koje model treba da upotrebi.
   Model bira porudzbinu o kojoj kupac govori, primeni pravilo i napise odgovor.
   Bez lestvice, bez rezolucije u kodu. Novcane recenice su doslovne (odobreni
   tekst), da model ne parafrazira iznose/procedure. Final split (trgovac) ->
   ODMAH transfer (odobreni tekst sam pominje prebacivanje); spor oko refundacije
   koja „nije stigla" -> ponuda agenta (transfer na „da").                       */
const axios = require('axios');

const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
const ENV = runtimeEnv.ANANAS_ENV || 'prod'; // 'qa' | 'qa2' | 'prod'
const HTTP_TIMEOUT = 8000;
const TEST_CUSTOMER_ID = '';    // PRE PUSTANJA U RAD OSTAVITI PRAZAN

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

function dbg(k, v) { try { $utilities.executionState.set('output', 'ref_' + k, String(v)); } catch (e) { /* ignore */ } }

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

const PLACANJE = {
  PBC: 'kartica (unapred)', IPS_QR: 'IPS / instant plaćanje', INSTLLMNTS: 'na rate', VIREMENT: 'uplatnica / virman',
  GIFT_CARD: 'gift kartica', GIFT: 'gift kartica', COD: 'pouzeće (pri preuzimanju)', POS: 'kartica pri preuzimanju', VOUCHER: 'vaučer'
};
const UNAPRED = new Set(['PBC', 'IPS_QR', 'INSTLLMNTS', 'VIREMENT', 'GIFT_CARD']);
function nacinPlacanja(order) {
  const codes = (order.paymentMethods || []).map(p => String(p).toUpperCase());
  if (!codes.length) return 'nepoznato';
  const imena = [...new Set(codes.map(p => PLACANJE[p]).filter(Boolean))];
  const oznaka = codes.some(p => UNAPRED.has(p)) ? 'plaćeno UNAPRED'
    : (codes.some(p => p === 'COD' || p === 'POS') ? 'plaćanje PRI PREUZIMANJU (pouzeće)' : 'ostalo');
  return `${imena.length ? imena.join(', ') : 'plaćanje'} — ${oznaka}`;
}
const STANJE = {
  CREATED: 'kreirana, u obradi', CONFIRMED: 'potvrđena, u obradi', PARTIALLY_CONFIRMED: 'delimično potvrđena, u obradi',
  AWAITING_PAYMENT: 'neplaćena, čeka uplatu', PACKING_INITIATED: 'u pripremi za slanje', PACKED: 'spakovana',
  PARTIALLY_PACKED: 'delimično spakovana', PACKED_IN_TRANSIT: 'spakovana, u transportu',
  PARTIALLY_PACKED_IN_TRANSIT: 'delimično spakovana, u transportu', PACKED_ON_THE_BORDER: 'spakovana, na carini',
  PARTIALLY_PACKED_ON_THE_BORDER: 'delimično spakovana, na carini',
  COLLECTED: 'u transportu, kod kurira', COLLECTED_LOCKER: 'u transportu, kod kurira', COLLECTED_PUDO: 'u transportu, kod kurira',
  ON_DELIVERY: 'na isporuci', ON_DELIVERY_LOCKER: 'na isporuci', ON_DELIVERY_PUDO: 'na isporuci',
  DELIVERED_LOCKER: 'u paketomatu, čeka preuzimanje', DELIVERED_PUDO: 'u paket zoni, čeka preuzimanje',
  READY_FOR_COLLECTION: 'spremna za preuzimanje', SHIPMENT_IS_IN_POSTA: 'u pošti', DELIVERED_TO_POSTA_BY_THE_COURIER: 'u pošti',
  DELIVERED: 'isporučena', COMPLETED_LOCKER: 'preuzeta iz paketomata', COMPLETED_PUDO: 'preuzeta iz paket zone',
  CANCELLED: 'otkazana', LOST: 'izgubljena u transportu', DAMAGED: 'oštećena', RETURN_TO_SELLER: 'vraćena trgovcu',
  REJECTED_DELIVERY: 'isporuka odbijena', REJECTED_DELIVERY_PUDO: 'isporuka odbijena',
  ATTEMPTED_DELIVERY: 'pokušana isporuka', CUSTOMER_ADDRESS_INVALID: 'neispravna adresa za isporuku',
  REDIRECTED_DELIVERY: 'preusmerena isporuka', DELAYED_DELIVERY: 'isporuka odložena'
};
function stanjeOpis(st) { return STANJE[st] || 'u obradi'; }
/* Negativan (refund-eligible) status po PORODICI (prefiks) — nove varijante uđu same. */
function jeNegativan(st) {
  const s = String(st || '');
  return s.startsWith('CANCEL') || s.startsWith('LOST') || s.startsWith('DAMAGED')
    || s.startsWith('RETURN_TO_SELLER') || s.startsWith('REJECTED_DELIVERY');
}
const ISPORUCENO = new Set(['DELIVERED', 'COMPLETED_PUDO', 'COMPLETED_LOCKER']);

/* Razlog otkazivanja — ISTO mapiranje kao u `StatusPosiljke.js` (izvor: chat_v2
   `razlogOtkazivanja` + „StatusiMapiranja" xlsx). SAMO konteksti za koje znamo
   zvanicno znacenje; `MANUALLY_BY_EMPLOYEE`, `CRON_JOB` i nepoznato NAMERNO
   nemaju razlog (radije nista nego pogodjen razlog). Zasto i ovde: model bira
   JEDAN alat po potezu, pa kada pitanje o otkazanoj porudzbini zavrsi na
   Refundaciji, razlog inace fizicki nije u tekstu koji je dobio. */
const OTKAZ = {
  MANUALLY_BY_MERCHANT: 'od strane trgovca',
  MANUALLY_BY_CUSTOMER: 'na tvoj zahtev',
  MISSING_ITEMS: 'jer traženi artikal nije bio dostupan'
};
function opisSubordera(order, sub) {
  const st = String(sub.status || '');
  const artikli = (sub.items || []).map(i => i.productName).filter(Boolean).join(', ');
  const grupa = jeNegativan(st) ? 'refund-osnov (negativan status)' : (ISPORUCENO.has(st) ? 'isporučena' : 'aktivna (u toku)');
  const L = [
    `Porudžbina ${sub.suborderId}`,
    `  Stanje: ${stanjeOpis(st)}${(st === 'CANCELLED' && OTKAZ[sub.cancellationContext]) ? ' ' + OTKAZ[sub.cancellationContext] : ''}  [${grupa}]`,
    `  Plaćanje: ${nacinPlacanja(order)}`,
    `  Refundaciju obrađuje trgovac (final split): ${order.isFinalSplitPassedForPayment ? 'DA' : 'ne'}`
  ];
  if (artikli) L.push(`  Artikli: ${artikli}`);
  return L.join('\n');
}

/* Odobrene RECENICE (doslovno) + pravila. Model bira scenario i upotrebi tačan tekst. */
const PRAVILA =
`Pravila refundacije — primeni na porudžbinu o kojoj kupac govori, ne izmišljaj iznose ni rokove. Za novčane slučajeve rečenice ispod smeš da preneseš svojim rečima, prirodnije — ali OBAVEZNO sačuvaš svaki konkretan podatak tačno (rokove, iznose, negacije, korake) i ne dodaješ, ne obećavaš i ne menjaš značenje. Ako nisi siguran da značenje ostaje isto, prenesi rečenicu doslovno. Ono što je kupac u svojoj poruci sam naveo (npr. „već sam reklamirao", „podneo sam povraćaj") uzimaš kao dato i NE prepričavaš mu nazad kao njegovu tvrdnju — bez konstrukcija „pošto kažeš da…", „kako kažeš…", „kažeš da je…". Odmah odgovaraš na ono što je pitao. Tačne rečenice alata prenosiš direktno, bez uvodnih veznika („važi ovo:", „za reklamaciju važi:", „važi sledeće:"). Saosećanje je i dalje u redu („žao mi je zbog toga"), ali ne kao logički most od onoga što je kupac rekao. Kada kupac kaže da je VEĆ reklamirao (prošlo vreme: „reklamirao sam", „već sam reklamirao") i pita za novac ili rok, daš reklamacijski odgovor ODMAH (rok + ishod) i NE listaš porudžbine niti pitaš „koja od njih" — odgovor za već podnetu reklamaciju je isti bez obzira na porudžbinu. Porudžbine listaš samo kada bi ishod stvarno zavisio od izbora.

NAPOMENA — RADNO VREME: ako je podrška van radnog vremena (vidi pravilo o radnom vremenu u glavnom uputstvu), pravila ispod koja pominju agenta se NE primenjuju — NE prebacuješ i NE nudiš agenta (ni kod final splita, ni kod spora oko refundacije). Umesto toga postupaš po pravilu o radnom vremenu: na izričit zahtev za agenta daš poruku o radnom vremenu, inače pomažeš iz ovih pravila bez pominjanja agenta i bez rečenice o prebacivanju.

VAŽNO: novčano pitanje („gde su moje pare", „vracaj pare", „povraćaj") NE znači obavezno otkazanu/negativnu porudžbinu — povraćaj može ići i za ISPORUČENU (odustanak/reklamacija). NE pretpostavljaš da je reč o negativnoj porudžbini. Ako kupac imenuje STANJE, to JESTE izbor — prikazuješ SAMO porudžbine baš tog stanja (najviše 5 najnovijih), ne ceo „refund-osnov" skup; „refund-osnov" je samo oznaka da porudžbina može imati povraćaj, NIJE stanje. Tek ako kupac nije imenovao ni konkretnu porudžbinu ni stanje, prikaži mu prvih 5 NAJNOVIJIH koje mogu da imaju povraćaj — to su porudžbine sa refund-osnovom (negativne) i ISPORUČENE (za njih povraćaj ide kroz reklamaciju/odustanak) — i pitaj na koju misli, pa tek onda primeni pravilo. **AKTIVNE porudžbine (u obradi / na putu / čeka preuzimanje) NE prikazuješ u tom spisku** jer za njih još nema osnova za refundaciju (o aktivnoj govoriš samo ako kupac baš nju imenuje). Spisak je poređan po skorašnjosti (najnovije prvo); koje su refund-osnov (negativne) vidiš iz OZNAKE na svakoj stavci, to nije pretpostavka koju porudžbinu kupac misli.

ODREĐENOST (koristi ono što VEĆ vidiš): za svaku porudžbinu iz spiska iznad imaš liniju „Plaćanje" — način plaćanja i da li je plaćeno unapred ili pri preuzimanju — i, ako ga ima, vaučer sa iznosom. Kada je jasno o kojoj porudžbini je reč, govoriš ODREĐENO na osnovu tih podataka: navodiš stvaran način plaćanja i stvaran vaučer te porudžbine, a ne uslovno („ako…") kad to iz podataka već znaš. Uslovnu formulaciju koristiš samo kada porudžbina nije jasna ili način plaćanja nije poznat. Tekstove ispod primenjuješ u ODREĐENOM obliku, prilagođene baš toj porudžbini. Primenjuješ SAMO onaj slučaj koji odgovara pitanju ili porudžbini o kojoj je reč. Ako kupac pita za određeni način plaćanja (npr. karticom/uplatnicom) ili konkretnu porudžbinu, NE nabrajaš druge načine plaćanja ni slučajeve koje nije pomenuo.

1) Plaćeno UNAPRED + porudžbina otkazana/izgubljena/oštećena/vraćena, a final split = ne:
"S obzirom na to da je pošiljka plaćena unapred a otkazana je, izvršava se automatska refundacija na originalni način plaćanja. Povraćaj sredstava se najčešće pokreće istog dana ili u roku od 24h od promene statusa, dok vreme evidentiranja zavisi od procedure tvoje banke (uglavnom u roku od par dana). Ako je otkazan samo deo porudžbine, automatski se vraća iznos sredstava za taj deo."

2) Način plaćanja je pouzeće (COD) ili POS (kartica pri preuzimanju) — plaćanje se vrši TEK pri preuzimanju. Ako je porudžbina otkazana ili vraćena PRE preuzimanja (nije preuzeta), iznos NIJE naplaćen, pa nema šta da se refundira — i to kažeš JASNO vezano za to da porudžbina nije preuzeta, NIKADA kao opštu tvrdnju „plaćanje pri preuzimanju znači bez refundacije". (Ako je proizvod PREUZET i plaćen pa se vraća kroz odustanak/reklamaciju → refundacija POSTOJI — to je slučaj 4.) Reci to ljubazno.

3) Final split = DA → refundaciju rešava trgovac; treba tekući račun i AGENT. Upotrebi tačno ovaj tekst i ODMAH prebaci (pozoveš TransferAgent, bez pitanja):
"U slučaju da refundacija još uvek nije izvršena putem originalnog načina plaćanja, zamolila bih te da pripremiš broj tekućeg računa. Kako bih tvoj tekući račun prosledila našim nadležnim timovima, prebaciću te na našeg agenta podrške. Zamolila bih te za još malo strpljenja. Naš agent stupiće u kontakt s tobom putem četa u najbržem mogućem roku."

4) ISPORUČENA/preuzeta porudžbina → povrat ide kroz reklamaciju ILI odustanak:
- reklamacija (proizvod neispravan/oštećen/ne odgovara opisu), ishod neizvestan: "O daljem toku i ishodu tvog zahteva blagovremeno će te obavestiti kolega koji ga obrađuje. Rešenje reklamacije može zavisiti od više faktora - na primer, odluke trgovca ili ovlašćenog servisa, raspoloživosti proizvoda itd."
- odustanak od kupovine (proizvod ispravan, kupac se predomislio, 14 dana), ishod je refundacija: "O daljem toku i ishodu tvog zahteva blagovremeno će te obavestiti kolega koji ga obrađuje. Ukoliko je zahtev za odustanak prihvaćen, ishod je refundacija novca."
- KAKO RAZLUČUJEŠ: reklamacija je SAMO kada kupac navede kvar/neispravnost/oštećenje/"ne odgovara opisu". Ako kupac vraća (ili je vratio) isporučen proizvod BEZ ijednog takvog razloga — npr. "vratio sam", "ne sviđa mi se", "predomislio sam se", "treba mi novac", "ne treba mi više" — to je ODUSTANAK i tako ga tretiraš (ne nabrajaš obe opcije). Pitaš "reklamacija ili odustanak?" SAMO kada iz poruke zaista ne možeš da razlučiš ima li kvara ili ne.
- Kada pominješ stanje porudžbine, oznaku uz „Stanje" **kažeš svojim rečima, kao rečenicu** — ne lepiš je doslovno iza „Status je…". Oznaka je podatak, ne formulacija.
- VAŽNO: ako se razgovor VEĆ vodi o reklamaciji (kupac je prijavio kvar/neispravnost/oštećenje/ne odgovara opisu), pa onda traži novac — OSTAJEŠ na reklamaciji: njen ishod zavisi od trgovca/servisa i MOŽE biti i povraćaj novca. NE prebacuješ ga na odustanak samo zato što traži pare, niti mu ponavljaš odustanak. Odustanak pominješ isključivo ako je proizvod ISPRAVAN (kupac se predomislio).

5) AKTIVNA porudžbina (u obradi / na putu / čeka preuzimanje) → još nema osnova za refundaciju (objasni to).

Ako kupac tvrdi da mu refundacija još nije stigla iako je gore navedeno da je automatska/rešena — ponudi mu prebacivanje na agenta.

Negativan status pošiljke znači da pošiljka NIJE isporučena (oštećena, izgubljena u transportu, vraćena trgovcu, otkazana). Kupac tada nema šta da reklamira — **ne upućuješ ga na „Pokreni reklamaciju"** i **ne tvrdiš da je reklamacija uslov za povraćaj novca** (nije — za unapred plaćenu porudžbinu povraćaj ide automatski). Ako pita šta dalje ili za novac, pravila su u Refundaciji. **Reklamacija ostaje ispravan put samo kada je pošiljka isporučena/preuzeta, a kupac kaže da sa proizvodom nešto nije u redu.**

Kada kupac imenuje konkretno stanje (otkazana, vraćena, izgubljena, oštećena, isporučena), odgovaraš i prikazuješ SAMO porudžbine baš tog stanja — ne mešaš različita stanja (npr. otkazane sa vraćenima). **NIKADA ne nabrajaš ceo spisak — prikazuješ najviše 5 NAJNOVIJIH iz tog stanja** i ponudiš da za konkretnu kažeš detalje ili da suziš izbor (npr. po nazivu artikla). Ako nije jasno koja je, prikaži prvih 5 najnovijih koje mogu da imaju povraćaj (negativne ili isporučene — NE aktivne) i pitaj. Kada je kupac SAM naveo broj porudžbine **i taj broj si našao u spisku**, u odgovoru ne ponavljaš taj broj nego navedeš koji je artikal u njoj; kada je SAM naveo artikal ili vrstu, ne ponavljaš naziv artikla nego navedeš broj porudžbine. **Nađen je i NEPOTPUN broj** (samo početak, kako ga kupac prepiše iz imejla) **i broj sa dodatkom ili zalepljenom rečju** — dovoljno je da se poklapa sa nekim brojem iz spiska. **Ako ga u spisku NISI našao, odgovor NE vezuješ ni za jednu porudžbinu**: kažeš da taj broj ne vidiš među njegovim pošiljkama, navedeš ga i pitaš na koju porudžbinu ili artikal misli.`;

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
dbg('customerId', customerId);   // uspesno razresen customerId -> output.ref_customerId (za trag/debug)

let orders;
try {
  const res = await axios.get(`${ANANAS.base}/order/api/v1/ai-data-provider/orders`,
    { params: { customerId }, headers: { Authorization: `Bearer ${token}`, 'x-ananas-market': 'RS' }, timeout: HTTP_TIMEOUT });
  orders = Array.isArray(res.data) ? res.data : [res.data];
} catch (e) { dbg('ordersError', e && e.message); return PORUKA_GRESKA; }

/* Refund-osnov (negativne) prvo, pa isporučene, pa ostalo — da model odmah vidi
   porudzbine bitne za refundaciju cak i ako ih je mnogo. */
/* Prozor 180 dana po roku isporuke; suborder BEZ roka se NIKAD ne odbacuje —
   otkazane pre slanja (glavni refund slucaj) i digitalna roba nemaju rok. */
const PROZOR_DANA = 180;
const cutoff = Date.now() - PROZOR_DANA * 24 * 3600 * 1000;
const stavke = [];
for (const order of orders.filter(Boolean))
  for (const sub of (order.suborders || [])) {
    const rok = sub.deliveryDateLower ? new Date(sub.deliveryDateLower).getTime() : NaN;
    if (!isNaN(rok) && rok < cutoff) continue;
    stavke.push({ order, sub, rok });
  }
if (!stavke.length) return PORUKA_PRAZNO;
// NAJNOVIJE PRVO (po roku isporuke): da prvih 5 koje model pokaže kupcu odražava
// skorašnje porudžbine BEZ OBZIRA na status — refund ide i za isporučenu vraćenu
// robu, pa se ne sme dogoditi da 5 otkazanih zakloni skorašnju isporučenu. Da li je
// koja refund-osnov (negativna) model vidi iz OZNAKE na svakoj stavci, ne iz redosleda.
const kdatum = x => (isNaN(x.rok) ? -Infinity : x.rok);   // bez roka (npr. otkazano pre slanja / digitalno) -> na kraj
stavke.sort((a, b) => kdatum(b) - kdatum(a));
dbg('ukupno', stavke.length);
dbg('negativnih', stavke.filter(x => jeNegativan(String(x.sub.status))).length);

return `${PRAVILA}\n\nPorudžbine kupca (najnovije prvo; refund-osnov je označen na stavci):\n\n${stavke.map(x => opisSubordera(x.order, x.sub)).join('\n\n')}`;
