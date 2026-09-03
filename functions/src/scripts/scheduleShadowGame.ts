// Admin script: creates a scheduled crowd-run game directly via the Admin
// SDK, calling the same scheduleGameHandler the deployed `scheduleGame`
// callable uses (PLAN.md CR-0 item 3 / §11.7) — just without the HTTPS
// callable + custom-token detour, since admin scripts already have full
// Firestore access and don't need to re-derive the operator claim from a
// token when the caller already confirms it out of band (grantOperator.ts).
//
// Usage (needs GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC):
//   npx ts-node src/scripts/scheduleShadowGame.ts <gameId> <operatorUid> [minutesUntilKickoff]
//
// The operator uid MUST already have the `operator` custom claim
// (scripts/grantOperator.ts) — this script doesn't check it, it just
// assumes you've already confirmed it (e.g. via listRecentUsers.ts).

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { scheduleGameHandler } from "../crowdHandlers";

const [gameId, operatorUid, minutesArg] = process.argv.slice(2);
const minutesUntilStart = Number(minutesArg ?? "2");

if (!gameId || !operatorUid) {
  console.error(
    "Usage: ts-node src/scripts/scheduleShadowGame.ts <gameId> <operatorUid> [minutesUntilKickoff]"
  );
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const scheduledStartAtMillis = Date.now() + minutesUntilStart * 60_000;

  const result = await scheduleGameHandler(
    getFirestore(),
    {
      gameId,
      scheduledStartAtMillis,
      config: {
        lockWindowSeconds: 10,
        grubstake: 1000,
        minStake: 1,
        crowdMode: "shadow",
        // 2-person small-group overrides — PLAN.md CR-5's call-out for
        // calibrating reportQuorumShare with a small group.
        snapBurstMinReports: 2,
        momentBurstMinReports: 2,
        reportQuorumMin: 2,
        reportQuorumShare: 1.0,
        joinWindowSeconds: minutesUntilStart * 60,
      },
    },
    operatorUid,
    /* isOperatorClaim */ true,
  );

  console.log("scheduleGame result:", result);
  console.log(`Kickoff at ${new Date(scheduledStartAtMillis).toISOString()} (join window open now).`);
}

main().then(() => process.exit(0));
