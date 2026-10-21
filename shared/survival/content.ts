/**
 * Survival content as data (docs/survival-design.md §1–§6): difficulties,
 * monsters, elites, bosses, the Recall Test question bank. The sim
 * (`sim.ts`) reads only this; nothing here touches an engine.
 *
 * Reference scale (§3.0): a hero has 1,000 HP and walks at 3.4 m/s. Every
 * enemy is slower than that walk (speeds +10 % on 2026-10-20, Frank: "a little
 * faster" — the fastest minion is now 3.3); one minion alone is harmless, a ring of
 * eight is lethal.
 */

export type DifficultyId = "lucid" | "deep" | "terror";

export interface DifficultyDef {
  id: DifficultyId;
  name: string;
  waves: 20 | 40 | 60;
  recall: { circles: 3 | 4; seconds: number; damagePct: number };
  /** Scales every enemy hit except the Recall Test (which has its own fixed %). */
  damage: number;
  loot: { common: number; jackpot: number; chance: number };
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyDef> = {
  lucid: { id: "lucid", name: "Lucid Dream", waves: 20, recall: { circles: 3, seconds: 15, damagePct: 0.5 }, damage: 0.65, loot: { common: 60, jackpot: 1500, chance: 0.04 } },
  deep: { id: "deep", name: "Deep Sleep", waves: 40, recall: { circles: 4, seconds: 12, damagePct: 0.75 }, damage: 0.85, loot: { common: 120, jackpot: 3000, chance: 0.06 } },
  terror: { id: "terror", name: "Night Terror", waves: 60, recall: { circles: 4, seconds: 10, damagePct: 1.0 }, damage: 1.0, loot: { common: 200, jackpot: 5000, chance: 0.08 } },
};

/** The four wave themes, in cycle order. */
export type Theme = "dreams" | "illusions" | "memory" | "biases";
export const THEMES: Theme[] = ["dreams", "illusions", "memory", "biases"];

export type MinionTrick =
  | "swarm"        // fast, plain contact damage
  | "fall"         // drops from the sky onto a telegraph; never walks
  | "decoy"        // spawns with an invulnerable twin; only the real one takes damage
  | "triangle"     // spawns in threes; while all three live, the triangle between them slows
  | "split"        // 30 % chance on death to split into two weaker copies
  | "fade"         // hits harder the longer it lives
  | "ring"         // throws a ring telegraph at the player now and then
  | "bandwagon";   // faster for each Bandwagon nearby (capped below hero walk)

export interface MinionDef {
  id: string;
  name: string;
  theme: Theme;
  /** Model under /assets/survival/monsters/<model>.glb */
  model: string;
  /** Rigged models play idle/walk/attack/death; rigid ones bob. */
  rigged: boolean;
  speed: number;
  hpMult: number;
  trick: MinionTrick;
  theory: string;
}

export const MINIONS: MinionDef[] = [
  { id: "wisp", name: "Dream Wisp", theme: "dreams", model: "sv-dream-wisp", rigged: false, speed: 3.3, hpMult: 0.8, trick: "swarm", theory: "REM sleep holds the most vivid dreams (Aserinsky & Kleitman, 1953)." },
  { id: "falling", name: "Falling Dream", theme: "dreams", model: "sv-falling-dream", rigged: false, speed: 0, hpMult: 0.6, trick: "fall", theory: "Falling is one of the most common typical dream themes." },
  { id: "afterimage", name: "Afterimage", theme: "illusions", model: "sv-afterimage", rigged: true, speed: 2.64, hpMult: 1, trick: "decoy", theory: "Stare at a colour and its opposite lingers: opponent-process theory (Hering)." },
  { id: "kanizsa", name: "Kanizsa Pac-man", theme: "illusions", model: "sv-kanizsa-pacman", rigged: true, speed: 2.42, hpMult: 0.9, trick: "triangle", theory: "Three notched discs make a triangle that is not there: illusory contours (Kanizsa, 1955)." },
  { id: "falsememory", name: "False Memory", theme: "memory", model: "sv-false-memory", rigged: true, speed: 2.64, hpMult: 1, trick: "split", theory: "Leading questions plant memories of things that never happened (Loftus & Palmer, 1974)." },
  { id: "fade", name: "Ebbinghaus Fade", theme: "memory", model: "sv-ebbinghaus-fade", rigged: true, speed: 2.64, hpMult: 0.9, trick: "fade", theory: "We forget fastest right after learning: the forgetting curve (Ebbinghaus, 1885)." },
  { id: "stroop", name: "Stroop Sprite", theme: "biases", model: "sv-stroop-sprite", rigged: true, speed: 2.64, hpMult: 1, trick: "ring", theory: "Naming the ink of the word RED printed in blue is slow: the Stroop effect (1935)." },
  { id: "bandwagon", name: "Bandwagon", theme: "biases", model: "sv-bandwagon", rigged: true, speed: 2.86, hpMult: 1, trick: "bandwagon", theory: "People follow the crowd, even when the crowd is wrong (Asch, 1951)." },
];

/** Minion melee (§3.0): 2 % max HP, 0.35 s wind-up, every 1.4 s. */
/** Hero walk speed (src/fight/arenaHero.ts): no enemy may reach it. */
export const HERO_WALK = 3.4;

export const MINION_HIT = { pct: 0.02, windup: 0.35, cooldown: 1.4, reach: 1.3 };
export const ELITE_HIT = { pct: 0.06, windup: 0.6, cooldown: 1.8, reach: 1.8 };

export type HeroKitId = "freud" | "pavlov" | "skinner" | "erikson" | "ainsworth";

export interface EliteDef {
  id: string;
  name: string;
  hero: HeroKitId;
  model: string;
  speed: number;
  /** What the hero's debuff is called on the HUD. */
  debuffName: string;
  debuffMs: number;
  /** Extra damage taken while debuffed (on top of Defended being stripped). */
  vuln: number;
  theory: string;
}

export const ELITES: EliteDef[] = [
  { id: "repressed", name: "The Repressed", hero: "freud", model: "sv-repressed", speed: 2.2, debuffName: "Analysed", debuffMs: 8000, vuln: 0.2, theory: "What we push away comes back disguised: repression and projection (Freud; A. Freud, 1936)." },
  { id: "hound", name: "Startle Hound", hero: "pavlov", model: "sv-startle-hound", speed: 2.2, debuffName: "Frozen", debuffMs: 3000, vuln: 0.3, theory: "A tone paired with harm makes the animal freeze: conditioned fear (Watson & Rayner, 1920; LeDoux)." },
  { id: "pigeon", name: "Superstitious Pigeon", hero: "skinner", model: "sv-superstitious-pigeon", speed: 2.2, debuffName: "Extinguished", debuffMs: 10000, vuln: 0.25, theory: "Reward at random and the pigeon invents a ritual (Skinner, 1948). Staddon & Simmelhag (1971) reread it as instinct." },
  { id: "diffusion", name: "Identity Diffusion", hero: "erikson", model: "sv-identity-diffusion", speed: 2.2, debuffName: "Committed", debuffMs: 10000, vuln: 0.25, theory: "Diffusion: no commitment, no exploration. Achievement: both (Marcia, 1966, after Erikson)." },
  { id: "wraith", name: "Clinging Wraith", hero: "ainsworth", model: "sv-clinging-wraith", speed: 2.2, debuffName: "Reunited", debuffMs: 8000, vuln: 0.15, theory: "Separation distress and the reunion: the Strange Situation (Ainsworth et al., 1978)." },
];

/**
 * Elite rules (§4.2): Defended −60 % until debuffed; Wanes after 40 s. 12× a
 * minion's HP (22× in the design draft left elites alive across whole waves in
 * tools/survival-sim-check.mjs: ~33 s of focused fire through Defended).
 */
export const ELITE_RULES = { hpMult: 12, defendedTaken: 0.4, waneAfterS: 40 };

export type BossId = "weaver" | "ames" | "gorilla" | "hag";

export interface BossDef {
  id: BossId;
  name: string;
  model: string;
  hp: number;
  theory: string;
}

export const BOSSES: BossDef[] = [
  { id: "weaver", name: "The Dream Weaver", model: "sv-dream-weaver", hp: 9000, theory: "Dream-work: condensation and displacement (Freud, 1900)." },
  { id: "ames", name: "The Ames Room", model: "sv-ames-room", hp: 9500, theory: "A trapezoid room makes people look giant or tiny: the Ames room (Ames, 1952)." },
  { id: "gorilla", name: "The Invisible Gorilla", model: "sv-invisible-gorilla", hp: 10000, theory: "Busy counting passes, half of viewers miss a gorilla: inattentional blindness (Simons & Chabris, 1999)." },
  { id: "hag", name: "The Old Hag", model: "sv-old-hag", hp: 11000, theory: "Awake but unable to move, many feel a presence on the chest: sleep paralysis (Hufford, 1982)." },
];

/** Boss tuning (§5.0). Percentages are of the target's max HP. */
export const BOSS_RULES = {
  walk: 1.1,
  swing: { pct: 0.18, windup: 0.8, cooldown: 2.5, reach: 4 },
  slam: { pct: 0.4, telegraph: 1.5, radius: 4.5 },
  projectile: { pct: 0.12, speed: 7, radius: 0.6 },
  burn: { pctPerS: 0.08, seconds: 15, radius: 2.6 },
  enrageBelow: 0.2,
  hardEnrageS: 240,
};

/** Pickups (§6.1). */
/** Out-of-combat recovery: share of max HP restored over a breather / boss intermission. */
export const RECOVERY = { breather: 0.2, intermission: 0.6 };

export const PICKUPS = {
  minionHpChance: 0.06,
  minionFocusChance: 0.06,
  hpOrbPct: 0.06,
  focusOrb: 15,
  largeHpPct: 0.25,
  largeFocus: 40,
  magnet: 2.5,
  lifeS: 12,
};

// ---- Recall Test question bank (§5.6): basic intro psychology ----------------
export interface QuizItem {
  id: string;
  /** Theory card that must have been shown this run (a minion/elite/boss id, or "any"). */
  source: string;
  question: string;
  /** answers[0] is correct; the sim shuffles. */
  answers: [string, string, string, string];
  explain: string;
}

export const QUIZ: QuizItem[] = [
  { id: "q_pavlov", source: "hound", question: "A dog drools at a bell alone. What learned it?", answers: ["Classical conditioning", "Operant conditioning", "Habituation", "Imprinting"], explain: "The bell was paired with food until the bell alone worked (Pavlov)." },
  { id: "q_reinforce", source: "pigeon", question: "A reward makes a behaviour happen more. This is…", answers: ["Reinforcement", "Punishment", "Extinction", "Habituation"], explain: "Reinforcement strengthens the behaviour it follows (Skinner)." },
  { id: "q_id", source: "repressed", question: "Which part of the mind wants pleasure right now?", answers: ["Id", "Ego", "Superego", "Persona"], explain: "The id runs on the pleasure principle; the ego plans, the superego judges." },
  { id: "q_rem", source: "wisp", question: "Which sleep stage has the most vivid dreams?", answers: ["REM sleep", "Deep sleep", "Stage 1", "Stage 2"], explain: "REM = rapid eye movement, the most dream-rich stage." },
  { id: "q_identity", source: "diffusion", question: "Erikson: the big question of the teenage years?", answers: ["Identity", "Trust", "Intimacy", "Integrity"], explain: "Teens work out who they are: identity vs role confusion." },
  { id: "q_secure", source: "wraith", question: "Baby cries when mom leaves, calms when she returns:", answers: ["Secure", "Avoidant", "Ambivalent", "Disorganized"], explain: "Secure babies use the parent as a safe base (Ainsworth)." },
  { id: "q_illusion", source: "kanizsa", question: "Two equal lines look unequal. What is this?", answers: ["An illusion", "A hallucination", "A dream", "A memory"], explain: "An illusion misreads something real; a hallucination has nothing there." },
  { id: "q_falsemem", source: "falsememory", question: "Remembering something that never happened is a…", answers: ["False memory", "Flashbulb memory", "Reflex", "Habit"], explain: "Memories can be changed by later suggestion (Loftus)." },
  { id: "q_forget", source: "fade", question: "When do we forget the fastest?", answers: ["Right after learning", "After a week", "After a month", "After a year"], explain: "The forgetting curve drops steeply at first, then levels off." },
  { id: "q_gorilla", source: "gorilla", question: "Missing a gorilla while counting passes shows…", answers: ["Inattentional blindness", "Colour blindness", "Déjà vu", "Sleepwalking"], explain: "Focused attention can hide something obvious (Simons & Chabris)." },
  { id: "q_conform", source: "bandwagon", question: "Doing something because everyone else does is…", answers: ["Conformity", "Obedience", "A reflex", "Projection"], explain: "Asch's line studies: people agreed with an obviously wrong group." },
  { id: "q_stroop", source: "stroop", question: "Saying the ink colour of the word RED in blue is slow. This is the…", answers: ["Stroop effect", "Placebo effect", "Halo effect", "Bystander effect"], explain: "Reading is automatic, so the word fights the colour (Stroop, 1935)." },
  { id: "q_afterimage", source: "afterimage", question: "Stare at red, look away, and you see…", answers: ["Green", "Red", "Black", "Nothing"], explain: "Opponent cells rebound to the opposite colour: a negative afterimage." },
  { id: "q_paralysis", source: "hag", question: "Waking up but unable to move is called…", answers: ["Sleep paralysis", "Sleepwalking", "Insomnia", "Narcolepsy"], explain: "REM keeps the body still; sometimes you wake before it lets go." },
  { id: "q_ames", source: "ames", question: "In the Ames room, why does one person look giant?", answers: ["The room's shape tricks depth", "A mirror", "They are taller", "Bad lighting"], explain: "The room is a trapezoid, but our eyes assume it is square." },
  { id: "q_dreamwork", source: "weaver", question: "Freud said dreams mostly express hidden…", answers: ["Wishes", "Memories of birth", "Brain damage", "Hunger"], explain: "Freud: dreams disguise wishes. Modern research disagrees in part." },
];

// ---- Boons (§7): one of three after every boss except the last -----------------
export type BoonId = "lucid" | "token" | "secure" | "chunking" | "exposure" | "insight" | "spacing" | "priming";

export interface BoonDef { id: BoonId; name: string; text: string; theory: string; max: number }

export const BOONS: BoonDef[] = [
  { id: "lucid", name: "Lucid Dreaming", text: "A third dash charge.", theory: "Knowing you are dreaming lets you steer it (LaBerge).", max: 1 },
  { id: "token", name: "Token Economy", text: "Every 25 kills drops a Focus orb at your feet.", theory: "Tokens exchanged for rewards shape behaviour (Ayllon & Azrin, 1968).", max: 3 },
  { id: "secure", name: "Secure Base", text: "+12% damage while above 70% HP.", theory: "A secure base makes exploring safe (Bowlby; Ainsworth).", max: 3 },
  { id: "chunking", name: "Chunking", text: "Pickups reach you from 2 m further.", theory: "Experts see patterns in bigger chunks (Chase & Simon, 1973).", max: 3 },
  { id: "exposure", name: "Exposure", text: "Take 15% less damage.", theory: "Step-by-step exposure shrinks fear (Wolpe's systematic desensitisation).", max: 3 },
  { id: "insight", name: "Insight", text: "Your elite debuffs last 50% longer.", theory: "Understanding a pattern makes it easier to break.", max: 3 },
  { id: "spacing", name: "Spacing Effect", text: "Large orbs heal 50% more.", theory: "Spaced practice beats cramming (Cepeda et al., 2006).", max: 3 },
  { id: "priming", name: "Priming", text: "Your first hit on each enemy deals +40%.", theory: "A first exposure speeds the next response (Meyer & Schvaneveldt, 1971).", max: 3 },
];
