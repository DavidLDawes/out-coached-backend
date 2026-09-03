// Admin script: grants (or revokes) the per-game-eligible `operator` custom
// claim (DESIGN.md §12.10 / crowdHandlers.ts scheduleGameHandler). This is
// the "scheduling admin" claim scheduleGame checks — mirrors grantMonitor.ts.
//
// Usage (against prod, needs GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC):
//   npx ts-node src/scripts/grantOperator.ts <uid>            # grant
//   npx ts-node src/scripts/grantOperator.ts <uid> --revoke   # revoke
//
// Against the Auth emulator, set FIREBASE_AUTH_EMULATOR_HOST first.

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const uid = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!uid) {
  console.error("Usage: ts-node src/scripts/grantOperator.ts <uid> [--revoke]");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const claims = { ...(user.customClaims ?? {}) };
  if (revoke) {
    delete claims.operator;
  } else {
    claims.operator = true;
  }
  await auth.setCustomUserClaims(uid, claims);
  console.log(`${revoke ? "Revoked" : "Granted"} operator claim for ${uid}.`);
  console.log("The user must re-authenticate (or refresh their ID token) for it to take effect.");
}

main().then(() => process.exit(0));
