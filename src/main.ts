import { createEngine, applyResolutionPolicy, gfxSummary, releaseGraphics } from "./core/engine";
import { configureTexturePipeline } from "./core/assets";
import { onLoadProgress, resetLoadProgress } from "./core/loadProgress";
import { SceneManager, type SceneFactory } from "./core/sceneManager";
import { PerfHud } from "./core/perfHud";
import { detectControlScheme, isTypingInField } from "./ui/inputMode";
import { initPanelChrome } from "./ui/panelChrome";
import { keepFullscreen } from "./ui/fullscreen";
import { runAuthFlow, type Profile } from "./ui/authFlow";
import { wardrobe } from "./state/wardrobe";
import { PlayerHud } from "./ui/playerHud";
import { ChatPanel } from "./ui/chatPanel";
import { mountLeftDock } from "./ui/leftDock";
import {
  openRoomsPanel,
  closeRoomsPanel,
  joinRoom,
  declineInvite,
  refreshRoomsPanel,
} from "./ui/roomsPanel";
import { closePartyInvite, showPartyInvite } from "./ui/invitePopup";
import { closeFriendRequest, showFriendRequest } from "./ui/friendRequestPopup";
import { enterRankedArena } from "./fight/arenaEntry";
import { postFightSkip } from "./net/economy";
import { DIFFICULTY_ORDER, setDifficulty, type FightDifficulty } from "./fight/difficulty";
import { SocialClient } from "./net/social";
import { player } from "./state/player";
import { createVillageHub } from "./scenes/villageHub";
import { createLookdevArena } from "./scenes/lookdevArena";
import { createPracticeBooth } from "./scenes/practiceBooth";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const boot = document.getElementById("boot") as HTMLDivElement;
const bootMsg = document.getElementById("boot-msg") as HTMLSpanElement;
const bootBarFill = document.querySelector<HTMLElement>("#boot-bar i");

// Progress bar under the boot line. Units register dynamically while a scene
// factory discovers its work, so raw settled/total can DROP when a burst of
// new loads lands — clamp the shown percent to be monotonic per scene
// (resetLoadProgress() zeroes it on every switch).
//
// A dynamic total has a worse failure than dropping, though: the loads are
// awaited one after another, so settled equals total at every await boundary
// (1/1, 2/2, …) and the raw percent reads 100 from the first settled asset
// onwards. Two counters fix that. The denominator is seeded with the unit
// count the same scene needed on its previous boot (persisted per scene in
// localStorage), so the fraction is measured against the real workload; and
// the shown percent is capped below full until the factory returns —
// bootBarDone() — which also covers a scene's very first boot, where no
// count is stored yet and the bar would otherwise still latch at 100.
const bootUnitsKey = (sceneId: string): string => `psyrena_load_units_${sceneId}`;
let bootBarShown = 0;
let bootBarExpected = 0;
let bootBarTotal = 0;
onLoadProgress((settled, total) => {
  if (!bootBarFill) return;
  if (total === 0) {
    bootBarShown = 0;
    bootBarTotal = 0;
    boot.classList.remove("loading");
    bootBarFill.style.width = "0%";
    return;
  }
  bootBarTotal = total;
  boot.classList.add("loading");
  const pct = Math.round((settled / Math.max(total, bootBarExpected)) * 100);
  bootBarShown = Math.max(bootBarShown, Math.min(pct, 95));
  bootBarFill.style.width = `${bootBarShown}%`;
});

/** Arm the bar for a scene switch: seed the denominator from the last boot. */
function bootBarArm(sceneId: string): void {
  try {
    bootBarExpected = Number(localStorage.getItem(bootUnitsKey(sceneId))) || 0;
  } catch {
    bootBarExpected = 0; // private mode — first-boot behavior every time
  }
}

/** Scene factory returned: remember its real unit count and fill the bar. */
function bootBarDone(sceneId: string): void {
  if (bootBarTotal > 0) {
    try {
      localStorage.setItem(bootUnitsKey(sceneId), String(bootBarTotal));
    } catch {
      // private mode — next boot just gets the capped first-boot bar again
    }
  }
  if (bootBarFill) bootBarFill.style.width = "100%";
}

// Once the GL context is gone, the contextlost handler has already written the
// real diagnosis to the boot screen; the exception Babylon throws moments
// later ("Unable to create uniform buffer") must not overwrite it.
let contextLost = false;

// The page is on its way out and we released the GPU on purpose (see the
// pagehide handler). The context loss that follows is ours, not the device's,
// so nothing may report it as a failure.
let unloading = false;

