/**
 * Pre-game DOM flow: login → intro guide → hero picker → resolve with the
 * player's profile.
 *
 * Deliberately plain DOM, like the perf HUD and control legend: these screens
 * exist before the Babylon engine is even created, so a GUI texture is not an
 * option, and DOM text beats canvas text for form inputs anyway. The whole
 * feature lives in this one module — markup, styles, fetch calls — so ripping
 * it out or restyling it never touches a scene.
 *
 * Server contract: server/app.mjs. Session is an HttpOnly cookie, so a page
 * reload lands on GET /api/me and skips the login form.
 */

import { enterFullscreen, fullscreenSupported, isStandalone } from "./fullscreen";

export interface Profile {
  username: string;
  createdAt: string;
  rank: string;
  title: string;
  score: number;
  season: string;
  stats: { battles: number; wins: number; bossesDefeated: number; playtimeMin: number };
  selectedHero: string;
  unlockedHeroes: string[];
  /**
   * Battle record per hero actually played, most-played first (server
   * hero_records — one upsert per fight report). Heroes with no battles have
   * no entry. Optional so a stale cached profile shape still parses.
   */
  heroStats?: {
    heroId: string;
    battles: number;
    wins: number;
    bossesDefeated: number;
    bestScore: number;
    bestDps: number;
    fastestMs: number | null;
  }[];
}

/**
 * Display metadata for the picker. `img` is the hero's avatar, used by the
 * picker AND — through `heroPortrait` — by every in-game surface.
 *
 * These are ORIGINAL cartoon-sketch illustrations (`tools/gen-roster-avatars.sh`,
 * prompts in assets/work/roster-avatars/). They replaced reference photographs
 * of the real psychologists, which were other people's copyrighted images; the
 * sketches are drawn as light period archetypes, not portrait likenesses.
 * Files: public/assets/heroes/<id>_sketch.webp.
 */
export const ROSTER: { id: string; name: string; epithet: string; role: string; img: string }[] = [
  { id: "freud", name: "Freud", epithet: "The Analyst", role: "DPS", img: "freud_sketch.webp" },
  // Tank since 2026-08-03 (docs/03 §8) — classical conditioning is a theory
  // about controlling what an organism responds to, which is the tank's job.
  { id: "pavlov", name: "Pavlov", epithet: "The Conditioner", role: "Tank", img: "pavlov_sketch.webp" },
  { id: "skinner", name: "Skinner", epithet: "The Reinforcer", role: "Healer", img: "skinner_sketch.webp" },
  { id: "kohlberg", name: "Kohlberg", epithet: "The Arbiter", role: "DPS", img: "kohlberg_sketch.webp" },
  { id: "bronfenbrenner", name: "Bronfenbrenner", epithet: "The Ecologist", role: "Support", img: "bronfenbrenner_sketch.webp" },
  { id: "vygotsky", name: "Vygotsky", epithet: "The Scaffolder", role: "Support", img: "vygotsky_sketch.webp" },
  { id: "erikson", name: "Erikson", epithet: "The Crisis-Walker", role: "Support", img: "erikson_sketch.webp" },
  { id: "piaget", name: "Piaget", epithet: "The Constructor", role: "Tank", img: "piaget_sketch.webp" },
  { id: "maslow", name: "Maslow", epithet: "The Provider", role: "Healer", img: "maslow_sketch.webp" },
  { id: "seligman", name: "Seligman", epithet: "The Optimist", role: "Healer", img: "seligman_sketch.webp" },
  // Hidden from the picker for now — re-add when their kits land.
  // { id: "csikszentmihalyi", name: "Csikszentmihalyi", epithet: "The Flowkeeper", role: "Support", img: "csikszentmihalyi_sketch.webp" },
  { id: "bandura", name: "Bandura", epithet: "The Mirror", role: "Flex", img: "bandura_sketch.webp" },
  // { id: "beck", name: "Beck", epithet: "The Reframer", role: "Healer", img: "beck_sketch.webp" },
  { id: "ainsworth", name: "Ainsworth", epithet: "The Safe Haven", role: "Tank", img: "ainsworth_sketch.webp" },
];

/**
 * Whole-figure concept renders, cropped at 424×600 from each hero's keyart
 * plate (F2 / P2b / S2b) — see docs/design-prompts.md. Style Lab skin tiles
 * only. Freud, Pavlov and Skinner have keyart; everyone else falls back to
 * their avatar.
 *
 * There is deliberately no concept-art AVATAR override any more: the roster
 * sketches are the avatar on every surface, so the game has one avatar style
 * rather than two.
 */
const CONCEPT_FULL_BODY: Record<string, string> = {
  freud: "freud_concept_full.webp",
  pavlov: "pavlov_concept_full.webp",
  skinner: "skinner_concept_full.webp",
};

/** WoW-class-style accent color per role, used on role labels in the picker. */
const ROLE_COLOR: Record<string, string> = {
  Tank: "#c69b6d",
  DPS: "#ff5a5f",
  Control: "#69ccf0",
  Support: "#d9a6ff",
  Healer: "#57d977",
  Flex: "#ff9a3d",
};

