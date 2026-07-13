# out-coached-backend

Firebase backend (Firestore rules + Cloud Functions) for **Out-Coached** — see
the [out-coached](../out-coached) repo's `DESIGN.md` for the full spec and
`CLAUDE.md` for the non-negotiable rules this project must hold to. Split into
its own repo because it's a different toolchain (TypeScript/Node vs. the
Android app's Kotlin/Gradle) with its own deploy path (`firebase deploy` vs.
an app release) — see the design doc discussion for the tradeoffs.

**Status: phases 2 and 3 deployed and live, plus the crowd-run backend
(DESIGN.md §12 / PLAN.md CR-2).** Settlement, void-advance, and undo Cloud
Functions run against the real `out-coached` Firebase project on the Blaze
plan; leaderboard recomputation and FCM game-live notifications
(`notifications.ts`) are also deployed. Crowd-run — snap/moment burst
detection, type/result voting, holds, the monitor console's callables, and
`scheduleGame` — is fully implemented and deployed alongside the
operator-driven path (`crowdHandlers.ts`); which path a game uses is a
per-game `config.crowdMode` setting. Remaining work (DESIGN.md §9 step 4, a
live dry run against a real broadcast) lives entirely on the Android/operator
side — nothing further is planned for this repo before that.

The Android app also gained a monetization layer (AdMob ads, a one-time
premium ad-removal purchase, GDPR/UMP consent — see the out-coached repo's
DESIGN.md §10). **That is entirely client-side and out of scope for this
repo** — no billing/ads/consent data is ever sent to Firestore or Cloud
Functions, and it should stay that way; see this repo's CLAUDE.md.

Runtime: Node.js 22 (see `functions/.nvmrc` / `functions/package.json`
`engines.node`).

## Layout

```
firebase.json            firebase.json config
firestore.rules          Security rules — see comments inline, and
                          DESIGN.md §5.2/§6 for the "why"
firestore.indexes.json   Composite indexes
functions/                Cloud Functions (TypeScript)
  src/types.ts             Schema types mirroring DESIGN.md §6 (+§12.5)
  src/settlement.ts        Pure parimutuel math (unit tested, no Firebase deps)
  src/settlement.test.ts   Vitest — worked examples from DESIGN.md §4.3
  src/handlers.ts          settlePlay/advanceAfterVoid/undoLastSettlement logic
                            (+ the §12.4 reporting-accuracy ledger step)
  src/handlers.emulator.test.ts  Integration tests against the real Firestore emulator
  src/notifications.ts     FCM game-live push (+ the isFirstGoingLive guard,
                            which is unit-tested — sendGameLiveNotification
                            itself isn't; no Messaging emulator exists)
  src/notifications.test.ts  Unit tests for isFirstGoingLive
  src/crowd/               DESIGN.md §12 pure decision logic (no Firebase deps),
                            each with an exhaustive unit-test file:
    burst.ts                 §12.2 moment-signal burst detection
    consensus.ts             §12.3 vote tallying + finalize rule
    quorum.ts                §12.6 quorum scaling + margin acceptance
    reportingLedger.ts       §12.4 reward/penalty table
    config.ts                §12.5 tunables + defaults resolver + scheduleGame
                              config validation
  src/crowdHandlers.ts     Crowd-run trigger logic: snap/kickoff/period bursts,
                            type/result votes, holds, sweep, scheduleGame,
                            monitor actions (PLAN.md CR-2)
  src/crowdHandlers.emulator.test.ts  Full crowd-run plays against the emulator
  src/index.ts             Thin trigger/callable wrappers around handlers + ping
  src/scripts/seedGame.ts  Dev-only emulator seed script
  src/scripts/grantMonitor.ts  Grants/revokes the §12.9 monitor custom claim
  src/scripts/e2eCrowdGame.ts  Trigger-level e2e crowd game against the full
                            emulator — not run in CI (slow, full-stack); run
                            manually via `npm run e2e` after `firebase emulators:start`
  eslint.config.mjs        ESLint flat config — `npm run lint`
.github/workflows/
  ci.yml                   Lint + build + test on every PR
  deploy.yml               Lint + build + test + deploy on push to main
```

## CI/CD

`deploy.yml` runs on every push to `main`: builds, runs the vitest suite,
then deploys Firestore rules/indexes/functions to the live `out-coached`
project — authenticated via a dedicated GCP service account
(`github-deploy@out-coached.iam.gserviceaccount.com`) whose key is stored as
the `GCP_SA_KEY` repo secret. That service account holds exactly the roles
Cloud Functions Gen2 deploys need (Firebase Admin, Cloud Functions Admin,
Cloud Run Admin, Artifact Registry Admin, Eventarc Admin, Pub/Sub Admin,
Cloud Build Editor, Service Account User, Storage Admin, **Cloud Scheduler
Admin** — needed once a scheduled function exists, e.g. `crowdSweep`;
without it, deploy succeeds for every other function but fails updating the
Cloud Scheduler job a scheduled function is backed by) — nothing broader.
Rotate the key via `gcloud iam service-accounts keys create` + re-running
`gh secret set GCP_SA_KEY` if it's ever suspected compromised.

## Setup

```
cd functions && npm install
npm install -g firebase-tools   # if not already installed
firebase login
cp ../.firebaserc.example ../.firebaserc   # then edit in your project id
```

## Testing

```
npm run lint             # ESLint (flat config, non-type-checked TS rules)
npx vitest run           # pure math (settlement.ts) — instant, no emulator needed
npm run test:emulator    # handlers.ts against a real Firestore emulator
```

`test:emulator` requires **JDK 21+** (the Firestore emulator jar itself
needs it — separate from whatever JDK you use for other projects). All three
run in CI on every PR and before every deploy.

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

See DESIGN.md §9. Steps 1 (schema + rules), 2 (settlement Cloud Function,
parimutuel math, ledger, refund/void/undo), and 3 (leaderboard recomputation,
FCM game-start pings) are done and deployed, as is the crowd-run backend
(DESIGN.md §12 / PLAN.md CR-2 — see `crowdHandlers.ts`). Step 4 (a live dry
run against a real broadcast) is the only step left, and it doesn't touch
this repo.
