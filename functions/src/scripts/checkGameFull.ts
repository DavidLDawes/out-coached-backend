// Ad-hoc read-only diagnostic: dumps every play, its wagers/reports/result,
// ledger entries, and every player doc for a game.
// Usage: npx ts-node src/scripts/checkGameFull.ts <gameId>
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const [gameId] = process.argv.slice(2);
if (!gameId) {
  console.error("Usage: ts-node src/scripts/checkGameFull.ts <gameId>");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const db = getFirestore();

  const playersSnap = await db.collection(`games/${gameId}/players`).get();
  console.log("=== PLAYERS ===");
  for (const doc of playersSnap.docs) {
    console.log(doc.id, JSON.stringify(doc.data()));
  }

  const playsSnap = await db.collection(`games/${gameId}/plays`).get();
  console.log("\n=== PLAYS ===");
  for (const playDoc of playsSnap.docs.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`--- play ${playDoc.id} ---`, JSON.stringify(playDoc.data()));
    const wagersSnap = await playDoc.ref.collection("wagers").get();
    console.log(`  wagers:`, wagersSnap.docs.map((d) => d.data()));
    const reportsSnap = await playDoc.ref.collection("reports").get();
    console.log(`  reports:`, reportsSnap.docs.map((d) => d.data()));
  }

  const ledgerSnap = await db.collection(`games/${gameId}/ledger`).get();
  console.log("\n=== LEDGER ===");
  for (const doc of ledgerSnap.docs) {
    console.log(doc.id, JSON.stringify(doc.data()));
  }
}
main().then(() => process.exit(0));
