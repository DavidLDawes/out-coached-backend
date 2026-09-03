// Ad-hoc admin script: lists the most recently created Firebase Auth users
// against prod, newest first. Used to match anonymous-auth UIDs to devices
// right after a fresh app install/launch, without digging through the
// Firebase console by hand.
//
// Usage (needs GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC):
//   npx ts-node src/scripts/listRecentUsers.ts [count]

import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const count = Number(process.argv[2] ?? "10");

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "out-coached" });

async function main() {
  const auth = getAuth();
  const users: { uid: string; createdAt: number; claims: string; providers: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      users.push({
        uid: u.uid,
        createdAt: new Date(u.metadata.creationTime).getTime(),
        claims: JSON.stringify(u.customClaims ?? {}),
        providers: u.providerData.map((p) => p.providerId).join(",") || "anonymous",
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  users.sort((a, b) => b.createdAt - a.createdAt);
  for (const u of users.slice(0, count)) {
    console.log(`${new Date(u.createdAt).toISOString()}  ${u.uid}  claims=${u.claims}  providers=${u.providers}`);
  }
}

main().then(() => process.exit(0));
