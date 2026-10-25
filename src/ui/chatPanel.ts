/**
 * Chat + friends panel — bottom-left.
 *
 * Collapsed: a chat icon plus a click-through feed of the last 5 messages.
 * Open (Enter, or clicking the icon): a tabbed panel — LOBBY, FRIENDS, and one
 * tab per open whisper thread — showing ~5 rows and scrolling through the 50
 * the SocialClient keeps.
 *
 * Created once in main.ts after login, so it exists exactly where the design
 * wants it: the village hub and the boss arena, never the auth screens (which
 * run before it is constructed).
 *
 * Focus discipline: while the input owns the keyboard, every gameplay key
 * handler backs off via `isTypingInField()` (see inputMode.ts) — that contract
 * is what lets this input exist at all on a page full of window-level
 * hotkeys.
 */

import { SocialClient, type ChatMessage } from "../net/social";
import { heroPortrait, type Profile } from "./authFlow";
import { isTypingInField, detectControlScheme, uiScale, onAnyTap } from "./inputMode";

const PANEL_BG = "rgba(4,10,18,.82)";
const PANEL_BORDER = "1px solid rgba(120,220,255,.28)";
const FONT = "ui-monospace,SFMono-Regular,Menlo,monospace";
const MINI_ROWS = 5;

/**
 * Small screens: the OPEN panel fills the viewport (the collapsed feed and the
 * icon stay as they are). Inline styles set the desktop geometry, so the media
 * query needs !important to win. `transform:none` on the root matters: the
 * root's uiScale transform would otherwise make `position:fixed` resolve
 * against the root instead of the viewport. The class only exists while the
 * panel is open, so the collapsed feed keeps its scale.
 */
const CSS = `
@media (pointer: coarse), (max-width: 640px) {
  .chat-root.full { transform: none !important; }
  /* Collapsed touch chat anchors at bottom-CENTER via inline left:50% +
     translateX(-50%). transform:none above removes the translate, which would
     leave the in-flow icon starting AT center instead of centered on it — so
     while open, snap the root back to the bottom-left corner the input-row
     padding below was designed around. */
  .chat-root.full {
    left: calc(10px + env(safe-area-inset-left, 0px)) !important;
    justify-items: start !important;
  }
  .chat-root.full .chat-open {
    position: fixed !important; inset: 0 !important;
    width: 100% !important; height: 100% !important;
    max-width: none !important; max-height: none !important;
    border-radius: 0 !important; border: none !important;
  }
  /* The chat icon stays in the root flow at bottom-left (the fixed panel is
     out of flow), so the full-screen input row would run under it. Push the
     input clear: 10px root offset + 38px icon + 10px gap. */
  .chat-root.full .chat-open .chat-input-row { padding-left: 58px !important; }
}
`;

type Channel = "lobby" | "friends" | `dm:${string}`;

export class ChatPanel {
  private readonly root: HTMLDivElement;
  private readonly mini: HTMLDivElement;
  private readonly icon: HTMLButtonElement;
  private readonly badge: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly tabsEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly inputRow: HTMLDivElement;
  private readonly input: HTMLInputElement;

