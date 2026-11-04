# chat_v4 — hibrid (GPT-5.4 model-driven + „pametni" alati)

Najbolje iz dve verzije:
- **od chat_v3**: prost prompt, prost `PripremaOdgovora` (samo HTML, bez lestvica,
  bez „tool wins"), model vodi razgovor i sam odlučuje o empatiji i eskalaciji.
- **KB spojen po wrap-up kodu** (`kb/Ananas_v2_5_4.json`, ~30 tema-klastera, jedan
  po Genesys wrap-up kodu): `pageContent` = sve formulacije te teme (embeduje se),
  `metadata.answer` = svi odgovori te teme (model čita), `metadata.tema` = kod.
  Model kroz `tema` (enum) imenuje oblast; alat GARANTUJE taj klaster + doda najbliže
  vektorski. Native wrap-up iz `tema`. Broj klastera fiksan (~30) → retrieval se
  nikad ne pre-štimuje. Transform: `kb/spoji_po_wrapup.py`.
- Alati za porudžbine/refundaciju **razrešavaju** (model prosledi šta zna, alat
  pronađe pravu porudžbinu). Prosti (opšti) input schema.

## Fajlovi i mapiranje na čvorove
```
Tools Calling Agent   .systemMessage  -> main_prompt.md
AnanasBazaZnanja      .source         -> AnanasBazaZnanja.js         (chunk KB, native wrap-up, vraća SAMO tekst odgovora)
AnanasBazaZnanja      .inputSchema    -> AnanasBazaZnanjaInputSchema.json
Status posiljke       .source         -> StatusPosiljke.js          (4.1 razrešavanje: lestvica, opis, deo broja…)
Status posiljke       .inputSchema    -> StatusPosiljkeInputSchema.json
Refundacija           .source         -> Refundacija.js             (4.1 razrešavanje + pravila)
Refundacija           .inputSchema    -> RefundacijaInputSchema.json
PripremaOdgovora      .source         -> PripremaOdgovora.js         (HTML: **masno**, brojevi porudžbina, intent)
Close Connection Tool .source         -> CloseConnectionTool.js      (model sam odlučuje o zatvaranju)
```

## Ključne odluke
- **Wrap-up radi KB alat** (native, iz `Workflowdata`), NE model preko oznake.
  Zato je uklonjena `[[WU:]]` mehanika iz prompta i `PripremaOdgovora`. Da bi i
  potezi o porudžbini/refundaciji dobili wrap-up, prompt traži da se uz
  `StatusPosiljke`/`Refundaciju` **uvek dodatno pozove i `AnanasBazaZnanja`**
  (i za bogatiji odgovor i za pokrivenost wrap-up-a).
- **Podebljavanje**: model piše `**masno**`; `PripremaOdgovora` to pretvara u
  `<b>`, i dodatno podebljava brojeve porudžbina (van već postojećih `<b>`).
- **StatusPosiljke — otkazivanje + poruke (27 Aug):** razlog otkazivanja je
  **utopljen u red „Stanje"** („otkazana od strane trgovca" / „na tvoj zahtev" /
  „jer traženi artikal nije bio dostupan"); samo `MANUALLY_BY_MERCHANT`/`_CUSTOMER`/
  `MISSING_ITEMS` — `MANUALLY_BY_EMPLOYEE`/`CRON_JOB`/null **bez razloga** (ne
  nagađa se). Izvor: chat_v2 `razlogOtkazivanja` + `kb/kb_original_articles/
  StatusiMapiranja … xlsx`. **„nije na zahtev kupca" NE POSTOJI** (bila izmišljotina,
  uklonjeno). Svaka porudžbina nosi i **„Kontekst za odgovor"** (sažeto, ne-doslovno
  iz v2): „žao mi je" kod negativnih + suština sledećeg koraka; model ga prenosi
  **svojim rečima** ali izvinjenje zadržava. Alati loguju razrešen customerId
  (`sp_customerId` / `ref_customerId`, debug).
- **Intent / transfer**: jedini izvor je alat **`TransferAgent`** — model ga
  pozove (po promptu) i on postavi `output.intent='agent_transfer'` +
  `transient.agent_transfer`. `PripremaOdgovora` **ne računa intent** iz teksta
  (raniji regex uklonjen — bio je krhak). Normalan potez ne postavlja intent
  (Genesys = `general_conversation`); kraj razgovora postavlja `CloseConnectionTool`.
  **Jedini izuzetak:** ako je odgovor engleski transfer na agenta (regex: pominje
  agent/support, bez srpskih slova) A podrška je `Closed`, `PripremaOdgovora`
  zameni poruku engleskim „offline, 8 AM" obaveštenjem i **poništi** transfer (da
  stranog kupca ne pošalje u zatvoren red).
- **Radno vreme (enforcement)**: `RadnoVreme` upiše `workingHours` u **transient**
  (čitljivo istog poteza). Kada je `Closed`: (a) `AnanasBazaZnanja` NE prosleđuje
  `⟦AGENT⟧` marker (radno vreme iznad KB force/ask — bot ne nudi agenta van radnog
  vremena); (b) `PripremaOdgovora` poništava engleski transfer (v. gore). Prompt
  dodatno menja pravila o agentu kad je zatvoreno.

## Svesni kompromisi (model-driven)
- **Nema „tool wins".** Alati za status/refund vraćaju gotov srpski tekst, ali ga
  model PREFORMULIŠE. Rizik od drifta činjenica (negacije, tačan razlog). Ako
  zatreba doslovno, dodaj u prompt pravilo „za status/refund prosleđuješ verno".
- **Determinističke eskalacije alata se IGNORIŠU** (`spPonudiAgenta` za spornu
  isporuku / KB `forceToAgent`). Agent se prosleđuje **samo** tako što **model
  pozove `TransferAgent`** (po pravilu iz prompta). I raniji „tool-side" slučajevi
  (sve kasni → `⟦KASNI⟧`, konačna podela u refundaciji) sada idu istim putem:
  alat ih samo označi/opiše, a model odluči i pozove `TransferAgent`. Alati
  **ne** zovu `requestAgentTransfer`.

## Deploy
Nov flow (npr. TESTIRANJE_v4). `ENV='qa'` u alatima, KB kolekcija `Ananas_v2_2`.
Meri se uživo — routing, wrap-up iz KB, i drift na status/refund odgovorima.

## Credentials
`StatusPosiljke.js` and `Refundacija.js` read credentials from runtime environment
variables. Configure them in the secure environment-variable store of the flow
runtime; do not put real values in source files or commit them. See `.env.example`
for the variable names. `ANANAS_ENV` defaults to `prod`; set it to `qa` or `qa2`
when using those environments. Each tool requires `GENESYS_CLIENT_SECRET` and
the secret for the selected Ananas environment.
