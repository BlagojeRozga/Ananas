/* ---------- TransferAgent (chat_v3) ----------
   Jedini izvor istine za prosleđivanje agentu. Model ga pozove kada prompt to
   nalaže (izričit zahtev za čoveka, strani jezik, ozbiljni slučajevi, sporna/
   zakasnela isporuka, prihvaćena ponuda „da", KB `⟦AGENT: force⟧`, konačna
   podela u Refundaciji). Alat SAMO izvršava transfer:
     - `output.intent = 'agent_transfer'`  -> Genesys prebacuje kupca
     - `transient.agent_transfer = true`   -> signal za ostatak izvršavanja
   `PripremaOdgovora` više NE računa intent iz teksta — ovaj alat je jedina
   odluka, pa ga nema ko pregaziti.

   Bez `message`/ulaza (schema je null): tekst koji kupac vidi piše model po
   promptu (srpska rečenica „Preusmeravam te na agenta podrške…" ili, kod
   stranog jezika, kratka engleska rečenica sa „agent"/„support"). Alat ne zna
   koji je slučaj, pa tekst i ne dira. */
const { executionState } = $utilities;

executionState.set('output', 'intent', 'agent_transfer');
executionState.set('transient', 'agent_transfer', true);

return { agent_transfer: true };
