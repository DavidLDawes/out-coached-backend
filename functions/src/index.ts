import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { advanceAfterVoidHandler, settlePlayHandler, undoLastSettlementHandler } from "./handlers";
import type { Play } from "./types";

initializeApp();

// Deploy/emulator smoke test only.
export const ping = onRequest((_req, res) => {
  res.status(200).send("ok");
});

/**
 * DESIGN.md §6 settlement sequencing. Fires the moment a play's result is
 * newly recorded (operator's enterResult write — state stays "locked",
 * `result` appears for the first time). Guards on "result just appeared"
 * rather than "state == locked" alone, so this function's own writes
 * (settling -> settled) and undo's writes (clearing result) don't cause it
 * to recurse into itself. See handlers.ts for the actual settlement logic.
 */
export const settlePlay = onDocumentUpdated("games/{gameId}/plays/{playId}", async (event) => {
  const before = event.data?.before.data() as Play | undefined;
  const after = event.data?.after.data() as Play | undefined;
  const { gameId, playId } = event.params as { gameId: string; playId: string };

  if (!after || after.state !== "locked" || !after.result) return;
  if (before?.result) return;

  await settlePlayHandler(getFirestore(), gameId, playId);
});

/**
 * Opens the next play after VOID (no money moves — see handlers.ts).
 */
export const advanceAfterVoid = onDocumentUpdated("games/{gameId}/plays/{playId}", async (event) => {
  const before = event.data?.before.data() as Play | undefined;
  const after = event.data?.after.data() as Play | undefined;
  const { gameId, playId } = event.params as { gameId: string; playId: string };

  if (!after || after.state !== "voided" || before?.state === "voided") return;

  await advanceAfterVoidHandler(getFirestore(), gameId, playId);
});

/**
 * DESIGN.md §3/§7.2: operator-only, reverses the most recent settled play.
 * See handlers.ts for the actual reversal logic.
 */
export const undoLastSettlement = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required.");

  const { gameId, playId } = (request.data ?? {}) as { gameId?: string; playId?: string };
  if (!gameId || !playId) throw new HttpsError("invalid-argument", "gameId and playId are required.");

  return undoLastSettlementHandler(getFirestore(), gameId, playId, uid);
});