/**
 * Tap-target escape hatches on the boot screen.
 *
 * A boot that fails or wedges is a dead end on the exact device where it is
 * most likely to happen. An iPhone home-screen web app has NO URL BAR, so the
 * documented recoveries — reload, or retry on the WebGL2 backend with
 * `?gfx=webgl2` — are physically untypeable, and there is no console to read
 * the reason from either. The player's only remaining move is to delete the
 * app. So the boot screen has to carry its own recovery buttons.
 *
 * Rendered into the boot overlay (which now outranks the HUD in z-index, so it
 * is genuinely reachable), and never shown on a healthy boot: `stall()` arms
 * them on a timer, `fail()` on a thrown error.
 */
function bootEscapeHatches(): void {
  if (document.getElementById("boot-escape")) return;
  const wrap = document.createElement("div");
  wrap.id = "boot-escape";
  wrap.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px;";
  const mk = (label: string, go: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "background:none;border:1px solid #23405c;border-radius:6px;color:#7fdcf0;" +
      "font:inherit;font-size:11px;letter-spacing:.1em;padding:9px 14px;cursor:pointer;";
    b.addEventListener("click", go);
    return b;
  };
  wrap.append(
    mk("reload", () => location.reload()),
    // Forces the fallback backend, which is the recovery for every
    // WebGPU-shaped failure (init hang, a device that never composites).
    // Preserves any other query params the player arrived with.
    mk("retry on webgl2", () => {
      const url = new URL(location.href);
      url.searchParams.set("gfx", "webgl2");
      location.href = url.toString();
    })
  );
  boot.append(wrap);
}

/**
 * Arm the escape hatches if boot has not finished in `ms`.
 *
 * Deliberately generous: a cold phone downloading the hub over a slow link is
 * legitimately slow, and offering "reload" to someone who is 80% through the
 * download makes things worse. This fires only well past the point where a
 * healthy boot has completed, and it does not interrupt anything — the boot
 * line keeps whatever stage text it was on, which is the diagnosis.
 */
function armBootStallEscape(ms = 45000): number {
  return window.setTimeout(() => {
    if (boot.classList.contains("done")) return;
    bootEscapeHatches();
  }, ms);
}

/**
 * The scene table.
 *
 * Doc 01's core loop is hub -> arena -> hub for a whole session, so both scenes
 * exist from M1 and both go through the SceneManager. That is what makes the
 * leak soak test in `core/sceneManager.ts` meaningful: it can only prove a
 * transition is clean if there are two real scenes to transition between.
 *
 * The village and arena factories close over `sessionProfile` (set right
 * after login, before the first scene is built): the hub for its shop-NPC
 * panels, the arena for which hero's kit the fight mounts (selectedHero).
 */
let sessionProfile: Profile;
const SCENES: Record<string, { label: string; factory: SceneFactory }> = {
  village: { label: "Village Hub", factory: (engine) => createVillageHub(engine, sessionProfile) },
  arena: { label: "Lookdev Arena", factory: (engine) => createLookdevArena(engine, sessionProfile.selectedHero) },
  // Reached from the Practice Booth attendant in the hub, left through the
  // portal inside it. Needs nothing from the account — it is a target range.
  practice: {
    label: "Practice Booth",
    factory: (engine) => createPracticeBooth(engine, sessionProfile.selectedHero),
  },
};

/**
 * Let a player past the landscape gate when their phone cannot rotate.
 *
 * The gate itself is CSS (index.html) and fires on `orientation: portrait`. A
 * device with the OS rotation lock on never leaves that state, so without this
 * the game is permanently unreachable rather than merely awkward — the failure
 * looks exactly like "the game won't open", and it is iPhone-shaped because
 * iOS's portrait lock is a Control Center toggle people leave on.
 *
 * `sessionStorage`, not `localStorage`: the answer should outlive a reload
 * during one sitting, but a player who later turns rotation back on deserves
 * the landscape prompt again rather than a silently-cramped portrait UI. The
 * write is guarded because Safari throws on storage access in Private mode.
 */
function wireRotateGate(): void {
  const KEY = "psyrena.rotateAck";
  const ack = (): void => {
    document.body.dataset.rotateAck = "1";
    try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode */ }
  };
  try { if (sessionStorage.getItem(KEY)) document.body.dataset.rotateAck = "1"; } catch { /* private mode */ }
  document.getElementById("rotate-skip")?.addEventListener("click", ack);
}

