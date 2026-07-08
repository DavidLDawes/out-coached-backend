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
          "incomplete",
          "intercepted",
          "sack",
          "scramble",
          "<5",
          "5-7",
          "8-10",
          "11-15",
          "16-20",
          "21+",
        ],
      },
      bustedTopUp: true,
      // DESIGN.md §12 — crowd-run rollout gate. "off" keeps the seeded dev
      // game operator-driven; flip to "shadow"/"live" to exercise the crowd
      // path locally. Tunables not set here resolve to CROWD_DEFAULTS.
      crowdMode: "off",
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