/** In-game avatar for a hero id — the roster sketch (HUD, gear, chat, codex). */
export function heroPortrait(id: string): string {
  const hero = ROSTER.find((h) => h.id === id);
  return `/assets/heroes/${hero?.img ?? "freud_sketch.webp"}`;
}

/** Whole-body concept render for a hero id — the Style Lab skin tiles. */
export function heroFullBody(id: string): string {
  if (CONCEPT_FULL_BODY[id]) return `/assets/heroes/${CONCEPT_FULL_BODY[id]}`;
  return heroPortrait(id);
}

const CSS = `
#auth {
  position: fixed; inset: 0; z-index: 50; overflow-y: auto;
  /* Safe-area: the hero-picker grid runs to 96vw, which on a landscape iPhone
     reaches under the camera housing without this. */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
           env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  box-sizing: border-box;
  background:
    radial-gradient(1200px 700px at 50% -10%, #101a30 0%, transparent 60%),
    radial-gradient(900px 500px at 85% 110%, #1a0f24 0%, transparent 55%),
    #04070c;
  color: #d8f7ff;
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  display: grid; place-items: center;
}
#auth .panel { display: grid; justify-items: center; gap: 14px; padding: 28px 16px; }
#auth img.logo {
  width: min(240px, 48vmin); height: auto; border-radius: 50%;
  filter: drop-shadow(0 0 34px rgba(64, 160, 255, .35));
}
#auth .wordmark { font-size: 30px; letter-spacing: .42em; margin-left: .42em; font-weight: 600; }
#auth .tagline { font-size: 11px; letter-spacing: .18em; color: #7fdcf0; opacity: .8; }
#auth form { display: grid; gap: 10px; width: min(300px, 84vw); margin-top: 8px; }
#auth input {
  background: #0a1220; color: #d8f7ff; border: 1px solid #23405c; border-radius: 6px;
  padding: 10px 12px; font: inherit; letter-spacing: .05em; outline: none;
}
#auth input:focus { border-color: #40e6ff; box-shadow: 0 0 0 1px #40e6ff44; }
#auth button.cta {
  background: linear-gradient(180deg, #1c5a78, #123a52); color: #eaffff;
  border: 1px solid #40e6ff88; border-radius: 6px; padding: 11px 12px;
  font: inherit; letter-spacing: .28em; cursor: pointer; text-transform: uppercase;
}
#auth button.cta:hover:not(:disabled) { filter: brightness(1.25); }
#auth button.cta:disabled { opacity: .35; cursor: default; }
#auth .err { color: #ff8896; font-size: 12px; min-height: 18px; text-align: center; }
#auth .swap {
  background: none; border: none; padding: 4px; color: #8fd8e8; cursor: pointer;
  font: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 3px;
}
#auth .swap:hover { color: #40e6ff; }
/* Add-to-Home-Screen pop-up (iPhone-only; see showHomescreenPopup). */
#auth .a2hs-pop {
  position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
  background: #04070ccc; backdrop-filter: blur(3px);
}
#auth .a2hs-card {
  display: grid; gap: 14px; justify-items: center; text-align: center;
  width: min(360px, 86vw); box-sizing: border-box; padding: 22px 20px;
  border: 1px solid #23405c; border-radius: 12px; background: #0a1220f2;
  box-shadow: 0 18px 60px #000c;
}
#auth .a2hs-title { font-size: 14px; letter-spacing: .22em; color: #d8f7ff; font-weight: 600; }
#auth .a2hs-body { font-size: 12px; line-height: 1.8; color: #7fdcf0; }
#auth .a2hs-card .cta { width: 100%; }

/* ---- hero picker (WoW-style character select) ---- */
/* .wow is stamped on #auth only while the picker is mounted: block layout so
   .pick can be an exact-viewport grid, and an ember/gold backdrop instead of
   the login screen's blue. */
#auth.wow {
  display: block; overflow: hidden;
  background:
    radial-gradient(1100px 640px at 50% -12%, #2a2113 0%, transparent 60%),
    radial-gradient(820px 520px at 92% 108%, #241109 0%, transparent 55%),
    radial-gradient(700px 460px at 4% 102%, #191307 0%, transparent 50%),
    #070604;
}
#auth .pick {
  /* Explicit width: Chrome refuses to stretch an auto-width grid here while
     the parent still carries place-items from the login layout. */
  width: 100%; height: 100%; max-width: 1360px; margin: 0 auto;
  box-sizing: border-box; padding: 14px 16px;
  display: grid; gap: 12px 18px;
  grid-template-columns: 272px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas: "info roster" "enter enter";
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  color: #e8d9b0;
}
#auth .gold-text {
  background: linear-gradient(180deg, #ffedb0, #ecc363 55%, #a87c28);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
/* Selected-hero showcase + account panel. border-image gives the metallic
   gold frame (square corners are the point — WoW panels aren't rounded). */
#auth .account {
  grid-area: info; min-height: 0; overflow-y: auto;
  display: grid; gap: 10px; align-content: start;
  padding: 16px 14px;
  border: 1px solid transparent;
  border-image: linear-gradient(160deg, #8a6d2f, #e2c47c 30%, #5a4620 62%, #b0914e) 1;
  background: linear-gradient(180deg, #171106f0, #0b0804f0);
  box-shadow: 0 0 0 1px #000, 0 14px 44px #000d, inset 0 0 70px #00000073;
}
#auth .heroview { display: grid; gap: 4px; justify-items: center; }
#auth .hv-img {
  width: min(178px, 70%); aspect-ratio: 1; object-fit: cover; object-position: 50% 18%;
  border: 2px solid #8a6d2f; box-shadow: 0 0 0 1px #000, 0 0 26px #000a; margin-bottom: 6px;
}
#auth .hv-name {
  font-size: 23px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
  text-align: center;
}
#auth .hv-ep { font-style: italic; font-size: 13px; color: #cdbb90; text-align: center; }
#auth .hv-role { font-size: 11px; letter-spacing: .32em; margin-left: .32em; text-transform: uppercase; font-weight: 600; }
#auth .hv-rec { font-size: 11px; color: #b8a878; text-align: center; }
#auth .rule { height: 1px; background: linear-gradient(90deg, transparent, #8a6d2f, transparent); }
#auth .meta { display: grid; gap: 4px; }
#auth .account .who { text-align: center; font-size: 15px; letter-spacing: .12em; color: #f4e3b2; }
#auth .account .title { text-align: center; color: #ecc363; font-style: italic; font-size: 12px; letter-spacing: .06em; }
#auth .account dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 4px 0 0; font-size: 12px; }
#auth .account dt { color: #b8a878; }
#auth .account dd { margin: 0; text-align: right; color: #e8d9b0; }
#auth .account .season { grid-column: 1 / -1; text-align: center; color: #b49ae0; font-size: 11px;
  letter-spacing: .1em; border-top: 1px solid #3a2d14; padding-top: 8px; margin-top: 4px; }
/* Same dress as the Enter CTA, in steel blue — a real button, scaled to the
   account panel so it can't be mistaken for the one that starts the game. */
#auth .account .logout {
  font-family: inherit; font-size: 11px; cursor: pointer; border-radius: 0;
  padding: 7px 18px; letter-spacing: .2em; text-indent: .2em;
  color: #d6e6ff; text-shadow: 0 1px 2px #000;
  background: linear-gradient(180deg, #2a4a6e, #16283f 55%, #0d1a2c);
  border: 1px solid transparent;
  border-image: linear-gradient(180deg, #e8c878, #7a5f2a) 1;
  box-shadow: 0 0 0 1px #000, 0 4px 12px #000b, inset 0 1px 0 #ffffff2b;
  justify-self: center; margin-top: 2px;
}
#auth .account .logout:hover { filter: brightness(1.3); box-shadow: 0 0 14px #6fa8e055, 0 0 0 1px #000; }

#auth .roster { grid-area: roster; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 10px; }
#auth h2 {
  margin: 0; text-align: center; font-size: 15px; font-weight: 700;
  letter-spacing: .38em; text-indent: .38em;
}
/* The grid's column/row tracks are set from JS (layout()) so every hero tile
   fits the wrap without scrolling where the screen allows — on screens too
   short for readable no-scroll tiles the grid wraps at a minimum tile size
   and scrolls vertically instead. See heroPicker. */
#auth .gridwrap { min-height: 0; overflow-y: auto; }
#auth .grid { min-height: 100%; display: grid; gap: 10px; justify-content: center; align-content: center; }
#auth .hero {
  position: relative; overflow: hidden; cursor: pointer; container-type: size;
  border: 1px solid #5a4620; background: #000;
  box-shadow: 0 0 0 1px #000, inset 0 0 0 1px #2c220f;
  transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
}
#auth .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 18%; }
#auth .hero .plate {
  position: absolute; left: 0; right: 0; bottom: 0; display: grid; gap: 1px;
  padding: 22cqw 5cqw 6cqw; text-align: center;
  background: linear-gradient(180deg, transparent, #000000e0 62%);
}
#auth .hero .nm { font-size: clamp(10px, 12cqw, 15px); letter-spacing: .05em; color: #f4e3b2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#auth .hero .ep { font-size: clamp(8px, 9cqw, 11px); font-style: italic; color: #b8a878;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#auth .hero .rl { font-size: clamp(7px, 8cqw, 10px); letter-spacing: .22em; font-weight: 600; text-transform: uppercase; }
#auth .hero:hover:not(.locked) { transform: translateY(-2px); border-color: #e2c47c;
  box-shadow: 0 0 16px #ecc36344, 0 0 0 1px #000; }
#auth .hero.sel { border-color: #ffd77a;
  box-shadow: 0 0 24px #f0c85a77, inset 0 0 20px #f0c85a26, 0 0 0 1px #000; }
#auth .hero.sel::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 1px #ffd77a99; }
#auth .hero.locked { cursor: not-allowed; }
#auth .hero.locked img { filter: grayscale(1) brightness(.35) sepia(.25); }
#auth .hero.locked .nm, #auth .hero.locked .ep, #auth .hero.locked .rl { opacity: .4; }
#auth .hero .lock { position: absolute; top: 6cqw; right: 6cqw; font-size: clamp(11px, 13cqw, 17px);
  filter: drop-shadow(0 1px 2px #000); }

/* Enter bar — WoW's big red Enter World button, always visible bottom center. */
#auth .enterbar { grid-area: enter; display: grid; justify-items: center; gap: 5px; }
#auth .enterbar .cta {
  font-family: inherit; border-radius: 0; min-width: min(300px, 80vw);
  padding: 13px 36px; font-size: 14px; letter-spacing: .3em; text-indent: .3em;
  color: #ffe9b0; text-shadow: 0 1px 2px #000;
  background: linear-gradient(180deg, #8c2014, #55100a 55%, #3c0a05);
  border: 1px solid transparent;
  border-image: linear-gradient(180deg, #e8c878, #7a5f2a) 1;
  box-shadow: 0 0 0 1px #000, 0 8px 22px #000b, inset 0 1px 0 #ffffff2b;
}
#auth .enterbar .cta:hover:not(:disabled) { filter: brightness(1.3); box-shadow: 0 0 20px #f0c85a55, 0 0 0 1px #000; }
#auth .enterbar .hint { font-size: 11px; color: #b8a878; letter-spacing: .08em; text-align: center; }
#auth .enterbar .err { min-height: 0; }

/* ---- intro guide (one page between login and the picker: what you fight,
   how you control, what to explore — keywords only, icons from
   public/assets/ui/intro). Shares the picker's ember/gold .wow dress. ---- */
#auth .intro {
  width: 100%; height: 100%; box-sizing: border-box; overflow-y: auto;
  display: grid; align-content: center; justify-items: center; gap: 14px;
  padding: 18px 16px;
  font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  color: #e8d9b0; text-align: center;
}
#auth .ittl { font-size: 24px; font-weight: 700; letter-spacing: .3em; text-indent: .3em; }
#auth .isub { font-size: 11px; letter-spacing: .3em; text-indent: .3em; color: #b8a878; }
#auth .cards { display: grid; grid-template-columns: repeat(3, minmax(190px, 250px)); gap: 12px; }
#auth .gcard {
  display: grid; justify-items: center; align-content: start; gap: 8px; padding: 16px 12px;
  border: 1px solid transparent;
  border-image: linear-gradient(160deg, #8a6d2f, #e2c47c 30%, #5a4620 62%, #b0914e) 1;
  background: linear-gradient(180deg, #171106f0, #0b0804f0);
  box-shadow: 0 0 0 1px #000, 0 14px 44px #000d, inset 0 0 70px #00000073;
}
#auth .gcard img { width: 64px; height: 64px; }
#auth .gt { font-size: 14px; font-weight: 700; letter-spacing: .3em; text-indent: .3em; }
#auth .kw { font-size: 12.5px; color: #cdbb90; letter-spacing: .06em; line-height: 1.75; }
#auth .kw b { color: #f4e3b2; font-weight: 600; }
#auth .intro .cta {
  font-family: inherit; border-radius: 0; min-width: min(300px, 80vw);
  padding: 12px 32px; font-size: 13px; letter-spacing: .3em; text-indent: .3em;
  color: #ffe9b0; text-shadow: 0 1px 2px #000;
  background: linear-gradient(180deg, #8c2014, #55100a 55%, #3c0a05);
  border: 1px solid transparent;
  border-image: linear-gradient(180deg, #e8c878, #7a5f2a) 1;
  box-shadow: 0 0 0 1px #000, 0 8px 22px #000b, inset 0 1px 0 #ffffff2b;
}
#auth .intro .cta:hover { filter: brightness(1.3); box-shadow: 0 0 20px #f0c85a55, 0 0 0 1px #000; }
/* Narrow: cards stack as icon-left rows so the page never needs two columns
   of eye travel on a portrait-ish window. */
@media (max-width: 700px) {
  #auth .cards { grid-template-columns: minmax(0, 1fr); width: min(420px, 92vw); }
  #auth .gcard {
    grid-template-columns: 48px minmax(0, 1fr); justify-items: start; text-align: left;
    gap: 2px 14px; padding: 10px 12px; align-items: center;
  }
  #auth .gcard img { grid-row: 1 / 3; width: 48px; height: 48px; }
}
/* Short landscape (phones): compact everything so page + CTA fit one screen. */
@media (max-height: 460px) {
  #auth .intro { gap: 8px; padding: 10px 12px; }
  #auth .ittl { font-size: 16px; }
  #auth .isub { display: none; }
  #auth .gcard { padding: 8px 10px; gap: 3px; }
  #auth .gcard img { width: 36px; height: 36px; }
  #auth .gt { font-size: 11px; }
  #auth .kw { font-size: 10.5px; line-height: 1.5; }
  #auth .intro .cta { padding: 8px 20px; font-size: 11px; min-width: min(240px, 70vw); }
}

/* Narrow / short screens: the showcase becomes an uncompressed top banner —
   hero identity left, account identity right, stats on their own row. */
@media (max-width: 760px), (max-height: 620px) {
  #auth .pick {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: "info" "roster" "enter";
    gap: 10px; padding: 8px 10px 10px;
  }
  #auth .account {
    overflow: visible;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "hv meta" "stats stats";
    gap: 6px 12px; padding: 10px 12px;
  }
  #auth .heroview {
    grid-area: hv; grid-template-columns: 62px minmax(0, 1fr);
    gap: 1px 12px; justify-items: start; align-content: center;
  }
  #auth .hv-img { grid-row: 1 / 4; width: 62px; margin-bottom: 0; align-self: center; }
  #auth .hv-name { font-size: 17px; text-align: left; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #auth .hv-ep { font-size: 12px; text-align: left; max-width: 100%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #auth .hv-role { font-size: 10px; letter-spacing: .26em; margin-left: 0; }
  #auth .rule { display: none; }
  #auth .meta { grid-area: meta; align-content: center; justify-items: end; gap: 2px; }
  #auth .account .who { font-size: 12px; letter-spacing: .1em; text-align: right; }
  #auth .account .title { font-size: 11px; text-align: right; }
  #auth .account .logout { justify-self: end; font-size: 10px; white-space: nowrap; padding: 5px 12px; }
  #auth .account dl {
    grid-area: stats; margin: 0; padding-top: 7px; border-top: 1px solid #3a2d14;
    grid-template-columns: repeat(3, auto minmax(0, 1fr));
    align-items: baseline; gap: 3px 8px; font-size: 11px;
  }
  #auth .account dt { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
  #auth .account dd { text-align: left; font-size: 12px; }
  #auth .account .season { display: none; }
  #auth h2 { font-size: 12px; letter-spacing: .3em; text-indent: .3em; }
  #auth .enterbar .cta { min-width: min(260px, 86vw); padding: 11px 24px; font-size: 12px; letter-spacing: .24em; }
}
/* Very short landscape: keep only the identity rows of the banner and give
   every reclaimed pixel to the roster grid. */
@media (max-height: 430px) {
  #auth .account dl { display: none; }
  #auth .account { padding: 6px 10px; }
  #auth .hv-img { width: 44px; grid-row: 1 / 4; }
  #auth .hv-name { font-size: 14px; }
  #auth .hv-ep { font-size: 11px; }
  #auth .pick { gap: 6px; padding: 6px 10px 8px; }
  #auth h2 { display: none; }
  #auth .enterbar .hint { display: none; }
  #auth .enterbar .cta { padding: 8px 20px; font-size: 11px; }
}
`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/**
 * "Add to Home Screen" pop-up, shown over the first auth screen the player
 * lands on (login form, or the hero picker when a session cookie skips login).
 *
 * Shown only when it is the player's ONLY route to fullscreen: a touch device
 * whose browser has no element-fullscreen API (in practice every
 * default-config iPhone — Safari feature-flags it off there, see
 * ui/fullscreen.ts) and that isn't already running from the home screen.
 * Android and iPad get real fullscreen off the Enter tap, so the pop-up would
 * only be noise there.
 *
 * Dismissal is remembered in sessionStorage, the same policy as the rotate
 * gate in main.ts: once per sitting is a helpful nudge, every reload is
 * nagging, and never again is wrong for a player who ignored it once but
 * would install on the day it clicks. The write is guarded because Safari
 * throws on storage access in Private mode.
 */