/**
 * Blocking "signed in from another device" overlay — the single-login policy's
 * client half. Deliberately independent of every panel system: the kick can
 * arrive at any moment (mid-fight, mid-panel, mid-boot) and the only honest
 * recovery is a reload back into the login form. Plain DOM, own z-index above
 * everything, no way to dismiss except the button.
 */
function showKickedOverlay(): void {
  if (document.getElementById("kicked")) return;
  // Every social card left on screen is now a button that posts on a session
  // the server already deleted. Take them down with the session.
  closePartyInvite();
  closeFriendRequest();
  const wrap = document.createElement("div");
  wrap.id = "kicked";
  wrap.style.cssText =
    "position:fixed;inset:0;z-index:200;display:grid;place-items:center;" +
    "background:rgba(4,3,1,.9);backdrop-filter:blur(4px);" +
    "font:14px/1.6 system-ui,sans-serif;color:#f4e3b2;text-align:center;";
  const card = document.createElement("div");
  card.style.cssText =
    "display:grid;gap:14px;justify-items:center;padding:28px 32px;" +
    "max-width:min(420px,90vw);border:1px solid #5a4620;background:#120d05;";
  const title = document.createElement("div");
  title.style.cssText = "font-size:15px;letter-spacing:.24em;color:#ecc363;";
  title.textContent = "SIGNED IN FROM ANOTHER DEVICE";
  const body = document.createElement("div");
  body.style.cssText = "font-size:12px;opacity:.85;";
  body.textContent =
    "Your account logged in somewhere else, so this session has ended — only one login can be active at a time.";
  const btn = document.createElement("button");
  btn.style.cssText =
    "font:inherit;font-size:12px;letter-spacing:.2em;cursor:pointer;padding:10px 24px;" +
    "color:#ffe9b0;border:1px solid #5a4620;" +
    "background:linear-gradient(180deg,#7a4a16,#4e2c0e 55%,#331c08);";
  btn.textContent = "LOG IN AGAIN";
  btn.addEventListener("click", () => location.reload());
  card.append(title, body, btn);
  wrap.append(card);
  document.body.append(wrap);
}

