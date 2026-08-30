# Contributing to PSYRENA

Thanks for helping build **Psyrena** — a browser-based 3D co-op boss-fighting RPG where every hero is a famous psychologist and every skill is their actual theory.

This game is made *with* students, not just *for* them. You don't need to be a programmer to contribute — you need to know your theorists.

## Ground rules

1. **No monetization, ever.** No in-app purchases, ads, real-money currency, or anything convertible to money. PRs adding monetization of any kind will be declined.
2. **Theory is the mechanic — keep it real.** Skill kits, boss phases, and counters must map to the theorist's *actual* published theory. "Skill beats gear, always" is a design invariant: reading the boss correctly must stay worth far more than gear. Cite your sources (textbook chapter or primary source) in the PR description.
3. **Compete without PvP.** Teams never attack each other. Designs that introduce direct player-vs-player harm will be declined.
4. **Contributing is voluntary.** If you are a student in one of Frank's courses: contributing is not graded, not required, and never affects your marks — in either direction.
5. **Be kind.** Many contributors are making their first-ever pull request.

## Contribution lanes

| Lane | What | Where to start |
|---|---|---|
| 🧠 Hero design | A psychologist's kit: skills = their theory's components, stances, cooldowns, voice lines (e.g., Piaget's stages, Skinner's schedules of reinforcement) | Open an issue titled `Hero: <theorist>` with the theory→mechanic mapping |
| 👹 Boss design | Psychological constructs as raid bosses with theory-countered phases | Open an issue titled `Boss: <construct>` |
| 💻 Code | Vite + TypeScript, WebGPU/WebGL2 renderer, Node server | Issues labeled `good first issue`; README has setup (`npm install && npm run dev`) |
| 🎨 3D assets & VFX | Assets are AI-generated (Tripo) through the documented budget-conscious pipeline — great prompts and concept art count | Open an issue with your concept |
| ⚖️ Balancing & playtesting | Encounter tuning, telegraphs, bug reports | Open an issue with what happened and what you expected |
| ❓ Quiz content | Mastery quiz questions tied to each hero's theory | Open an issue per hero |

## Workflow

1. Ask for collaborator access, or comment on an issue to claim it.
2. Branch from `main`: `git checkout -b your-name/short-description`.
3. Keep PRs small; one lane per PR.
4. For code: `npm run build` must pass (typecheck + production build).
5. Describe *what players will experience differently* in the PR description.

## Credit

- Every merged contributor is listed in the in-game credits.
- Substantial contributions are acknowledged in any academic publications about this project (CRediT taxonomy); major contributions can merit co-authorship — talk to Frank early.

## What is not in this repo

The design bible (`docs/`) and the raw production material (`assets/concept/`,
`assets/work/`) are kept private. Source comments cite them by number — treat
those as internal references. Nothing in this repo needs them to build or run,
and no issue or PR should require reading them; if an answer only lives in the
design bible, ask and it will be quoted into the thread.

Sound effects are also absent by license. `public/assets/sfx/` is gitignored;
the game degrades to silence on those cues, or you can run
`node tools/sync-sfx.mjs` against your own [PSFX](https://github.com/JimHPerry/psfx)
clone.

## License

Two licenses cover this repository, and a contribution falls under whichever
matches what you touched:

- **Code** — [PolyForm Noncommercial 1.0.0](LICENSE). Use, modify and share for
  any non-commercial purpose; classrooms and research institutions are covered.
- **Assets** (anything under `public/assets/`) — [CC BY-NC 4.0](LICENSE-ASSETS.md),
  attribution required, non-commercial only.

Neither license permits commercial use. The source is public so that students
and other teachers can read, run and extend it, not so that it can be sold.

By contributing you agree to license your contribution on those terms. If you
submit an asset, say in the PR how it was made and under what plan or license,
so the credit table in [LICENSE-ASSETS.md](LICENSE-ASSETS.md) stays accurate.
Do not submit material you cannot license this way — that includes output from
a generation tool whose free tier withholds redistribution rights.
