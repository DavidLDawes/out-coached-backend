# CLAUDE.md

Guidance for Claude Code (and any future contributor) working in this repo.
Full rationale lives in the [out-coached](../out-coached) repo's `DESIGN.md`
— this file is the condensed set of rules that must not be silently violated
while implementing it. The out-coached repo's `CLAUDE.md` has the same rules
from the Android app's side; the two should never drift apart.

## What this is

Firebase backend (Firestore rules + Cloud Functions, TypeScript/Node) for
**Out-Coached**, a real-time football play-prediction game. Split from the
Android app into its own repo because it's a different toolchain with its
own deploy path (`firebase deploy` vs. an app release). Phases 1–3 of the
build order are done and deployed to the live `out-coached` Firebase project
on the Blaze plan: schema/rules, settlement/void/undo, and leaderboard/FCM —
as is the crowd-run backend (DESIGN.md §12, `crowdHandlers.ts`).

**Not real-money gambling.** Credits only, no cash-out. If that ever changes,
stop and re-read DESIGN.md's legal note before touching settlement code.

## Non-negotiable architectural rules

These exist because the game is trivially cheatable or exploitable if any one
of them slips. Any PR/diff touching wagers, settlement, or timing must be
checked against this list — this repo is where every one of them is actually
enforced (rules + Cloud Functions), so it carries more weight here than
anywhere else in the project.

1. **All money math lives in Cloud Functions.** Firestore rules deny client
   writes to `balance`, `settlement`, `ledger`, and `leaderboard` documents
   outright — the Admin SDK (this repo) is the only path that can touch them.
2. **All timestamps are server-assigned and rule-enforced.** Every wager
   revision and every `snapAt` uses `FieldValue.serverTimestamp()`; rules
   check `request.resource.data.placedAt == request.time` (or equivalent).
   Client-supplied timestamps are never trusted for any ruling.
3. **Wagers are append-only.** Rules: `allow update, delete: if false` on
   wager revisions and ledger entries. The retroactive lock rule depends on
   this history existing and never being edited.
4. **Betting locks retroactively, not on a schedule.** `cutoffAt = snapAt −
   lockWindowSeconds` is computed *after* the snap, from the operator's SNAP
   action. Settlement selects each player's latest wager revision with
   `placedAt <= cutoffAt` — there is no countdown to enforce server-side.
5. **Settlement is idempotent and strictly sequential.** One settlement
   invocation per play, keyed by `playId`; ledger doc IDs are
   `{playId}_{uid}` so retries can't double-pay. `handlers.ts` refuses to
   settle play *n* before play *n−1* has settled or been voided.
6. **Stakes deduct at settlement, not at placement.** Balances only change
   via the ledger-writing functions here (settlement, refund/void, undo,
   top-up) — never anywhere else.
7. **Outcome buckets come from game config, not code.** Settlement reads
   `games/{gameId}.config.buckets`; never hardcode a bucket list in
   `settlement.ts` or `handlers.ts`.
8. **The operator cannot be a player in the same game.** Enforced in
   `firestore.rules`: a uid in `operatorUids` may not create a `players` doc
   in that game at all (so it can't wager), independent of `operatorUids`
   being edited later.

## Conventions

- Node.js 22 (`functions/.nvmrc`, `package.json` `engines.node`).
- `settlement.ts` and `leaderboard.ts` are pure functions with no Firebase
  imports — keep new math there testable the same way (Vitest, no emulator).
- `handlers.ts` holds the actual business logic; `index.ts` stays thin
  (trigger/callable wrappers only) so handlers are unit- and
  emulator-testable without deploying.
- Structured logging via `firebase-functions/v2`'s `logger` — every operator
  action (settle, void, undo) should log outcome, not just failure.
- Test both ways: `npx vitest run` for pure math (instant), `npm run
  test:emulator` for `handlers.ts` against a real Firestore emulator (needs
  JDK 21+, separate from any other JDK on the machine). `npm run lint` too
  (ESLint flat config, `eslint.config.mjs`). All three run in CI on every PR
  and before every deploy (`.github/workflows/ci.yml` / `deploy.yml`).
- Deploys run on push to `main` via a dedicated least-privilege GCP service
  account (`github-deploy@out-coached.iam.gserviceaccount.com`, key in the
  `GCP_SA_KEY` repo secret) — don't broaden its roles without a reason.

## Monetization is out of scope for this repo

The Android app has AdMob ads, a one-time Play Billing "remove ads" purchase,
and a GDPR/UMP consent flow (see out-coached's DESIGN.md §10) — all of it
client-side. **No billing, ads, or consent data should ever reach Firestore
or Cloud Functions**, and premium/ad state must never be an input to
settlement, balances, or the ledger. If a future change seems to need this
repo to know about ad or purchase state, that's a signal to stop and
reconsider the design, not to add a field.

## Branch workflow

Always push to a branch and open a PR — never push directly to `main`. Wait
for review/merge before continuing to the next piece of work.