  private open = false;
  private active: Channel = "lobby";
  /**
   * Local world/system broadcasts (boss fight announcements, phase warnings).
   * Never sent to the server — they are the client's half of the future
   * world channel; when the room sim exists these arrive over the wire and
   * this list goes away. Rendered merged into the lobby feed, styled apart.
   */
  private readonly systemFeed: { at: number; text: string }[] = [];
  /** Open whisper tabs, lowercased names in open order. */
  private dmTabs: string[] = [];
  /** Preferred display casing for names (from friends list / messages). */
  private readonly casing = new Map<string, string>();
  private readonly unread = new Map<string, number>();
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly social: SocialClient, profile: Profile) {
    const touch = detectControlScheme() === "touch";
    const scale = touch ? uiScale() : 1;
    this.casing.set(profile.username.toLowerCase(), profile.username);

    if (!document.getElementById("chat-panel-css")) {
      const style = document.createElement("style");
      style.id = "chat-panel-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // Touch: bottom-CENTER, not bottom-left — the left thumb corner belongs to
    // the move stick (touchStick.ts parks its resting ring there), and the
    // right corner to the skill cluster. translateX(-50%) centers the root box
    // and justify-items:center pins the icon to the box's center, so the icon
    // stays at screen center even as the mini feed's width varies with message
    // length. Desktop keeps the classic MMO bottom-left.
    this.root = document.createElement("div");
    this.root.className = "chat-root";
    this.root.style.cssText = [
      "position:fixed",
      touch ? "left:50%" : "left:calc(10px + env(safe-area-inset-left, 0px))",
      "bottom:calc(10px + env(safe-area-inset-bottom, 0px))",
      // Chat outranks every other surface — panels (40–61), the player card
      // (75) and confirms (80) — on desktop and touch alike; only the boot /
      // fatal-error overlays (200) may cover it. The root itself is
      // pointer-events:none, so collapsed chat never steals panel taps.
      "z-index:90",
      "display:grid",
      "gap:6px",
      touch ? "justify-items:center" : "justify-items:start",
      `font:11px/1.4 ${FONT}`,
      "color:#d8f7ff",
      "pointer-events:none",
      touch ? `transform:translateX(-50%) scale(${scale})` : `transform:scale(${scale})`,
      touch ? "transform-origin:bottom center" : "transform-origin:bottom left",
    ].join(";");

    // ---- collapsed: last-5 feed, click-through ---------------------------
    this.mini = document.createElement("div");
    this.mini.style.cssText = [
      "display:grid",
      "gap:2px",
      "max-width:min(320px,70vw)",
      "pointer-events:none",
      "text-shadow:0 1px 2px #000",
      "opacity:.85",
    ].join(";");

    // ---- open panel -------------------------------------------------------
    this.panel = document.createElement("div");
    this.panel.className = "chat-open";
    this.panel.style.cssText = [
      "display:none",
      "grid-template-rows:auto 1fr auto",
      "width:min(330px,86vw)",
      "height:230px",
      `background:${PANEL_BG}`,
      `border:${PANEL_BORDER}`,
      "border-radius:8px",
      "backdrop-filter:blur(6px)",
      "pointer-events:auto",
      "overflow:hidden",
    ].join(";");

    this.tabsEl = document.createElement("div");
    this.tabsEl.style.cssText = [
      "display:flex",
      "gap:2px",
      "padding:4px 4px 0",
      "border-bottom:1px solid rgba(120,220,255,.18)",
      "overflow-x:auto",
      "scrollbar-width:none",
    ].join(";");

    this.bodyEl = document.createElement("div");
    this.bodyEl.style.cssText = [
      "overflow-y:auto",
      "padding:5px 7px",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "overscroll-behavior:contain",
    ].join(";");

    this.input = document.createElement("input");
    this.input.placeholder = "message the lobby…";
    this.input.maxLength = 240;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.style.cssText = [
      "flex:1",
      "background:#0a1220",
      "color:#d8f7ff",
      "border:1px solid #23405c",
      "border-radius:5px",
      "padding:6px 8px",
      "font:inherit",
      "outline:none",
      "min-width:0",
    ].join(";");
    this.input.addEventListener("focus", () => (this.input.style.borderColor = "#40e6ff"));
    this.input.addEventListener("blur", () => (this.input.style.borderColor = "#23405c"));
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) void this.sendCurrent(text);
        else this.close(); // empty Enter = the classic MMO "leave chat"
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    const sendBtn = document.createElement("button");
    sendBtn.textContent = "➤";
    sendBtn.title = "Send";
    sendBtn.style.cssText = this.buttonCss("6px 10px");
    sendBtn.addEventListener("click", () => {
      const text = this.input.value.trim();
      if (text) void this.sendCurrent(text);
      this.input.focus();
    });

    this.inputRow = document.createElement("div");
    this.inputRow.className = "chat-input-row";
    this.inputRow.style.cssText = "display:flex;gap:5px;padding:5px";
    this.inputRow.append(this.input, sendBtn);

    this.panel.append(this.tabsEl, this.bodyEl, this.inputRow);

    // ---- icon row ---------------------------------------------------------
    this.icon = document.createElement("button");
    this.icon.textContent = "💬";
    this.icon.title = "Chat — Enter";
    this.icon.style.cssText = [
      "position:relative",
      "width:38px",
      "height:38px",
      `background:${PANEL_BG}`,
      `border:${PANEL_BORDER}`,
      "border-radius:8px",
      "font-size:17px",
      "cursor:pointer",
      "pointer-events:auto",
      "backdrop-filter:blur(4px)",
      "display:grid",
      "place-content:center",
      "padding:0",
    ].join(";");
    this.badge = document.createElement("div");
    this.badge.style.cssText = [
      "position:absolute",
      "top:-6px",
      "right:-6px",
      "min-width:16px",
      "height:16px",
      "border-radius:8px",
      "background:#ff59b8",
      "color:#fff",
      "font-size:10px",
      "line-height:16px",
      "text-align:center",
      "padding:0 3px",
      "display:none",
      "font-weight:600",
    ].join(";");
    this.icon.appendChild(this.badge);
    // onAnyTap, not raw click: Chrome never synthesizes `click` for a second
    // thumb while the move stick holds the primary pointer.
    onAnyTap(this.icon, () => (this.open ? this.close() : this.openPanel()));

    this.root.append(this.mini, this.panel, this.icon);
    document.body.appendChild(this.root);

    // Enter opens chat from anywhere in the world (unless already typing).
    const keyHandler = (e: KeyboardEvent): void => {
      if (isTypingInField()) return;
      if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.openPanel();
      } else if (e.key === "Escape" && this.open) {
        this.close();
      }
    };
    window.addEventListener("keydown", keyHandler);
    this.disposers.push(() => window.removeEventListener("keydown", keyHandler));

    this.disposers.push(
      social.onChange(() => {
        this.harvestCasing();
        this.renderTabs();
        this.renderBody();
        this.renderMini();
      }),
      social.onMessage((channel, msg) => {
        const visible = this.open && this.active === channel;
        if (!visible && msg.from.toLowerCase() !== social.me.toLowerCase()) {
          this.unread.set(channel, (this.unread.get(channel) ?? 0) + 1);
        }
        if (channel.startsWith("dm:") && !this.dmTabs.includes(channel.slice(3))) {
          this.dmTabs.push(channel.slice(3)); // incoming whisper opens its tab
        }
        this.renderBadge();
      })
    );

    this.renderTabs();
    this.renderBody();
    this.renderMini();
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  private openPanel(channel?: Channel): void {
    this.open = true;
    if (channel) this.active = channel;
    this.root.classList.add("full");
    this.panel.style.display = "grid";
    this.mini.style.display = "none";
    this.unread.delete(this.active);
    this.renderTabs();
    this.renderBody();
    this.renderBadge();
    if (this.active !== "friends") this.input.focus();
  }

  private close(): void {
    this.open = false;
    this.root.classList.remove("full");
    this.panel.style.display = "none";
    this.mini.style.display = "grid";
    this.input.blur();
    this.renderMini();
  }

  private setActive(channel: Channel): void {
    this.active = channel;
    this.unread.delete(channel);
    this.input.placeholder =
      channel === "lobby" ? "message the lobby…" : `whisper ${this.displayName(channel.slice(3))}…`;
    this.inputRow.style.display = channel === "friends" ? "none" : "flex";
    this.renderTabs();
    this.renderBody();
    this.renderBadge();
    if (channel !== "friends") this.input.focus();
  }

  private async sendCurrent(text: string): Promise<void> {
    const channel = this.active;
    this.input.value = "";
    try {
      if (channel === "lobby") await this.social.send(text);
      else if (channel.startsWith("dm:")) await this.social.send(text, channel.slice(3));
    } catch (ex) {
      this.systemLine(ex instanceof Error ? ex.message : "Could not send.");
    }
  }

  /** Open (or focus) a whisper tab with `user` and pull its history. */
  openDm(user: string): void {
    const key = user.toLowerCase();
    if (!this.dmTabs.includes(key)) this.dmTabs.push(key);
    void this.social.loadDmHistory(user);
    this.openPanel(`dm:${key}`);
    this.setActive(`dm:${key}`);
  }

  /**
   * World-channel announcement — boss phase warnings, engage/enrage/wipe.
   * Local only: shows in the lobby feed and the collapsed mini feed, never
   * posted to the server. The fight sim calls this via `window.psyrena.chat`.
   */
  announce(text: string): void {
    this.systemFeed.push({ at: Date.now(), text });
    if (this.systemFeed.length > 50) this.systemFeed.splice(0, this.systemFeed.length - 50);
    if (this.open && this.active === "lobby") this.renderBody();
    else this.renderMini();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderTabs(): void {
    const tabs: { channel: Channel; label: string }[] = [
      { channel: "lobby", label: "LOBBY" },
      { channel: "friends", label: `FRIENDS${this.social.incoming.length ? " !" : ""}` },
      ...this.dmTabs.map((u) => ({ channel: `dm:${u}` as Channel, label: this.displayName(u) })),
    ];
    this.tabsEl.replaceChildren(
      ...tabs.map(({ channel, label }) => {
        const isActive = this.active === channel;
        const tab = document.createElement("button");
        tab.style.cssText = [
          "display:flex",
          "align-items:center",
          "gap:4px",
          "border:none",
          "border-radius:5px 5px 0 0",
          "padding:4px 8px",
          "font:inherit",
          "font-size:10px",
          "letter-spacing:.08em",
          "cursor:pointer",
          "white-space:nowrap",
          isActive ? "background:rgba(64,230,255,.16);color:#40e6ff" : "background:transparent;color:#7fdcf0",
        ].join(";");
        const text = document.createElement("span");
        text.textContent = label;
        tab.appendChild(text);
        const n = this.unread.get(channel) ?? 0;
        if (n > 0 && !isActive) {
          const dot = document.createElement("span");
          dot.textContent = String(n);
          dot.style.cssText =
            "background:#ff59b8;color:#fff;border-radius:7px;padding:0 4px;font-size:9px;line-height:13px";
          tab.appendChild(dot);
        }
        tab.addEventListener("click", () => this.setActive(channel));
        if (channel.startsWith("dm:")) {
          const x = document.createElement("span");
          x.textContent = "×";
          x.title = "Close whisper";
          x.style.cssText = "opacity:.6;margin-left:2px";
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dmTabs = this.dmTabs.filter((u) => u !== channel.slice(3));
            this.unread.delete(channel);
            if (this.active === channel) this.setActive("lobby");
            else this.renderTabs();
            this.renderBadge();
          });
          tab.appendChild(x);
        }
        return tab;
      })
    );
  }

  private renderBody(): void {
    if (this.active === "friends") {
      this.renderFriends();
      this.inputRow.style.display = "none";
      return;
    }
    this.inputRow.style.display = "flex";
    const stick =
      this.bodyEl.scrollTop + this.bodyEl.clientHeight >= this.bodyEl.scrollHeight - 24;
    if (this.active === "lobby") {
      // Lobby view merges player chat with local world/system announcements,
      // time-ordered, so boss calls land exactly where the raid is talking.
      type Row = { at: number; el: HTMLDivElement };
      const rows: Row[] = this.social.lobby.map((m) => ({ at: m.at, el: this.messageLine(m) }));
      for (const s of this.systemFeed) rows.push({ at: s.at, el: this.worldLine(s.text) });
      rows.sort((a, b) => a.at - b.at);
      this.bodyEl.replaceChildren(...rows.map((r) => r.el));
      if (rows.length === 0) this.systemLine("The lobby is quiet. Say something.");
    } else {
      const messages = this.social.thread(this.active.slice(3));
      this.bodyEl.replaceChildren(...messages.map((m) => this.messageLine(m)));
      if (messages.length === 0) this.systemLine("No whispers yet.");
    }
    if (stick) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  /** World-channel line — the boss's announcements read as broadcast, not chat. */
  private worldLine(text: string): HTMLDivElement {
    const line = document.createElement("div");
    line.style.cssText = "font-size:11px;word-break:break-word";
    const tag = document.createElement("span");
    tag.textContent = "[World] ";
    tag.style.cssText = "color:#ffb84d;font-weight:600";
    const body = document.createElement("span");
    body.textContent = text;
    body.style.cssText = "color:#ffd97a";
    line.append(tag, body);
    return line;
  }

  private messageLine(m: ChatMessage): HTMLDivElement {
    const line = document.createElement("div");
    line.style.cssText = "font-size:11px;word-break:break-word";
    const when = new Date(m.at);
    const hh = `${when.getHours()}`.padStart(2, "0");
    const mm = `${when.getMinutes()}`.padStart(2, "0");
    const time = document.createElement("span");
    time.textContent = `${hh}:${mm} `;
    time.style.cssText = "color:#7fdcf0;opacity:.45;font-size:9px";
    const who = document.createElement("span");
    who.textContent = `${m.from}: `;
    const mine = m.from.toLowerCase() === this.social.me.toLowerCase();
    who.style.cssText = `color:${mine ? "#ffd97a" : "#40e6ff"};cursor:${mine ? "default" : "pointer"}`;
    if (!mine) {
      who.title = `Whisper ${m.from}`;
      who.addEventListener("click", () => this.openDm(m.from));
    }
    const body = document.createElement("span");
    body.textContent = m.body;
    line.append(time, who, body);
    if (!mine) {
      // Moderation intake: flag a message → prompt for a reason → report.
      // Deliberately faint until hovered; reporting is a rare action.
      const flag = document.createElement("span");
      flag.textContent = " ⚑";
      flag.title = `Report this message from ${m.from}`;
      flag.style.cssText = "cursor:pointer;opacity:.25;color:#ff7a7a;font-size:10px";
      flag.addEventListener("mouseenter", () => (flag.style.opacity = "1"));
      flag.addEventListener("mouseleave", () => (flag.style.opacity = ".25"));
      flag.addEventListener("click", () => {
        const reason = window.prompt(`Report ${m.from} — what's wrong with this message?`, "");
        if (reason === null || !reason.trim()) return;
        this.social
          .report({ messageId: m.id, reason: reason.trim() })
          .then(() => this.systemLine("Report sent — a moderator will take a look."))
          .catch((ex) =>
            this.systemLine(ex instanceof Error ? ex.message : "Could not send the report."));
      });
      line.append(flag);
    }
    return line;
  }

  private systemLine(text: string): void {
    const line = document.createElement("div");
    line.textContent = text;
    line.style.cssText = "color:#7fdcf0;opacity:.6;font-style:italic;font-size:10px";
    this.bodyEl.appendChild(line);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  private renderFriends(): void {
    const rows: HTMLElement[] = [];

    // Add-friend input row.
    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex;gap:4px;margin-bottom:4px";
    const addInput = document.createElement("input");
    addInput.placeholder = "add friend by name…";
    addInput.autocomplete = "off";
    addInput.spellcheck = false;
    addInput.style.cssText = [
      "flex:1",
      "background:#0a1220",
      "color:#d8f7ff",
      "border:1px solid #23405c",
      "border-radius:5px",
      "padding:4px 7px",
      "font:inherit",
      "font-size:10px",
      "outline:none",
      "min-width:0",
    ].join(";");
    const addBtn = document.createElement("button");
    addBtn.textContent = "ADD";
    addBtn.style.cssText = this.buttonCss("4px 8px");
    const submit = async (): Promise<void> => {
      const name = addInput.value.trim();
      if (!name) return;
      addInput.value = "";
      try {
        await this.social.friendOp("request", name);
      } catch (ex) {
        this.toast(this.bodyEl, ex instanceof Error ? ex.message : "Could not send request.");
      }
    };
    addBtn.addEventListener("click", () => void submit());
    addInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void submit();
      if (e.key === "Escape") this.close();
    });
    addRow.append(addInput, addBtn);
    rows.push(addRow);

    for (const name of this.social.incoming) {
      const row = this.friendRowBase(name, "wants to be friends");
      const yes = document.createElement("button");
      yes.textContent = "✓";
      yes.title = "Accept";
      yes.style.cssText = this.buttonCss("2px 7px", "#5ee88f");
      yes.addEventListener("click", () => void this.social.friendOp("accept", name).catch(() => undefined));
      const no = document.createElement("button");
      no.textContent = "✕";
      no.title = "Decline";
      no.style.cssText = this.buttonCss("2px 7px", "#ff8896");
      no.addEventListener("click", () => void this.social.friendOp("decline", name).catch(() => undefined));
      row.append(yes, no);
      rows.push(row);
    }

    for (const name of this.social.outgoing) {
      const row = this.friendRowBase(name, "request pending…");
      rows.push(row);
    }

    const sorted = [...this.social.friends].sort(
      (a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username)
    );
    for (const f of sorted) {
      const row = this.friendRowBase(f.username, f.online ? "online" : "offline", f.hero, f.online);
      const whisper = document.createElement("button");
      whisper.textContent = "💬";
      whisper.title = `Whisper ${f.username}`;
      whisper.style.cssText = this.buttonCss("2px 6px");
      whisper.addEventListener("click", () => this.openDm(f.username));
      const remove = document.createElement("button");
      remove.textContent = "✕";
      remove.title = "Remove friend";
      remove.style.cssText = this.buttonCss("2px 6px", "#ff8896");
      remove.addEventListener("click", () => void this.social.friendOp("remove", f.username).catch(() => undefined));
      row.append(whisper, remove);
      rows.push(row);
    }

    if (this.social.friends.length === 0 && this.social.incoming.length === 0 && this.social.outgoing.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No friends yet — add someone by name above.";
      empty.style.cssText = "color:#7fdcf0;opacity:.6;font-style:italic;font-size:10px;padding:6px 0";
      rows.push(empty);
    }

    this.bodyEl.replaceChildren(...rows);
  }

  private friendRowBase(name: string, note: string, hero?: string, online?: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0";
    if (hero !== undefined) {
      const dot = document.createElement("span");
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;flex:none;background:${
        online ? "#5ee88f" : "rgba(127,220,240,.25)"
      }`;
      const img = document.createElement("img");
      img.src = heroPortrait(hero);
      img.alt = hero;
      img.style.cssText = `width:20px;height:20px;object-fit:cover;border-radius:50%;flex:none;${
        online ? "" : "filter:grayscale(1) brightness(.6)"
      }`;
      row.append(dot, img);
    }
    const label = document.createElement("span");
    label.textContent = name;
    label.style.cssText = "color:#d8f7ff;flex:none";
    const noteEl = document.createElement("span");
    noteEl.textContent = note;
    noteEl.style.cssText = "color:#7fdcf0;opacity:.55;font-size:9px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    row.append(label, noteEl);
    return row;
  }

  private toast(host: HTMLElement, text: string): void {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = "color:#ff8896;font-size:10px;padding:2px 0";
    host.prepend(t);
    setTimeout(() => t.remove(), 4000);
  }

  private renderMini(): void {
    if (this.open) return;
    // One merged feed: lobby plus every whisper thread plus world/system
    // announcements, newest 5 overall, so a whisper (or a boss phase warning)
    // is never invisible just because the lobby is busy.
    type MiniRow = { at: number; el: HTMLDivElement };
    const rows: MiniRow[] = [];
    const all: ChatMessage[] = [...this.social.lobby];
    for (const thread of this.social.dms.values()) all.push(...thread);
    for (const m of all) {
      rows.push({
        at: m.at,
        el: (() => {
          const line = document.createElement("div");
          line.style.cssText =
            "font-size:10px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;max-width:100%";
          const whisper = m.to !== undefined;
          const mine = m.from.toLowerCase() === this.social.me.toLowerCase();
          const who = document.createElement("span");
          who.textContent = whisper ? `[w] ${m.from}: ` : `${m.from}: `;
          who.style.cssText = `color:${whisper ? "#ff59b8" : mine ? "#ffd97a" : "#40e6ff"}`;
          const body = document.createElement("span");
          body.textContent = m.body;
          body.style.cssText = "color:#d8f7ff";
          line.append(who, body);
          return line;
        })(),
      });
    }
    for (const s of this.systemFeed) {
      rows.push({
        at: s.at,
        el: (() => {
          const line = document.createElement("div");
          line.style.cssText =
            "font-size:10px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;max-width:100%";
          const tag = document.createElement("span");
          tag.textContent = "[World] ";
          tag.style.cssText = "color:#ffb84d";
          const body = document.createElement("span");
          body.textContent = s.text;
          body.style.cssText = "color:#ffd97a";
          line.append(tag, body);
          return line;
        })(),
      });
    }
    rows.sort((a, b) => a.at - b.at);
    this.mini.replaceChildren(...rows.slice(-MINI_ROWS).map((r) => r.el));
  }

  private renderBadge(): void {
    let total = 0;
    for (const n of this.unread.values()) total += n;
    this.badge.style.display = total > 0 ? "block" : "none";
    this.badge.textContent = total > 9 ? "9+" : String(total);
    this.renderTabs();
    this.renderMini();
  }

  private displayName(lower: string): string {
    return this.casing.get(lower) ?? lower;
  }

  private harvestCasing(): void {
    for (const f of this.social.friends) this.casing.set(f.username.toLowerCase(), f.username);
    for (const m of this.social.lobby) this.casing.set(m.from.toLowerCase(), m.from);
  }

  private buttonCss(padding: string, color = "#40e6ff"): string {
    return [
      `background:rgba(64,230,255,.08)`,
      `border:1px solid ${color}55`,
      `color:${color}`,
      "border-radius:5px",
      `padding:${padding}`,
      "font:inherit",
      "font-size:10px",
      "cursor:pointer",
      "flex:none",
    ].join(";");
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.root.remove();
  }
}
