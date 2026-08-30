# admin/ — design & tuning tools

Design-time tools only. Nothing in here ships to players or is imported by the
client/server; these are standalone sheets that read the same canon as the game
(`shared/combat.ts`, `shared/heroes/*`, and the private design bible).

The LIVE admin console (user management, invitation codes, gift codes, chat
moderation, reports, statistics) is a different thing: it is served by the game
server at **`/admin`** (`server/admin.mjs` + `server/adminConsole.html`) and
gated on `users.is_admin`. The first account ever created is promoted to admin
automatically; further admins are appointed in the console itself. Verify the
whole surface with `node admincheck.mjs`.

## boss-math/ — Boss Fight Design Sheet

A single-file calculator + simulator for boss-fight mathematics: open
`admin/boss-math/index.html` directly in a browser (no build step, no network).

| File | What it is |
|---|---|
| `index.html` | The design sheet UI — team builder, per-slot skill damage tables, boss/phase editor, deterministic fight sim, optimizer, indicators, HP chart, JSON export/import |
| `extracted-stats.json` | Snapshot of every combat-relevant number in the repo as of 2026-07-31, with per-field provenance (`code` / `doc` / `assumed` / `missing`) |

### What it computes

- **The one damage pipeline** — identical math to `shared/combat.ts`:
  `Hit = Base × Beat × (1 + 0.06×Marks) × (1+Amp) × Gear × Format`. The sheet
  reproduces the doc 02 worked example (Freud 493) as a live parity check.
- **Three difficulties × four tuning corners** — every boss (NIGHTMARE today,
  the rest later) ships as **Standard / Hard / Nightmare**: same phase script,
  different HP curve, outgoing damage, self-heal and answer window. Each tier is
  tuned against one of the four corners a real team can show up as — **3 or 5
  players × fresh or full-BiS gear** — and the clear matrix reports what the
  other three corners experience. Boss HP is derived *per tier per team size*,
  so headcount never decides the outcome; gear and execution do.
- **Hero DPS budget → per-role skill distribution** — you design one number per
  hero (total output, scaled by the doc-03 role weights) and the sheet derives
  what each button has to hit: **S1** the `1–x` palette wheel, **S2** `E`,
  **S3** `R`, **S4** `F` (Mark payload *plus* a direct hit), **S5** `LMB` basic.
- **The role contract, live** — doc 08 (private design bible)'s four role
  rows (DPS / Tank / Healer / Support-Control) are an editable grid: share per
  slot, and the **currency** each slot pays in (damage / healing / team buff).
  Every hero derives from *their own* row, so a healer's E is a team heal and a
  tank's E is team mitigation. Editing a row away from doc 08 raises a drift row
  in the optimizer, so the sheet and the doc cannot disagree silently. Canon mode
  flips back to doc-03 bases for comparison, and **canon drift** is reported per
  hero either way.
- **Player buffs, mitigation and coverage** — attack buffs (doc 03's
  Power/success buffs, which sit outside the Amp term) with magnitude ×
  coverage; **mitigation read off the kits themselves** — each defensive
  cooldown's magnitude × duty cycle × reach (self-only buttons protect one
  player, not the raid), summed and capped at doc 08's 0.40. Plus **healing
  supply vs demand**: what the contract's healing shares actually produce against
  what the fight asks for, and what the surplus is worth as overheal→Amp.
- **Rotation model** — every cast costs one GCD: the palette answers on the boss
  window, E/R/F answer on their cooldowns, and basics fill the GCDs left over.
  That is what makes a cooldown change move the damage mix instead of just adding.
- **Per-hero output** — ceiling single hit (payoff beat, 10 Marks, 50% Amp, BiS,
  match), theoretical max ultimate, Focus per second vs regen, and steady-state
  sustained DPS under editable execution assumptions (accuracy, payoff-beat rate,
  uptime, foreign-Mark share).
- **Teams of 3–5** — 3 is the minimum to start a battle (doc 01), so the sheet
  simulates 3/4/5 independently and checks the ≥1 tank / ≥1 healer comp rule.
- **Fight simulation** — 100 ms deterministic tick over the boss's looping phase
  script: Mark board ramp/decay, Amp ramp, ult cash-outs from the shared pool,
  phase damage-taken multipliers (P3 Fortress armor), boss regen, the P2→P3
  armor-bypassing debuff dependency, Kohlberg's armor-ignoring ult.
- **Boss HP derivation** — binary-search the HP that produces a target kill time,
  re-run for every team size, so `hpByTeamSize` (open issue P-2, a required field
  in `shared/types.ts` with no published values) comes out simulated rather than
  extrapolated.
- **Optimizer, shown by default** — solves for the P2 debuff strength and
  duration, the Fortress regen budget, the ult cash-out threshold, Marks per
  ultimate, the damage distribution (against a target mix), the palette width
  against the answer window, the DPS budget against what doc 03 already implies,
  the per-tier kill target needed for a difficulty to actually gate anyone, and
  the Focus regen floor. Each row says what it recommends and why; *Apply all*
  iterates to a fixed point. Rows that need a design call rather than a click
  (healer throughput, tiers that admit the same population) are marked as
  advisories.
- **Indicators** — kill time vs enrage, Fortress net HP/s, armored-phase burden
  (how much of the boss's health the regen restores per pass, and what share of
  all damage the counter-debuff therefore has to carry), Mark-board saturation
  (P-3 pressure), worst-phase incoming damage → required HPS.