const A2HS_KEY = "psyrena.a2hsAck";

function showHomescreenPopup(root: HTMLElement): void {
  if (document.body.dataset.controls !== "touch") return;
  if (fullscreenSupported() || isStandalone()) return;
  try { if (sessionStorage.getItem(A2HS_KEY)) return; } catch { /* private mode */ }

  const ok = el("button", { class: "cta", type: "button" }, "Got it");
  const pop = el("div", { class: "a2hs-pop", role: "dialog", "aria-label": "Play fullscreen" },
    el("div", { class: "a2hs-card" },
      el("div", { class: "a2hs-title" }, "📲 PLAY FULLSCREEN"),
      el("div", { class: "a2hs-body" },
        "This browser can't go fullscreen on its own. Add Psyrena to your Home Screen and it launches edge-to-edge: tap the Share button, then “Add to Home Screen”."),
      ok,
    ),
  );
  const close = (): void => {
    try { sessionStorage.setItem(A2HS_KEY, "1"); } catch { /* private mode */ }
    pop.remove();
  };
  ok.addEventListener("click", close);
  // Tapping the backdrop dismisses too — a modal you can only leave through
  // one small button is hostile on a phone.
  pop.addEventListener("click", (e) => { if (e.target === pop) close(); });
  root.append(pop);
}

