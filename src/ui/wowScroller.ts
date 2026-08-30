/**
 * Drawn scrollbar — a scrolling box inside a pop-up card, with the bar painted
 * in the panel's own chrome instead of the platform's.
 *
 * Two problems this solves, both first hit by the codex Credits tab and then
 * again by the boss guide:
 *
 *  1. A long page left in the card's flow stretches the card past the viewport
 *     and hands the scroll to the backdrop, which drags the header (and the
 *     codex tab row) off the top with it. The fix is a box that scrolls while
 *     the card keeps its size.
 *  2. Chromium and Safari both fade an overlay scrollbar out at rest, so a long
 *     page that has scrolled nowhere yet looks like a short page that has been
 *     cut off. A track that is always drawn says "there is more" without being
 *     touched, and it is chrome the panel already owns.
 *
 * Same per-module discipline as wowChrome.ts: the CSS comes back as a string
 * scoped to the caller's root selector, so a panel interpolates it into its own
 * stylesheet and nothing here is global.
 */

/**
 * Rules for the desktop layout. `root` is the panel's own selector (`#boss-guide`),
 * `maxHeight` caps the box where the card is not itself height-constrained —
 * pass `none` when the card is a flex column that already bounds it.
 */
export function wowScrollCss(root: string, maxHeight = "none"): string {
  return `
${root} .scrollwrap { position: relative; min-height: 0; }
${root} .scrollbox {
  max-height: ${maxHeight}; overflow-y: auto; overscroll-behavior: contain;
  padding-right: 18px;
  scrollbar-width: none;
}
${root} .scrollbox::-webkit-scrollbar { width: 0; height: 0; }
${root} .scrollbar {
  position: absolute; top: 0; right: 0; width: 9px; height: 100%;
  background: #120d05; border: 1px solid #2a2010; box-sizing: border-box;
}
${root} .scrollbar i {
  position: absolute; left: 0; width: 100%; box-sizing: border-box;
  background: linear-gradient(#7a6030, #55411d); border: 1px solid #8a6d2f;
  cursor: grab;
}
${root} .scrollbar i:active { cursor: grabbing; background: linear-gradient(#8f7238, #644d24); }
`;
}

/**
 * Lifts the box back into the flow, for a phone layout whose card is itself a
 * full-screen scroller. A second scroller inside one traps the page in a short
 * box in the middle of a tall screen, and the drawn track ends up measuring a
 * box that never scrolls. Drop this inside the panel's own media query.
 */
export function wowScrollPhoneCss(root: string): string {
  return `
${root} .scrollbox { max-height: none; overflow-y: visible; padding-right: 0; }
${root} .scrollbar { display: none; }
`;
}

/**
 * Wires the drawn bar to a scroller: sizes the thumb from the overflow, follows
 * the scroll, and lets the thumb be dragged. Every listener hangs off the
 * elements themselves (plus a pointer capture during a drag), so whatever
 * throws the scroller away — a tab switch, a closed panel — takes them with it.
 */
export function bindWowScrollbar(box: HTMLElement, bar: HTMLElement, thumb: HTMLElement): void {
  const sync = (): void => {
    const track = bar.clientHeight;
    const ratio = box.clientHeight / box.scrollHeight;
    // Nothing to scroll, or a phone layout where the bar is hidden and so
    // measures nothing: say so by hiding the track rather than drawing a
    // full-height thumb that cannot move.
    if (!track || ratio >= 1) {
      bar.style.visibility = "hidden";
      return;
    }
    bar.style.visibility = "";
    const h = Math.max(28, Math.round(track * ratio));
    thumb.style.height = `${h}px`;
    const travel = box.scrollHeight - box.clientHeight;
    thumb.style.top = `${Math.round((box.scrollTop / travel) * (track - h))}px`;
  };
  box.addEventListener("scroll", sync, { passive: true });
  // Sized on the frame after insertion: a caller that builds its card before
  // appending it has nothing in the document yet, so every height above would
  // read zero.
  requestAnimationFrame(sync);
  // An observer, not a window resize listener: it dies with the element
  // instead of outliving the panel it was measuring.
  new ResizeObserver(sync).observe(box);

  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startTop = box.scrollTop;
    const travel = box.scrollHeight - box.clientHeight;
    const room = bar.clientHeight - thumb.offsetHeight;
    thumb.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent): void => {
      if (room <= 0) return;
      box.scrollTop = startTop + ((m.clientY - startY) / room) * travel;
    };
    const up = (): void => {
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", up);
      thumb.removeEventListener("pointercancel", up);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up);
    thumb.addEventListener("pointercancel", up);
  });
}

/**
 * Builds the wrap / box / track trio, appends it to `host`, binds the bar and
 * hands back the box to fill. `boxClass` adds the caller's own class to the
 * scroller, for a panel that already styles that element (the guide's `.body`).
 */
export function mountWowScroller(host: HTMLElement, boxClass = ""): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "scrollwrap";
  const box = document.createElement("div");
  box.className = boxClass ? `scrollbox ${boxClass}` : "scrollbox";
  const bar = document.createElement("div");
  bar.className = "scrollbar";
  const thumb = document.createElement("i");
  bar.appendChild(thumb);
  wrap.append(box, bar);
  host.appendChild(wrap);
  bindWowScrollbar(box, bar, thumb);
  return box;
}
