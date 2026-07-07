// Admin script: grants (or revokes) the global `monitor` custom claim —
// DESIGN.md §12.5/§12.9. Monitor authority is cross-game by design (one
// person on duty watching every live game), which is why it's a custom
// claim and not a per-game Firestore list like operatorUids.
//
// Usage (against prod, needs GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC):
//   npx ts-node src/scripts/grantMonitor.ts <uid>            # grant
//   npx ts-node src/scripts/grantMonitor.ts <uid> --revoke   # revoke
//
// Against the Auth emulator, set FIREBASE_AUTH_EMULATOR_HOST first.

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const uid = process.argv[2];
const revoke = process.argv.includes("--revoke");

if (!uid) {
  console.error("Usage: ts-node src/scripts/grantMonitor.ts <uid> [--revoke]");
  process.exit(1);
}

initializeApp();

async function main() {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const claims = { ...(user.customClaims ?? {}) };
  if (revoke) {
    delete claims.monitor;
  } else {
    claims.monitor = true;
  }
  await auth.setCustomUserClaims(uid, claims);
  console.log(`${revoke ? "Revoked" : "Granted"} monitor claim for ${uid}.`);
  console.log("The user must re-authenticate (or refresh their ID token) for it to take effect.");
}

main().then(() => process.exit(0));
