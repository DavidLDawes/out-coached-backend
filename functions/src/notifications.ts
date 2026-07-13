// FCM game-start ping (DESIGN.md §5.1/§9 step 3). Topic-based, not per-token
// — the Android app subscribes to `game_{gameId}` on join (see
// GameRepository.joinGame), so there's no device-token registry to manage.
//
// Not covered by the Firestore emulator (Firebase's Local Emulator Suite has
// no Messaging emulator), so sendGameLiveNotification itself is exercised
// only by deploying and watching a real game go live — the trigger *guard*
// in index.ts's notifyGameLive is the testable part.

import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions/v2";
import type { GameStatus } from "./types";

/**
 * True only for the game's *first* transition into "live" — not a crowd
 * game's halftime -> live at the second-half snap, which would otherwise
 * fire a second "come watch, it's starting" push mid-game.
 */
export function isFirstGoingLive(before: GameStatus | undefined, after: GameStatus | undefined): boolean {
  return after === "live" && before !== "live" && before !== "halftime";
}

export async function sendGameLiveNotification(gameId: string): Promise<void> {
  await getMessaging().send({
    topic: `game_${gameId}`,
    notification: {
      title: "Out-Coached",
      body: "The game is live — jump in and start picking!",
    },
    data: { gameId },
  });
  logger.info("sendGameLiveNotification: sent", { gameId });
}
