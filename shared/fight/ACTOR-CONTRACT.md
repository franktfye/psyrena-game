# Multi-actor sim — the contract

The API the party fight is written against. Both `server/fight.mjs` and the
refactored `shared/fight/bossFight.ts` implement/consume exactly this.

## Why

`BossFight` was built as **one real player + N scripted allies**: `this.player`
appears 65 times and ~25 kit-state fields (conditioning, operant, Free
Association, Fixation/Denial, mitigations, response-strength stacks, FI/VI
tickers, ultimate ticks) sit flat on the class because there was only ever one
player. Three real players each need their own copy of all of it.

## Rules

1. **Backward compatibility is mandatory.** The existing constructor and every
   existing public method keep working, with identical behaviour and identical
   numbers. The practice pit, the arena's local sim and three headless
   harnesses all depend on them. Legacy methods act on the *primary* actor.
2. **Team/boss state stays on the class**: boss hp, phase, phaseT, cyclesDone,
   enrage, Marks, debuff stacks, Amp events, vulnerability, taunt, dome. Marks
   and Amp are team-level by design (doc 02) — they must NOT become per-actor.
3. **Per-actor state moves onto the actor**: everything that is one player's kit
   talking to itself.

## Added surface

```ts
export interface ActorSpec {
  /** Stable id. The user id for a real player, "bot:0" for a scripted ally. */
  id: string;
  /** Display name — what threat rows, ally bars and announces show. */
  name: string;
  /** This actor's own kit. Three players = three different heroes. */
  hero: Hero;
  /** true = driven by cast intents; false = scripted ally on a GCD timer. */
  input: boolean;
  /** Throughput numbers for a scripted ally. Required when input === false. */
  script?: SimAllySpec;
  loadout?: { gear?: number; petDamage?: number; petHealing?: number; hpMult?: number };
  potions?: { damage?: number; healing?: number };
}

/** Build a fight with N input-driven actors — the party case. */
static forParty(
  script: BossFightScript,
  actors: ActorSpec[],
  hooks: FightHooks,
  difficulty?: FightDifficultyMult
): BossFight;

/** Actor-addressed casts. The legacy no-id forms delegate to the primary. */
castBasicAs(actorId: string, beat: number): PendingHit | null;
castPaletteAs(actorId: string, paletteIndex: number, beat: number): PendingHit | null;
castDefenseAs(actorId: string): string | null;
castChainAs(actorId: string, beat: number): PendingHit | null;
castUltimateAs(actorId: string): number;
landUltimateAs(actorId: string, total: number): void;
landHitAs(actorId: string, hit: PendingHit): number;
setThreatStanceAs(actorId: string, active: boolean): void;
threatStanceActiveFor(actorId: string): boolean;
operantFor(actorId: string): OperantHudState | null;

/** Per-actor view for the HUD: the half `snapshot()` never carried. */
actorView(actorId: string): {
  id: string; name: string; role: string;
  hp: number; hpMax: number; alive: boolean; threat: number;
  mitigation: number;
} | null;
actorIds(): string[];
```

`FightSnapshot` keeps its shape. `allies` still means "everyone except the
primary actor", so existing HUD code is untouched; party clients read
`actorView` for their own numbers.

## Hooks

Every player-specific hook gains an **optional trailing `actorId`**. Existing
implementations ignore the extra argument; the server uses it to route an event
to the right client.

```ts
damagePlayer(amount: number, actorId?: string): void;
healPlayer(amount: number, actorId?: string): void;
playerBuff(name, durationMs, kind?, icon?, id?, desc?, actorId?): void;
gainFocus?(amount: number, actorId?: string): void;
defenseProc?(name: string, actorId?: string): void;
lockPaletteSlot(paletteIndex: number, ms: number, actorId?: string): void;
conditioningChanged?(state: ConditioningHudState, actorId?: string): void;
operantChanged?(state: OperantHudState, actorId?: string): void;
playerHitReaction(actorId?: string): void;
sfxEvent?(name: SfxName, actorId?: string): void;
```

`combatantDamaged/Healed/Died` already carry a name; they gain `actorId` too so
routing never has to match on display names.

## Team-size scaling

`teamSize` is now `actors.length` (input-driven and scripted alike), so
`hpByTeamSize` and `sizeMult` behave exactly as before for a solo run (1) and a
practice run (3), and a real 3-stack finally gets the 3-man boss it was tuned
for.

## Win / wipe

Unchanged in meaning: victory when boss hp hits 0; wipe when **no actor** is
alive. With real teammates that is the first time a wipe can be prevented by
someone else staying up.

## The bar

`node tools/sim-check.mjs`, `node tools/practice-sim-check.mjs` and
`node tools/loadout-sim-check.mjs` must pass **unchanged** — they are the
balance regression net. Solo numbers must not move.
