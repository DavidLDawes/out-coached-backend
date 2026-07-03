import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";

initializeApp();

// Deploy/emulator smoke test only. Phase 2 (DESIGN.md §9) adds the real
// functions here: settlement (triggered by a play reaching `locked` with
// `result` set), void/refund, undo, and busted-player top-up — all of the
// money math that CLAUDE.md rule #1 says must never live on a client.
export const ping = onRequest((_req, res) => {
  res.status(200).send("ok");
});
