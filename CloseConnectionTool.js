/* ---------- Close Connection Tool (GPT-5.4, prosta verzija) ----------
   Model SAM prepoznaje da je razgovor stvarno završen (pozdrav, „to je sve",
   izričit kraj) i poziva ovaj alat. Kod ne proverava reči i ne nagađa — veruje
   modelu (5.4 pouzdano razlikuje kraj razgovora od odbijanja ponude agenta).

   Postavlja `session_completed`; ugrađeni čvor „Close Interaction" na osnovu
   toga zatvara interakciju na Genesys-u. `intent = general_conversation` je
   wrap-up za razgovor koji je bot rešio (nije prosleđen agentu).

   session_completed se postavlja i u OUTPUT scope, ne samo transient: uslov
   „Close Interaction" ga čita iz $variables, koji izlaže output (kao `intent`),
   a NE transient — pa je transient-only signal bio nevidljiv i čet se zatvarao
   tek na 5-min timeout. Isti obrazac kao transfer (output.intent='agent_transfer'). */
const { executionState } = $utilities;

try {
  executionState.set('transient', 'session_completed', true);
  executionState.set('output', 'session_completed', true);
  executionState.set('output', 'intent', 'general_conversation');
} catch (e) { /* ignore */ }

return { message: 'The user ended the conversation.', session_completed: true };
