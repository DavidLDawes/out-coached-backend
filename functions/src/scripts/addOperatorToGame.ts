// Ad-hoc admin fixup: adds a uid to an existing game's operatorUids array.
// For when a scheduled game's operator device had to be swapped after the
// fact (e.g. a fresh install created a new anonymous uid not present in the
// operatorUids set from scheduleGameHandler at creation time).
//
// Usage (needs GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC):
//   npx ts-node src/scripts/addOperatorToGame.ts <gameId> <uid>

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const [gameId, uid] = process.argv.slice(2);

if (!gameId || !uid) {
  console.error("Usage: ts-node src/scripts/addOperatorToGame.ts <gameId> <uid>");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const ref = getFirestore().doc(`games/${gameId}`);
  await ref.update({ operatorUids: FieldValue.arrayUnion(uid) });
  const snap = await ref.get();
  console.log(`operatorUids for ${gameId}:`, snap.data()?.operatorUids);
}

main().then(() => process.exit(0));
