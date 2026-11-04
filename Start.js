/* ---------- Start (chat_v3) — ulazni čvor ----------
   Nema šta da priprema za ostatak flowa:
     • razgovor agent čita direktno iz Genesys ulaza (`messageScope:"flowInput"`)
       + `Buffer Window Memory`, ne iz povratne vrednosti Start-a;
     • identitet kupca izvode alati iz `$utilities.sessionId` (`getGenesysCustomerId`);
     • radno vreme i vreme računa `RadnoVreme` (Belgrade `Intl`), ne Start.
   Ranije je ovde stajalo: `currentDateTime` (nigde se ne koristi — prompt traži
   samo `{workingHours}`), `inputParams:{}` (prazno) i upis Genesys „User-to-User"
   u session `genesysUserToUser` (ništa ga ne čita). Sve uklonjeno kao mrtav kod.
   Vraćamo poruke — bezopasno, služi kao ulazna tačka. */
return { msgs: $utilities.executionState.messages };
