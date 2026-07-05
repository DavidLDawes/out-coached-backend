// Shared helpers for tests that run against the real Firestore emulator
// (see handlers.emulator.test.ts). Deliberately separate from handlers.ts —
// these are test-only concerns, not production code.

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const EMULATOR_PROJECT_ID = "demo-out-coached-test";

export function requireEmulatorHost(): string {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — run these tests via `npm run test:emulator`, " +
        "which wraps them with `firebase emulators:exec`.",
    );
  }
  return host;
}

let initialized = false;

export function getTestFirestore() {
  requireEmulatorHost();
  if (!initialized) {
    initializeApp({ projectId: EMULATOR_PROJECT_ID });
    initialized = true;
  }
  return getFirestore();
}

/** Wipes all Firestore documents in the emulator between tests. */
export async function clearFirestoreEmulator(): Promise<void> {
  const host = requireEmulatorHost();
  const url = `http://${host}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${response.status} ${await response.text()}`);
  }
}