function loginScreen(root: HTMLElement): Promise<Profile> {
  return new Promise((resolve) => {
    let mode: "login" | "register" = "login";
    const err = el("div", { class: "err" });
    const user = el("input", {
      placeholder: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false",
    });
    const pass = el("input", { placeholder: "password", type: "password", autocomplete: "current-password" });
    // Registration is invitation-gated (server/admin.mjs): admins mint codes
    // in the console. Shown only in register mode; sent as inviteCode.
    const invite = el("input", {
      placeholder: "invitation code", autocapitalize: "characters", spellcheck: "false",
    }) as HTMLInputElement;
    invite.style.display = "none";
    // Student ID is mandatory whenever a code is redeemed (codes go out per
    // class roster — the ID ties the account to a student, enforced server-side
    // too). Appears as soon as the code box has text.
    const student = el("input", {
      placeholder: "student ID", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
    }) as HTMLInputElement;
    student.style.display = "none";
    const btn = el("button", { class: "cta", type: "submit" }, "Log In");
    const swap = el("button", { class: "swap", type: "button" }, "New here? Create an account");
    const form = el("form", {}, user, pass, invite, student, btn, swap, err);

    const syncStudent = (): void => {
      const needed = mode === "register" && invite.value.trim() !== "";
      student.style.display = needed ? "" : "none";
      student.required = needed;
    };
    invite.addEventListener("input", syncStudent);

    const setMode = (next: "login" | "register"): void => {
      mode = next;
      err.textContent = "";
      btn.textContent = mode === "login" ? "Log In" : "Create Account";
      swap.textContent = mode === "login"
        ? "New here? Create an account"
        : "Have an account? Log in";
      // new-password keeps password managers offering to SAVE rather than fill.
      pass.setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
      pass.setAttribute("placeholder", mode === "login" ? "password" : "password (8+ characters)");
      invite.style.display = mode === "register" ? "" : "none";
      syncStudent();
      if (mode === "register") {
        // Admins can open registration in the console — reflect that in the
        // code box's label so nobody hunts for a code they don't need.
        void api<{ inviteRequired: boolean }>("/api/register/policy")
          .then((p) => { invite.placeholder = p.inviteRequired ? "invitation code" : "invitation code (optional)"; })
          .catch(() => { /* label stays conservative */ });
      }
    };
    swap.addEventListener("click", () => setMode(mode === "login" ? "register" : "login"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (mode === "register" && invite.value.trim() && !student.value.trim()) {
        err.textContent = "Student ID is required when registering with an invitation code.";
        student.focus();
        return;
      }
      btn.disabled = true;
      try {
        resolve(await api<Profile>(
          mode === "login" ? "/api/login" : "/api/register",
          mode === "login"
            ? { username: user.value, password: pass.value }
            : {
                username: user.value, password: pass.value,
                inviteCode: invite.value.trim(), studentId: student.value.trim(),
              },
        ));
      } catch (ex) {
        err.textContent = ex instanceof Error ? ex.message : "Login failed.";
        btn.disabled = false;
        pass.select();
      }
    });

    root.replaceChildren(
      el("div", { class: "panel" },
        el("img", { class: "logo", src: "/assets/login/logo.webp", alt: "Psyrena crest" }),
        el("div", { class: "wordmark" }, "PSYRENA"),
        el("div", { class: "tagline" }, "WHERE THEORIES DO BATTLE"),
        form,
      ),
    );
    user.focus();
  });
}

