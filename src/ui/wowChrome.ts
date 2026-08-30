/**
 * WoW-style chrome — the shared look for in-game pop-up UI.
 *
 * One source of truth for the gold/serif dress the hero picker (authFlow.ts)
 * established: metallic gold frame, dark ember card, Palatino serif, the big
 * red CTA. Pop-ups interpolate these fragments into their own stylesheets so
 * the styling stays per-module (no specificity battles with panel CSS) while
 * the palette cannot drift between surfaces.
 *
 * Square corners are the point — WoW panels are not rounded, and CSS
 * border-image ignores border-radius anyway. Fragments that set borders come
 * with `border-radius: 0` for exactly that reason.
 */

/** The picker's serif stack (authFlow.ts .pick). */
export const WOW_FONT = `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif`;

/** Parchment-on-ember text colors. */
export const WOW_TEXT = "#e8d9b0";
export const WOW_TEXT_DIM = "#b8a878";
export const WOW_GOLD = "#e2c47c";

/** Card face: metallic gold frame over a dark ember panel. */
export const WOW_CARD = `
  border: 1px solid transparent; border-radius: 0;
  border-image: linear-gradient(160deg, #8a6d2f, #e2c47c 30%, #5a4620 62%, #b0914e) 1;
  background: linear-gradient(180deg, #171106f6, #0b0804f6);
  box-shadow: 0 0 0 1px #000, 0 18px 60px #000d, inset 0 0 70px #00000073;
  color: ${WOW_TEXT};
`;

/** Gold-gradient display text (the picker's .gold-text). */
export const WOW_GOLD_TEXT = `
  background: linear-gradient(180deg, #ffedb0, #ecc363 55%, #a87c28);
  -webkit-background-clip: text; background-clip: text; color: transparent;
`;

/** The big red CTA — WoW's Enter World button (authFlow.ts .enterbar .cta). */
export const WOW_CTA = `
  border-radius: 0; padding: 11px 22px; cursor: pointer;
  font-family: inherit; font-size: 13px; letter-spacing: .22em; text-transform: uppercase;
  color: #ffe9b0; text-shadow: 0 1px 2px #000;
  background: linear-gradient(180deg, #8c2014, #55100a 55%, #3c0a05);
  border: 1px solid transparent;
  border-image: linear-gradient(180deg, #e8c878, #7a5f2a) 1;
  box-shadow: 0 0 0 1px #000, 0 8px 22px #000b, inset 0 1px 0 #ffffff2b;
`;
export const WOW_CTA_HOVER = `filter: brightness(1.3); box-shadow: 0 0 20px #f0c85a55, 0 0 0 1px #000;`;

/** Secondary button: dark panel with a gold trim that lights on hover. */
export const WOW_BTN = `
  border-radius: 0; cursor: pointer; font-family: inherit;
  letter-spacing: .14em; text-transform: uppercase;
  color: ${WOW_TEXT_DIM}; background: linear-gradient(180deg, #1a1409f0, #0c0905f0);
  border: 1px solid #5a4620; box-shadow: 0 0 0 1px #000;
`;
export const WOW_BTN_HOVER = `border-color: ${WOW_GOLD}; color: #f4e3b2;`;

/** Inset row / list-item chrome inside a card. */
export const WOW_ROW = `
  border: 1px solid #3a2d14; border-radius: 0; background: #120d05aa;
`;

/** Text input on an ember card. */
export const WOW_INPUT = `
  background: #120d05; color: ${WOW_TEXT}; border: 1px solid #5a4620; border-radius: 0;
  font-family: inherit; letter-spacing: .05em; outline: none;
`;
export const WOW_INPUT_FOCUS = `border-color: ${WOW_GOLD}; box-shadow: 0 0 0 1px #e2c47c44;`;
