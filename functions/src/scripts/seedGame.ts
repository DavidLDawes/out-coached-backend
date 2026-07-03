// Dev-only helper: creates a game doc + first play against the Firestore
// emulator. Rules deny client writes to `games/{gameId}`, so during phase 1
// (before there's an admin console screen for game setup) this is how a
// test game gets created for the Android app to connect to.
//
// Usage: start the emulators (`npm run serve` from this package, in
// another terminal), then in this package run:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 npm run seed

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { Game, Play } from "../types";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "FIRESTORE_EMULATOR_HOST is not set — refusing to seed a real project. " +
      "Start the emulator and set FIRESTORE_EMULATOR_HOST=localhost:8080."
  );
}

initializeApp({ projectId: "out-coached-dev" });
const db = getFirestore();

const GAME_ID = "dev-game";
const OPERATOR_UID = "dev-operator";

async function main() {
  const game: Game = {
    status: "live",
    config: {
      lockWindowSeconds: 10,
      grubstake: 1000,
      minStake: 1,
      buckets: {
        run: ["loss", "0", "1", "2", "3", "4", "5+"],
        pass: [
          "interception",
          "sack",
          "scramble",
          "incompletion",
          "loss",
          "0",
          "1-3",
          "4-8",
          "9-15",
          "16+",
        ],
      },
      bustedTopUp: true,
    },
    currentPlayId: "0001",
    period: "Q1",
    operatorUids: [OPERATOR_UID],
  };

  await db.doc(`games/${GAME_ID}`).set(game);

  const firstPlay: Play = {
    state: "open",
    openedAt: FieldValue.serverTimestamp() as unknown as Play["openedAt"],
  };

  await db.doc(`games/${GAME_ID}/plays/0001`).set(firstPlay);

  console.log(`Seeded games/${GAME_ID} with operator ${OPERATOR_UID}.`);
}

main().then(() => process.exit(0));