/**
 * One-page intro guide, shown between login and the hero picker: what the game
 * is (boss fights where skill matters), how to control your theorist, and what
 * there is to explore. Keywords, not sentences — it replaces the control
 * legend that used to sit under the gameplay screen, so the controls card is
 * keyed to the same `data-controls` detection (stamped by main.ts before the
 * auth flow runs) that the controls themselves use.
 */
function introScreen(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const touch = document.body.dataset.controls === "touch";
    const kw = (label: string, action: string): HTMLElement => {
      const line = el("div", { class: "kw" });
      line.append(el("b", {}, label), ` · ${action}`);
      return line;
    };
    const controls = touch
      ? [
          kw("left stick", "move"),
          kw("push far", "run"),
          kw("drag right side", "look"),
          kw("pinch", "zoom"),
          kw("tap buttons", "skills"),
        ]
      : [
          kw("wasd", "move"),
          kw("shift", "run"),
          kw("space", "jump"),
          kw("drag + wheel", "look · zoom"),
          kw("1-5 q e r f", "skills"),
        ];
    const card = (icon: string, title: string, lines: HTMLElement[]): HTMLElement =>
      el("div", { class: "gcard" },
        el("img", { src: `/assets/ui/intro/${icon}.webp`, alt: "" }),
        el("div", { class: "gt gold-text" }, title),
        el("div", { class: "kws" }, ...lines),
      );
    const go = el("button", { class: "cta", type: "button" }, "Continue");
    go.addEventListener("click", () => resolve());

    root.classList.add("wow");
    root.replaceChildren(
      el("div", { class: "intro" },
        el("div", { class: "ittl gold-text" }, "WELCOME TO PSYRENA"),
        el("div", { class: "isub" }, "WHERE THEORIES DO BATTLE"),
        el("div", { class: "cards" },
          card("fight", "FIGHT", [
            kw("arena bosses", "the enemy"),
            kw("telegraphs", "dodge them"),
            kw("skill", "beats stats"),
            kw("tank · healer · dps", "play your role"),
          ]),
          card("controls", "CONTROL", controls),
          card("explore", "EXPLORE", [
            kw("village hub", "home base"),
            kw("gear & skins", "power up"),
            kw("pets", "collect"),
            kw("skills", "build your kit"),
            kw("achievements", "hunt them"),
          ]),
        ),
        go,
      ),
    );
    go.focus();
  });
}

