# out-coached-backend

Firebase backend (Firestore rules + Cloud Functions) for **Out-Coached** — see
the [out-coached](../out-coached) repo's `DESIGN.md` for the full spec and
`CLAUDE.md` for the non-negotiable rules this project must hold to. Split into
its own repo because it's a different toolchain (TypeScript/Node vs. the
Android app's Kotlin/Gradle) with its own deploy path (`firebase deploy` vs.
an app release) — see the design doc discussion for the tradeoffs.

**Status: phase 1 (skeleton) — schema + rules only, no Cloud Functions logic
yet.** Money math (settlement, refund/void, undo) is phase 2.

## Layout

```
firebase.json           firebase.json config
firestore.rules          Security rules — see comments inline, and
                          DESIGN.md §5.2/§6 for the "why"
firestore.indexes.json   Composite indexes
functions/                Cloud Functions (TypeScript)
  src/types.ts            Schema types mirroring DESIGN.md §6
  src/index.ts             Function exports (currently just a smoke-test ping)
  src/scripts/seedGame.ts Dev-only emulator seed script
```

## Setup

```
cd functions && npm install
npm install -g firebase-tools   # if not already installed
firebase login
cp ../.firebaserc.example ../.firebaserc   # then edit in your project id
```

## Local development (emulators)

```
firebase emulators:start --only functions,firestore,auth
```

In another terminal, seed a dev game (rules deny client writes to `games/*`,
so this is how a test game gets created before there's an admin UI for it):

```
cd functions
FIRESTORE_EMULATOR_HOST=localhost:8080 npm run seed
```

Point the Android app's `google-services.json` / emulator config at
`localhost` on the ports in `firebase.json` (`firestore: 8080`,
`auth: 9099`, `functions: 5001`) to develop against this locally.

## Deploy

```
firebase deploy --only firestore:rules,firestore:indexes,functions
```

## Build order

See DESIGN.md §9. This repo currently implements step 1 (schema + rules).
Step 2 (settlement Cloud Function, parimutuel math, ledger, refund/void/undo,
with unit tests against the worked examples in DESIGN.md §4.3) is next.
