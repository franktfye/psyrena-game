/**
 * The one way into a ranked boss run.
 *
 * Two callers need it now and they must behave identically: the rooms panel's
 * "fight alone instead" escape hatch, the last client-local entry left in the
 * queue UI (villageHub wires it), and the party launch pushed down the social
 * stream when a room starts the fight for everyone — a leader's button in a
 * team room, the last ready press in a matchmade one (main.ts). Both party
 * paths meet in the server's launchRoom(), so they arrive here identically.
 * Before this existed the gate lived inline in villageHub, so the
 * pushed path would have had to duplicate the admission rules — and a paid
 * entry that charges on one path but not the other is exactly the bug class
 * worth designing out.
 *
 * Returns whether the player is actually going. The launch path needs that
 * answer: a member who declines the paid entry (or whose wallet is short)
 * must tell the server they are not coming, or the rest of the party sits on
 * the ready barrier until it times out.
 */

import { setPracticeMode } from "./practice";
import { gameConfirm, gameAlert } from "../ui/confirmDialog";
import { getArenaStatus, enterArena as enterArenaApi, ApiError } from "../net/economy";
import { refreshImaginz } from "../ui/playerHud";

/**
 * Run the arena admission gate and, if admitted, switch to the arena scene.
 *
 * Three free entries a day (server midnight reset), then a paid entry the
 * player must OK before the wallet is touched. Only a server "yes" switches
 * scenes; a 402 or a declined confirm stays put and returns false. A
 * network/dev-server hiccup lets the fight through — the gate is an economy
 * nicety, not a wall, and dead-ending the portal is the worse failure.
 */
export async function enterRankedArena(): Promise<boolean> {
  // A ranked entry always clears the practice flag — a practice run must
  // never leak into a real attempt.
  setPracticeMode(false);
  try {
    const status = await getArenaStatus();
    if (status.freeLeft <= 0) {
      // In-game confirm, not window.confirm — the native dialog drops a
      // mobile browser out of fullscreen.
      const ok = await gameConfirm(
        `No free arena entries left today (${status.freePerDay} per day, reset at midnight).\n` +
          `Enter anyway for ${status.extraCost} ◈ Imaginz? Balance: ${status.balance} ◈`,
        { okLabel: "Enter" }
      );
      if (!ok) return false;
    }
    const entry = await enterArenaApi();
    if (entry.cost > 0) refreshImaginz(entry.balance);
  } catch (err) {
    if (err instanceof ApiError) {
      await gameAlert(err.message);
      return false;
    }
    // Network/dev-server hiccup: let the fight through rather than
    // dead-ending the portal.
  }
  const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
  await psy?.go?.("arena");
  return true;
}