function heroPicker(root: HTMLElement, profile: Profile): Promise<Profile> {
  return new Promise((resolve) => {
    let selected: string | undefined = profile.unlockedHeroes.includes(profile.selectedHero)
      ? profile.selectedHero
      : profile.unlockedHeroes[0];

    const err = el("div", { class: "err" });
    const enter = el("button", { class: "cta", type: "button" }, "Enter Psyrena");
    const tiles = new Map<string, HTMLElement>();

    // Selected-hero showcase — the "character info" pane (left on desktop,
    // top banner on phones).
    const hvImg = el("img", { class: "hv-img", alt: "" });
    const hvName = el("div", { class: "hv-name gold-text" });
    const hvEp = el("div", { class: "hv-ep" });
    const hvRole = el("div", { class: "hv-role" });
    const hvRec = el("div", { class: "hv-rec" });
    const heroview = el("div", { class: "heroview" }, hvImg, hvName, hvEp, hvRole, hvRec);

    const setSelected = (id: string | undefined): void => {
      selected = id;
      tiles.forEach((t, tid) => {
        t.classList.toggle("sel", tid === selected);
        t.setAttribute("aria-pressed", tid === selected ? "true" : "false");
      });
      const h = ROSTER.find((r) => r.id === id);
      if (h) {
        hvImg.src = `/assets/heroes/${h.img}`;
        hvImg.alt = h.name;
        hvName.textContent = h.name;
        hvEp.textContent = h.epithet;
        hvRole.textContent = h.role;
        hvRole.style.color = ROLE_COLOR[h.role] ?? "#f4e3b2";
        // THIS hero's own battle record — the account totals live in the dl
        // below; this line answers "how have I done as them, in this role".
        const rec = profile.heroStats?.find((r) => r.heroId === h.id);
        if (rec) {
          const rate = rec.battles ? Math.round((100 * rec.wins) / rec.battles) : 0;
          const fastest =
            rec.fastestMs != null
              ? ` · best ${Math.floor(rec.fastestMs / 60000)}:${String(Math.floor((rec.fastestMs % 60000) / 1000)).padStart(2, "0")}`
              : "";
          hvRec.textContent =
            `${rec.battles} battle${rec.battles === 1 ? "" : "s"} · ${rec.wins} win${rec.wins === 1 ? "" : "s"}` +
            ` (${rate}%) · top score ${rec.bestScore}${fastest}`;
        } else {
          hvRec.textContent = "No battles as them yet";
        }
      }
      enter.disabled = !h;
    };

    const grid = el("div", { class: "grid" });
    for (const h of ROSTER) {
      const locked = !profile.unlockedHeroes.includes(h.id);
      const rl = el("div", { class: "rl" }, h.role);
      rl.style.color = ROLE_COLOR[h.role] ?? "#f4e3b2";
      const tile = el("div", {
        class: `hero${locked ? " locked" : ""}`,
        role: "button",
        tabindex: locked ? "-1" : "0",
        "aria-pressed": "false",
      },
        el("img", { src: `/assets/heroes/${h.img}`, alt: h.name, loading: "lazy" }),
        el("div", { class: "plate" },
          el("div", { class: "nm" }, h.name),
          el("div", { class: "ep" }, h.epithet),
          rl,
        ),
      );
      if (locked) tile.append(el("div", { class: "lock" }, "🔒"));
      else {
        tile.addEventListener("click", () => setSelected(h.id));
        tile.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(h.id); }
        });
      }
      tiles.set(h.id, tile);
      grid.append(tile);
    }

    // Fit the whole roster on screen: pick the column count that maximises
    // tile size for the wrap's current box, so the page never scrolls. Tracks
    // are set in px because auto-fill/1fr can't trade columns against rows.
    const gridWrap = el("div", { class: "gridwrap" }, grid);
    const TILE_AR = 0.8; // tile width / height
    const GAP = 10;
    // Tiles narrower than this are thumbnails — the portrait is unreadable
    // and the name plate illegible. Phone screens hit this: with little
    // height to trade, the no-scroll optimum is a single row of ~60px tiles.
    const MIN_TILE = 84;
    const layout = (): void => {
      const w = gridWrap.clientWidth;
      const hgt = gridWrap.clientHeight;
      if (!w || !hgt) return;
      const n = ROSTER.length;
      let cols = 1;
      let size = 0;
      for (let c = 1; c <= n; c++) {
        const r = Math.ceil(n / c);
        const tw = Math.min((w - GAP * (c - 1)) / c, ((hgt - GAP * (r - 1)) / r) * TILE_AR);
        if (tw > size) { size = tw; cols = c; }
      }
      if (size < MIN_TILE) {
        // The no-scroll fit degenerated into thumbnails. Give up on fitting
        // the height: wrap into as many MIN_TILE-wide columns as the width
        // holds and let .gridwrap scroll vertically through the rows.
        cols = Math.max(1, Math.min(n, Math.floor((w + GAP) / (MIN_TILE + GAP))));
        size = (w - GAP * (cols - 1)) / cols;
      }
      size = Math.min(Math.floor(size), 200);
      grid.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
      grid.style.gridAutoRows = `${Math.floor(size / TILE_AR)}px`;
    };
    new ResizeObserver(layout).observe(gridWrap);

    const s = profile.stats;
    const winRate = s.battles ? Math.round((100 * s.wins) / s.battles) : 0;
    // .meta wraps the account identity so the phone banner can place it as one
    // right-aligned cell opposite the hero identity.
    const meta = el("div", { class: "meta" },
      el("div", { class: "who" }, profile.username.toUpperCase()),
      ...(profile.title ? [el("div", { class: "title" }, `« ${profile.title} »`)] : []),
      el("button", { class: "logout", type: "button" }, "Log Out"),
    );
    const account = el("div", { class: "account" },
      heroview,
      el("div", { class: "rule" }),
      meta,
      el("dl", {},
        el("dt", {}, "Rank"), el("dd", {}, profile.rank),
        el("dt", {}, "Score"), el("dd", {}, String(profile.score)),
        el("dt", {}, "Battles"), el("dd", {}, String(s.battles)),
        el("dt", {}, "Wins"), el("dd", {}, `${s.wins} (${winRate}%)`),
        el("dt", {}, "Bosses down"), el("dd", {}, String(s.bossesDefeated)),
        el("dt", {}, "Playtime"), el("dd", {}, `${Math.floor(s.playtimeMin / 60)}h ${s.playtimeMin % 60}m`),
        el("div", { class: "season" }, profile.season),
      ),
    );
    meta.querySelector(".logout")!.addEventListener("click", async () => {
      await api("/api/logout", {}).catch(() => undefined);
      root.classList.remove("wow");
      resolve(runAuthFlow());
    });

    enter.addEventListener("click", async () => {
      if (!selected) return;
      // Fullscreen first and synchronously in the tap: requestFullscreen needs
      // the gesture's transient activation, and awaiting the network round-trip
      // below first can outlive it. `data-controls` is already stamped by
      // main.ts before the auth flow runs.
      if (document.body.dataset.controls === "touch") void enterFullscreen();
      err.textContent = "";
      enter.disabled = true;
      try {
        resolve(await api<Profile>("/api/select-hero", { hero: selected }));
      } catch (ex) {
        err.textContent = ex instanceof Error ? ex.message : "Could not enter.";
        enter.disabled = false;
      }
    });

    root.classList.add("wow");
    root.replaceChildren(
      el("div", { class: "pick" },
        account,
        el("div", { class: "roster" },
          el("h2", { class: "gold-text" }, "CHOOSE YOUR THEORIST"),
          gridWrap,
        ),
        el("div", { class: "enterbar" },
          enter,
          err,
          el("div", { class: "hint" }, `${profile.unlockedHeroes.length} of ${ROSTER.length} theorists unlocked — defeat bosses to free the rest`),
        ),
      ),
    );

    setSelected(selected);
  });
}