async function main(): Promise<void> {
  // Publish the control scheme on <body> so the stylesheet can swap the control
  // legend. Stamped from the same `detectControlScheme()` the controls use, so
  // `?controls=touch` moves the CSS with it — a bare `(pointer: coarse)` media
  // query would ignore the override and disagree with the actual buttons.
  const scheme = detectControlScheme();
  document.body.dataset.controls = scheme;
  wireRotateGate();
  // Panels hide the dock + action bar on touch while they are open (one
  // observer, covers every panel — see ui/panelChrome.ts).
  initPanelChrome();
  // The initial requestFullscreen fires off the Enter Psyrena tap (authFlow.ts,
  // where the user gesture lives); this re-enters on the next tap if the
  // browser drops out of fullscreen — usually an accidental edge swipe.
  if (scheme === "touch") keepFullscreen();
  // Stated out loud because it is the #1 "my mobile UI is missing" confusion:
  // the scheme follows the PRIMARY POINTER, so a desktop browser gets the
  // keyboard layout even when the page is reached over the LAN/tailnet.
  console.info(
    `[controls] scheme=${scheme} (primary pointer). Force with ?controls=touch or ?controls=keyboard.`
  );

  // Account gate before any engine work: login → hero picker → Enter Psyrena.
  // The boot overlay is hidden while the auth screens own the viewport, and the
  // engine is not even created until the player commits — no point compiling
  // shaders behind a login form on a phone battery.
  boot.classList.add("done");
  const profile = await runAuthFlow();
  sessionProfile = profile;
  boot.classList.remove("done");
  console.info(`[account] ${profile.username} enters as ${profile.selectedHero} (${profile.rank}, ${profile.score})`);
  // The wardrobe belongs to the ACCOUNT, not the device: rescope it now so a
  // second account on this browser does not inherit the first one's loadout.
  wardrobe.bindAccount(profile.username);

  // Persistent overlays, created once the account exists and never per scene:
  // both registered scenes (village hub, boss arena) are exactly where the
  // player frame and the chat belong, and the auth screens — the only other
  // "scene" — run before this line. Same lifecycle as the perf HUD.
  const playerHud = new PlayerHud(profile);
  const social = new SocialClient(profile.username);
  const chat = new ChatPanel(social, profile);
  mountLeftDock(profile);

  // Single login: the server deletes every older session on a new login and
  // pushes `kicked` down the old tabs' social streams. Nothing here is worth
  // saving — the session is already gone — so block the UI and offer a reload.
  social.onKicked = () => {
    showKickedOverlay();
  };

  // Matchmaker result — SSE-pushed so it lands even with every panel closed.
  // Announce in the world channel, and in the hub bounce the rooms panel so
  // it opens straight onto the formed match (a reopen refreshes immediately;
  // the poll alone would take up to 2.5 s).
  social.onMatch = ({ name }) => {
    chat.announce(`⚔ Match found — ${name}. Your party is assembled.`);
    if (document.body.dataset.scene === "village") {
      closeRoomsPanel();
      openRoomsPanel();
    }
  };

  // Someone else in our matchmade lobby flipped their ready dot — repaint now
  // instead of up to 2.5 s from now. A no-op when the panel is shut; the
  // auto-launch itself rides `partyLaunch` below and needs no panel at all.
  social.onLobbyReady = () => {
    refreshRoomsPanel();
  };

  // Party invite — a popup, immediately. The chat line stays as the receipt
  // (the card auto-dismisses, and a declined or expired invitation still
  // waits in the Boss Queue panel's Invitations list), but the card is what
  // makes an invite arrive rather than sit there unnoticed.
  social.onInvite = ({ roomId, name, from }) => {
    chat.announce(`✉ ${from} invited you to their party — ${name}.`);
    showPartyInvite({ roomId, name, from }, { onJoin: joinRoom, onDecline: declineInvite });
  };

  // Friend request — a popup, for the invite card's reason. Tapping a villager
  // and pressing Add Friend reached the other player instantly already, but
  // only as a row in a panel they may never have opened. The chat line is the
  // receipt; the card is what makes the ask arrive. Both verbs post through
  // the same friendOp the chat panel's ✓/✕ buttons use, so answering here and
  // answering there are the same act.
  social.onFriendRequest = ({ from, hero }) => {
    chat.announce(`✦ ${from} wants to be friends.`);
    showFriendRequest(
      { from, hero },
      {
        onAccept: (username) => social.friendOp("accept", username),
        onDecline: (username) => social.friendOp("decline", username),
      }
    );
  };

  // The party leader started the fight: every member walks into the arena on
  // their own client, through the same admission gate the portal uses. The
  // ready barrier in the arena scene then holds the countdown until everyone
  // has finished loading — which is what makes "start together" true.
  //
  // A member who declines the paid entry (or is refused) tells the server
  // they are not coming, so the rest are not held for the full timeout.
  // Latched for the whole trip into the arena. `document.body.dataset.scene`
  // is not enough on its own: it only flips to "arena" AFTER the factory (and
  // the ready barrier) finish, so a second push during the minute-long load
  // would still read "village" and start a second — separately charged —
  // entry. Cleared when we are back in the village.
  let enteringArena = false;
  social.onPartyLaunch = ({ difficulty }) => {
    // Already in the arena, or on the way there: the push is a duplicate.
    if (enteringArena || document.body.dataset.scene !== "village") return;
    enteringArena = true;
    // The room's difficulty is authoritative for the whole party — a member
    // whose panel was closed never ran the room view's coercion.
    if (difficulty && (DIFFICULTY_ORDER as readonly string[]).includes(difficulty)) {
      setDifficulty(difficulty as FightDifficulty);
    }
    chat.announce("⚔ Your leader started the fight — entering the arena…");
    closeRoomsPanel();
    void enterRankedArena()
      .then((entered) => {
        // Staying behind: tell the server, or the teammates who ARE loading
        // wait out the barrier's full timeout on someone who never left.
        if (!entered) void postFightSkip().catch(() => undefined);
      })
      .finally(() => {
        enteringArena = false;
      });
  };

  // Presence beacon: pagehide is the last reliable moment a closing (or
  // backgrounding-to-death) tab gets, and sendBeacon outlives the page where
  // a fetch would be cancelled. No headers or body — the HttpOnly session
  // cookie rides along and is all the server needs.
  window.addEventListener("pagehide", () => {
    navigator.sendBeacon?.("/api/presence/offline");
  });

  // Texture pipeline must be configured BEFORE anything loads a texture.
  configureTexturePipeline();

  // The status callback narrates backend selection on the boot line —
  // "creating engine (webgpu)…" stuck for 8 s, then "webgpu failed — trying
  // webgl2…" is a complete diagnosis in a screenshot, which is the only
  // debugging channel a phone in the field has.
  // From here to "the village is up" is the stretch that has historically
  // wedged on phones (WebGPU init hangs, warm-up deadlocks, a GL context that
  // dies under texture pressure). Arm the recovery buttons for the case where
  // it wedges without throwing — a silent hang has no catch block to land in.
  bootMsg.textContent = "creating engine…";
  const stallTimer = armBootStallEscape();
  // `surface` is not always the element we looked up: recovering from a failed
  // WebGPU init means abandoning the canvas WebGPU claimed (core/engine.ts
  // freshCanvas). Everything below binds to the survivor, or it is listening to
  // a detached node and measuring a canvas nothing renders into.
  const { engine, backend, canvas: surface } = await createEngine(canvas, (msg) => {
    bootMsg.textContent = msg;
  });
  applyResolutionPolicy(engine);

  // A lost WebGL context is how iOS Safari says "out of GPU memory": every gl
  // call afterwards is a no-op, gl.createBuffer() returns null, and whatever
  // Babylon touches next throws something cryptic like "Unable to create
  // uniform buffer". Catch the loss itself and name the actual problem —
  // downstream error text sends people debugging uniform buffers on a device
  // that simply ran out of memory. No preventDefault: we don't attempt a
  // context restore, a reload is the honest recovery.
  surface.addEventListener("webglcontextlost", () => {
    // Ours, on the way out of the page — not the device's. Reporting a crash
    // over a departing page would also paint the failure screen into the last
    // frame the player sees before the reload.
    if (unloading) return;
    console.error(`[engine] WebGL context lost (${gfxSummary()})`);
    contextLost = true;
    boot.classList.remove("done");
    bootMsg.textContent =
      `failed: graphics context lost [${gfxSummary()}] — the device ran out of GPU memory. Close other tabs and reload.`;
    // The message says "reload" and the device it happens on may have no way
    // to do that; give it one.
    bootEscapeHatches();
  });

  // Hand the GPU back before the next page asks for one.
  //
  // iOS Safari does not free a departing page's WebGL context promptly, so the
  // incoming page builds a second village alongside the outgoing one's ~70 MB
  // of textures and loses the race for a context — a black screen wearing the
  // boot screen's escape buttons. "Switch Character" in the left dock IS a
  // `location.reload()`, which is why booting once and dying on the hero
  // switch was the shape of it.
  //
  // Registered here rather than beside the presence beacon above because it
  // needs the engine, and a navigation during boot would otherwise reach this
  // before `createEngine` resolved.
  //
  // Release UNCONDITIONALLY — `persisted` is not trustworthy enough to gate
  // this on.
  //
  // The first cut skipped disposal when `e.persisted` was true, reasoning that
  // the bfcache might restore the page intact. But iOS bfcaches aggressively
  // and reports `persisted` on paths that are really navigations, and the two
  // ways of being wrong are not symmetric: skipping disposal on a real
  // navigation leaks the context and is exactly the failure being chased,
  // while disposing a page that does come back costs one reload, which the
  // `pageshow` handler below already performs. So always release, and let
  // pageshow clean up after the rare restore.
  window.addEventListener("pagehide", () => {
    unloading = true;
    releaseGraphics(engine);
  });

  // Whenever a page comes back from the bfcache its engine is gone — pagehide
  // above always disposes — so boot again rather than present a corpse.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && unloading) location.reload();
  });

  const manager = new SceneManager(engine);
  const hud = new PerfHud();

  /**
   * Switch scenes and re-attach the HUD.
   *
   * The re-attach is not optional: `SceneInstrumentation` is bound to a
   * specific Scene, and the old one dies with `scene.dispose()`. Miss this and
   * the draw-call counter silently freezes at the last value from the previous
   * scene — a perf HUD that lies is worse than no perf HUD.
   */
  async function go(id: keyof typeof SCENES): Promise<void> {
    const entry = SCENES[id];
    boot.classList.remove("done");
    bootMsg.textContent = `building ${entry.label.toLowerCase()} + compiling shaders… [${backend}]`;
    resetLoadProgress();
    bootBarArm(id);

    // Kill the live scene (and its HTMLAudio OST / VO) *before* the paint
    // yield. Otherwise the boot overlay shows for a frame while the old boss
    // music keeps running, and the input that requested the switch can
    // re-fire the OST autoplay-unlock listener and blip a half-note of
    // fight music into the next scene. switchTo() dispose is then a no-op.
    manager.disposeCurrent();

    // Yield a frame so the boot overlay actually paints before the main thread
    // disappears into scene construction and shader compilation.
    await new Promise(requestAnimationFrame);

    const scene = await manager.switchTo(id, entry.factory);
    bootBarDone(id);
    hud.attach(scene);
    // Published like data-controls: persistent chrome (the left dock) scopes
    // itself per scene with CSS instead of subscribing to the manager.
    document.body.dataset.scene = id;
    boot.classList.add("done");
  }

  // Boot into the village. It is the hub, it is the first thing a player sees,
  // and it is where the loop starts (doc 01).
  await go("village");
  // Made it. Nothing wedged, so the recovery buttons must never appear.
  clearTimeout(stallTimer);

  engine.runRenderLoop(() => {
    const active = manager.active;
    if (!active) return;
    active.render();
    hud.update(active, engine.getDeltaTime() / 1000, backend);
  });

  /**
   * Resize, coalesced and deduplicated.
   *
   * `engine.resize()` is not cheap: it reallocates the backbuffer and every
   * render target hanging off the pipeline — MSAA, the bloom chain, the shadow
   * map. Mobile browsers fire `resize` in bursts, once per animation frame of the
   * URL bar sliding in or out, and that bar slides in response to touch drags. A
   * naive handler therefore turns "player moved their thumb" into a dozen full
   * reallocations and a visible freeze.
   *
   * Two guards. Coalesce to one call per frame, and then only act if the pixel
   * size actually changed — an orientation change or a real window drag gets
   * through, browser chrome sliding over a fixed-size canvas does not.
   */
  let resizePending = 0;
  let lastKey = "";
  const onResize = (): void => {
    if (resizePending) return;
    resizePending = requestAnimationFrame(() => {
      resizePending = 0;
      // The scaling policy first: it is an input to the size we are about to
      // compare against.
      applyResolutionPolicy(engine);
      // Compare the size the canvas WANTS, not `getRenderWidth()` — that reports
      // the current backbuffer, which has not changed yet, so it would compare
      // old against old and never fire a second resize.
      const key = `${surface.clientWidth}x${surface.clientHeight}@${engine.getHardwareScalingLevel()}`;
      if (key === lastKey) return;
      lastKey = key;
      engine.resize();
    });
  };
  window.addEventListener("resize", onResize);
  // Orientation changes report the OLD size on the resize event on some mobile
  // browsers, so re-check once the new layout has settled.
  window.addEventListener("orientationchange", onResize);

  window.addEventListener("keydown", async (e) => {
    // A text field (chat box, rooms panel) owns the keyboard while focused.
    // Same gate as every other gameplay key handler.
    if (isTypingInField()) return;

    // Dev affordance: Babylon's Inspector is the lookdev tool. Loaded lazily so
    // its ~2 MB never lands in the shipped bundle or the download budget.
    if (e.key.toLowerCase() === "i" && e.altKey) {
      const active = manager.active;
      if (!active) return;
      await import("@babylonjs/core/Debug/debugLayer");
      await import("@babylonjs/inspector");
      if (active.debugLayer.isVisible()) active.debugLayer.hide();
      else await active.debugLayer.show({ embedMode: true, overlay: true });
    }
  });

  // Expose for console poking and for the soak test in sceneManager.ts.
  Object.assign(window, {
    psyrena: {
      engine, manager, hud, go, SCENES, profile, player, playerHud, social, chat,
      /**
       * Give the GPU back, then run `then` — for code that is about to
       * navigate. "Switch Character" (ui/leftDock.ts) reloads the page, and
       * doing this first is deterministic in a way `pagehide` is not: the
       * context is gone before the navigation starts rather than during it,
       * which is the difference between the next page finding a free GPU and
       * finding ours still on it.
       */
      releaseGraphics: (then?: () => void) => {
        unloading = true;
        releaseGraphics(engine);
        then?.();
      },
    },
  });
}

main().catch((err) => {
  console.error(err);
  // A thrown boot is exactly the state the recovery buttons exist for, and
  // that holds for the context-lost path too — its handler wrote the better
  // message and its own buttons, so only the text is left alone here.
  if (contextLost) return; // the contextlost handler already named the real cause
  // The gfx summary rides along because on a phone this line IS the bug
  // report: no console, no inspector, just a screenshot of the boot screen.
  boot.classList.remove("done");
  bootMsg.textContent = `failed: ${err instanceof Error ? err.message : String(err)} [${gfxSummary()}]`;
  bootEscapeHatches();
});