- **Layman bubbles** — every term (Marks, Beat, Amp, Focus, GCD, Fortress, …) is
  a hover/click/keyboard bubble with a plain-language explanation plus its
  numbers, and the same set is dumped as a glossary table and into the export.

### Model assumptions (all editable in the UI, all flagged there)

- Beat/GCD length **1.5 s** (`villageHub.ts:3764`); basics average the ×1.1 cycle mean.
- One palette cast per **8 s** phase window (doc 02); wrong casts apply the
  Fixation drag (−30% for 6 s) as a time-averaged penalty.
- Only Freud has coded cooldowns; every other hero's CDs mirror his (12/25/60 s).
- **S2/S3 damage is a proposal, not canon.** Doc 03 only gives E/R damage for the
  chain kits (Skinner *Consequence* 175, Pavlov *UCS* 145 / *NS* 20); every other
  E/R number comes from the coefficient knobs and is labelled `design`.
- **P-1 toggle**: whether Beat multiplies skills (code default) or skills get a
  flat +25% on the payoff beat (doc 07 recommendation) — swings off-beat skill
  casts by up to 47%, so it is a switch, not a silent choice.
- The P2 debuff is modeled as **% of the boss's max HP per second** (the Fortress
  regen scales that way, so its counter must too) and by default **ticks only
  while the boss is armored**. Switch that off and watch it become 99% of all
  damage in the fight — the reason the toggle exists.
- Not modeled: crit (175%), Haste, Repression enrage stacks, hero HP/death (no
  hero HP numbers exist anywhere in canon yet). Focus is modeled as demand vs a
  design-input regen, not as a live pool.

### Export format

`Export JSON` downloads `psyrena-boss-math-<boss>-<n>p.json` — self-contained, so
a later integration pass needs nothing else:

```jsonc
{
  "schema": "psyrena.boss-math/v3",
  "constants":        { /* mirrors shared/combat.ts COMBAT + GCD, Focus costs, team-size rules */ },
  "optimizerTargets": { /* the damage mix / Fortress / kill-margin targets it solved against */ },
  "difficulties":     { /* the 4 corners, then per tier: reference corner, kill target, multipliers,
                           hpByTeamSize {3,5}, and the clear matrix with kill time + required HPS per corner */ },
  "buffs":            { /* attack + defensive magnitude, coverage, and the effective multipliers */ },
  "skillBudget":      { /* budget, reference execution, palette width, per-slot distribution,
                           and derived per-skill bases for all 14 heroes with canon drift */ },
  "glossary":         { /* every term, plain-language explanation + numbers */ },
  "settings":         { /* full sheet state: team, execution, tiers, buffs, mix, per-hero overrides, phases */ },
  "roster":           [ /* all 14 heroes × 5 slots, with canon damage and provenance per slot */ ],
  "resolvedTeam":     [ /* the active team: per-slot base/CD/Focus/casts-per-min/per-cast/ceiling/DPS */ ],
  "results":          { /* kill time, margin, team DPS, damage by slot + shares, per-phase ledger, HP samples */ },
  "suggestions":      [ /* every optimizer row: current, suggested, rationale */ ],
  "serverPatch":      { /* BossPhaseScript shape + difficultyTiers[], each with its own hpByTeamSize */ },
  "openIssues":       [ /* which doc-07 issue each exposed knob corresponds to */ ]
}
```

`serverPatch` is shaped to slot into `BossPhaseScript` (`shared/types.ts`) — an
integration agent can consume it to fill `hpByTeamSize`/`enrageMs`, the per-slot
cooldown/Focus table, and the P2 debuff tuning when those move into shared data.
`Copy JSON` puts the same payload on the clipboard, and the sheet imports both
v1 and v2 files.

### What the sheet found (findings, not just plumbing)

- **P3 Fortress regen at 1%/s over a 60 s phase heals back 60% of the boss's max
  HP per pass.** Any debuff strong enough to counter it necessarily becomes the
  majority of all damage in the fight. Three levers shrink it: cut the regen,
  shorten the phase, or soften the 90% armor. The optimizer proposes the first.
- **The 12% Rule means gear can gate at most one difficulty tier.** Full BiS is
  worth ~11% of kill time, so a tier only locks out an under-geared group when
  its target kill time sits past ~91% of the enrage timer. Boss damage and regen
  multipliers cannot gate anyone — deaths aren't simulated, because **no hero HP
  exists in canon**. With two gear states there are only two possible gates
  ("everyone" and "geared only"), so two of the three tiers admit the same
  population by construction; their difference has to be feel and reward.
- **Doc 03's own numbers put ~46% of a hero's damage on the free basic attack
  and ~28% on the palette** the whole game is about. The budget/distribution
  panel exists to fix that shape without abandoning canon's totals.
- **The overheal→Amp rule is inverted, by three orders of magnitude.** Once the
  role contract gave healers real throughput, the conversion could be run for
  the first time: a 3-stack overheals ~56 HP/s, worth **+0.28% Amp** at doc 02's
  `1000 overheal = +1%`. Holding the 20% every balance number assumes would take
  ~4,000 overheal/s — about 70× the team's entire healing output. Open issue S-1
  says Amp pins at its cap; the measurement says it sits at zero.

### Known upstream gaps this sheet surfaces (docs/07-open-design-issues.md)

P-1 (Beat contradiction) · P-2 (no HP-by-team-size curve) · P-3 (one Mark pool,
five consuming ults) · S-1 (Amp pins its cap — modeled as a steady slider) ·
plus: no hero HP, no healer throughput, no per-skill CD/Focus tuning table,
Nightmare enrage/HP/P2-debuff numbers all TBD in doc 04.
