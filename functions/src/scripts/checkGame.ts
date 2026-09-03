// Ad-hoc read-only diagnostic: dumps a game doc and its current play doc.
// Usage: npx ts-node src/scripts/checkGame.ts <gameId> [playId]
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const [gameId, playIdArg] = process.argv.slice(2);
if (!gameId) {
  console.error("Usage: ts-node src/scripts/checkGame.ts <gameId> [playId]");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const db = getFirestore();
  const gameSnap = await db.doc(`games/${gameId}`).get();
  const game = gameSnap.data();
  console.log("GAME:", JSON.stringify(game, null, 2));
  const playId = playIdArg ?? game?.currentPlayId;
  if (playId) {
    const playSnap = await db.doc(`games/${gameId}/plays/${playId}`).get();
    console.log(`PLAY ${playId}:`, JSON.stringify(playSnap.data(), null, 2));
    const wagersSnap = await db.collection(`games/${gameId}/plays/${playId}/wagers`).get();
    console.log(`WAGERS on ${playId}:`, wagersSnap.docs.map((d) => d.data()));
    const reportsSnap = await db.collection(`games/${gameId}/plays/${playId}/reports`).get();
    console.log(`REPORTS on ${playId}:`, reportsSnap.docs.map((d) => d.data()));
  }
}
main().then(() => process.exit(0));