/**
 * Run the whole pre-game flow. Resolves once the player has hit Enter Psyrena;
 * the overlay removes itself. Safe to call again (log out does exactly that).
 */
export async function runAuthFlow(): Promise<Profile> {
  let root = document.getElementById("auth");
  if (!root) {
    document.head.append(el("style", {}, CSS));
    root = el("div", { id: "auth" });
    document.body.append(root);
  }

  // Resume the session if the cookie is still good; otherwise show the form.
  //
  // The Add-to-Home-Screen pop-up is appended AFTER each screen mounts —
  // loginScreen/heroPicker replaceChildren() the root synchronously before
  // their promises settle, so appending any earlier would wipe it. Two call
  // sites because either screen can be the first one a player sees; the
  // sessionStorage ack (and the eligibility gate) makes the second call a
  // no-op when it was already shown or dismissed.
  let profile: Profile;
  try {
    profile = await api<Profile>("/api/me");
  } catch {
    const login = loginScreen(root);
    showHomescreenPopup(root);
    profile = await login;
  }

  // The intro guide sits between login and the picker every time: it is the
  // only place the controls are spelled out now that the in-game legend is
  // gone, and one Continue tap is cheap.
  const intro = introScreen(root);
  showHomescreenPopup(root);
  await intro;

  const picked = heroPicker(root, profile);
  showHomescreenPopup(root);
  const finalProfile = await picked;
  root.remove();
  return finalProfile;
}
