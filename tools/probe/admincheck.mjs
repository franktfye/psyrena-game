// Admin console / invites / gift codes / moderation API verification driver.
// Boots server/index.mjs on a throwaway SQLite DB and walks the whole admin
// feature set end-to-end with plain fetch — no browser needed.
// Usage: node admincheck.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "psyrena-admincheck-"));

const server = spawn("node", ["server/index.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PSYRENA_DB: join(dir, "check.db"),
    PSYRENA_REGISTER_RATE_MAX: "100",
    PSYRENA_LOGIN_RATE_MAX: "100",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Cookie-jar fetch client, one per simulated player. */
function client() {
  let cookie = "";
  return async (path, body, method) => {
    const res = await fetch(BASE + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, text };
  };
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}

try {
  await waitUp();
  const alice = client(), bob = client(), carol = client(), dave = client();
  const PW = "hunter22hunter";

  // ---- Bootstrap: first account registers with no code and becomes admin --
  let r = await alice("/api/register", { username: "alice", password: PW });
  check("first registration needs no invite", r.status === 200, r.text);
  r = await alice("/api/admin/me");
  check("first account is bootstrapped to admin", r.json.admin === true, r.text);

  // ---- Invite gate --------------------------------------------------------
  r = await bob("/api/register", { username: "bob", password: PW });
  check("second registration without a code is refused", r.status === 403, r.text);
  r = await bob("/api/register", { username: "bob", password: PW, inviteCode: "PSY-FAKE-CODE" });
  check("invite without student ID is refused", r.status === 400, r.text);
  r = await bob("/api/register", { username: "bob", password: PW, inviteCode: "PSY-FAKE-CODE", studentId: "S-bob" });
  check("bad invite code is refused", r.status === 403, r.text);

  r = await alice("/api/admin/invites/create", { count: 1, maxUses: 1 });
  const oneTime = r.json.codes?.[0];
  check("admin mints a one-time invite", r.status === 200 && !!oneTime, r.text);
  r = await bob("/api/register", { username: "bob", password: PW, inviteCode: oneTime.toLowerCase(), studentId: "S-bob" });
  check("one-time invite registers bob (case-insensitive)", r.status === 200, r.text);
  r = await carol("/api/register", { username: "carol", password: PW, inviteCode: oneTime, studentId: "S-carol" });
  check("spent one-time invite is refused", r.status === 403, r.text);

  r = await alice("/api/admin/invites/create", { count: 1, maxUses: 2, note: "friends" });
  const multi = r.json.codes?.[0];
  r = await carol("/api/register", { username: "carol", password: PW, inviteCode: multi, studentId: "S-carol" });
  check("multi-use invite: first use", r.status === 200, r.text);
  r = await dave("/api/register", { username: "dave", password: PW, inviteCode: multi, studentId: "S-dave" });
  check("multi-use invite: second use", r.status === 200, r.text);
  r = await alice("/api/admin/invites");
  const multiRow = r.json.codes?.find((c) => c.code === multi);
  check("invite list shows uses and redeemers", multiRow?.uses === 2 && multiRow?.usedBy?.length === 2, JSON.stringify(multiRow));

  // ---- Gift codes ---------------------------------------------------------
  r = await alice("/api/admin/gifts/create", { rewardType: "imaginz", amount: 250, maxUses: 2 });
  const giftMoney = r.json.code;
  check("admin mints an imaginz gift code", r.status === 200 && !!giftMoney, r.text);
  r = await bob("/api/coffee/redeem", { code: giftMoney });
  check("bob redeems imaginz gift (500→750)", r.status === 200 && r.json.imaginz === 750, r.text);
  r = await bob("/api/coffee/redeem", { code: giftMoney });
  check("double redemption by same account refused", r.status === 409, r.text);
  r = await carol("/api/coffee/redeem", { code: giftMoney });
  check("carol takes the second use", r.status === 200, r.text);
  r = await dave("/api/coffee/redeem", { code: giftMoney });
  check("fully-used gift code refused", r.status === 410, r.text);

  r = await alice("/api/admin/gifts/create", { rewardType: "item", item: "latte_s", code: "welcome-2026", maxUses: 0 });
  check("custom unlimited item code minted", r.status === 200 && r.json.code === "WELCOME-2026", r.text);
  r = await dave("/api/coffee/redeem", { code: "WELCOME-2026" });
  check("item gift grants a potion", r.status === 200 && r.json.active?.some((p) => p.effect === "damage"), r.text);
  r = await alice("/api/admin/gifts/disable", { code: "WELCOME-2026" });
  r = await carol("/api/coffee/redeem", { code: "WELCOME-2026" });
  check("disabled gift code refused", r.status === 404, r.text);

  // ---- Chat, mute, report, delete ----------------------------------------
  r = await bob("/api/social/send", { body: "selling rare pets for real money, DM me" });
  const msgId = r.json.msg?.id;
  check("bob talks in lobby", r.status === 200 && !!msgId, r.text);

  r = await carol("/api/social/report", { messageId: msgId, reason: "RMT spam" });
  check("carol reports the message", r.status === 200 && !!r.json.reportId, r.text);
  const reportId = r.json.reportId;
  r = await carol("/api/social/report", { reason: "no target" });
  check("report without target refused", r.status === 404 || r.status === 400, r.text);

  r = await alice("/api/admin/reports?status=open");
  const rep = r.json.reports?.find((x) => x.id === reportId);
  check("report shows in console with message snapshot", !!rep && rep.messageBody?.includes("rare pets") && rep.target === "bob", JSON.stringify(rep));

  r = await alice("/api/admin/user/mute", { username: "bob", minutes: 10 });
  check("admin mutes bob", r.status === 200, r.text);
  r = await bob("/api/social/send", { body: "still here" });
  check("muted bob cannot chat", r.status === 403, r.text);
  r = await alice("/api/admin/user/unmute", { username: "bob" });
  r = await bob("/api/social/send", { body: "reformed" });
  check("unmuted bob chats again", r.status === 200, r.text);

  r = await alice("/api/admin/reports/resolve", { id: reportId, status: "resolved", resolution: "muted 10m" });
  check("report resolved", r.status === 200, r.text);
  r = await alice("/api/admin/reports?status=open");
  check("no open reports remain", r.json.reports?.length === 0, r.text);

  r = await alice("/api/admin/chat/delete", { id: msgId });
  check("admin deletes the offending message", r.status === 200, r.text);
  r = await alice("/api/admin/chat?limit=100");
  check("deleted message gone from history", !r.json.messages?.some((m) => m.id === msgId), r.text);

  // ---- Ban / unban --------------------------------------------------------
  r = await alice("/api/admin/user/ban", { username: "dave", hours: 1, reason: "testing the hammer" });
  check("admin bans dave", r.status === 200, r.text);
  r = await dave("/api/me");
  check("dave's session is dead", r.status === 401, r.text);
  r = await dave("/api/login", { username: "dave", password: PW });
  check("banned dave cannot log in", r.status === 403 && /banned/i.test(r.json.error ?? ""), r.text);
  r = await alice("/api/admin/users?filter=banned");
  check("banned filter finds dave", r.json.users?.some((u) => u.username === "dave"), r.text);
  r = await alice("/api/admin/user/unban", { username: "dave" });
  r = await dave("/api/login", { username: "dave", password: PW });
  check("unbanned dave logs back in", r.status === 200, r.text);

  // ---- Appoint / demote ---------------------------------------------------
  r = await bob("/api/admin/overview");
  check("non-admin bob is refused by admin API", r.status === 403, r.text);
  r = await alice("/api/admin/user/appoint", { username: "bob" });
  check("alice appoints bob as admin", r.status === 200, r.text);
  r = await bob("/api/admin/overview");
  check("admin bob reads the overview", r.status === 200, r.text);
  r = await bob("/api/admin/user/appoint", { username: "alice", admin: false });
  check("bob demotes alice", r.status === 200, r.text);
  r = await bob("/api/admin/user/appoint", { username: "bob", admin: false });
  check("demoting the last admin is refused", r.status === 409, r.text);
  r = await bob("/api/admin/user/appoint", { username: "alice", admin: true });
  check("alice re-appointed", r.status === 200, r.text);

  // ---- Wallet grants ------------------------------------------------------
  r = await alice("/api/admin/user/grant", { username: "carol", imaginz: 250 });
  check("grant raises carol's balance (750→1000)", r.status === 200 && r.json.balance === 1000, r.text);
  r = await alice("/api/admin/user/grant", { username: "carol", imaginz: -99999 });
  check("over-deduction refused", r.status === 400, r.text);

  // ---- Admin creates a user -----------------------------------------------
  const eve = client();
  r = await carol("/api/admin/user/create", { username: "eve", password: PW });
  check("non-admin cannot create users", r.status === 403, r.text);
  r = await alice("/api/admin/user/create", { username: "x", password: PW });
  check("bad username refused", r.status === 400, r.text);
  r = await alice("/api/admin/user/create", { username: "eve", password: "short" });
  check("short password refused", r.status === 400, r.text);
  r = await alice("/api/admin/user/create", { username: "eve", password: PW, studentId: "S-2026-042" });
  const eveId = r.json.id;
  check("admin creates eve (no invite needed)", r.status === 200 && !!eveId, r.text);
  r = await alice("/api/admin/user/create", { username: "EVE", password: PW });
  check("duplicate name refused (case-insensitive)", r.status === 409, r.text);
  r = await alice("/api/admin/me");
  check("creating a user keeps the admin's own session", r.json.admin === true, r.text);
  r = await eve("/api/login", { username: "eve", password: PW });
  check("eve logs in with the issued password", r.status === 200, r.text);
  r = await alice(`/api/admin/user?id=${eveId}`);
  check("eve's detail shows the student ID", r.json.studentId === "S-2026-042", r.text);

  // ---- Admin resets a password --------------------------------------------
  const PW2 = "a-new-password-42";
  r = await carol("/api/admin/user/password", { username: "eve", password: PW2 });
  check("non-admin cannot set passwords", r.status === 403, r.text);
  r = await alice("/api/admin/user/password", { username: "eve", password: "short" });
  check("short replacement password refused", r.status === 400, r.text);
  r = await alice("/api/admin/user/password", { username: "bob", password: PW2 });
  check("changing another admin's password refused", r.status === 400, r.text);
  r = await alice("/api/admin/user/password", { username: "eve", password: PW2 });
  check("admin resets eve's password", r.status === 200, r.text);
  r = await eve("/api/me");
  check("eve's old session is dead after the reset", r.status === 401, r.text);
  r = await eve("/api/login", { username: "eve", password: PW });
  check("eve's old password no longer works", r.status === 401, r.text);
  r = await eve("/api/login", { username: "eve", password: PW2 });
  check("eve logs in with the new password", r.status === 200, r.text);
  r = await alice("/api/admin/user/password", { username: "alice", password: PW });
  check("admin can reset their own password", r.status === 200, r.text);
  r = await alice("/api/admin/me");
  check("self password change keeps the console session", r.json.admin === true, r.text);

  // ---- Stats & event log --------------------------------------------------
  r = await alice("/api/admin/overview");
  const t = r.json.totals ?? {};
  check("overview counts users/admins", t.users === 5 && t.admins === 2, JSON.stringify(t));
  check("overview counts registrations today", t.registrationsToday === 4, JSON.stringify(t));
  check("overview has 14-day series", r.json.days?.length === 14 && r.json.series?.registrations, "");

  r = await alice("/api/admin/events?limit=200");
  const types = new Set((r.json.events ?? []).map((e) => e.type));
  for (const expect of ["auth.register", "auth.login", "invite.redeem", "gift.redeem",
                        "report.file", "admin.ban", "admin.appoint", "admin.mute", "admin.grant",
                        "admin.user_create", "admin.user_password"]) {
    check(`event log recorded ${expect}`, types.has(expect), [...types].join(","));
  }
  r = await alice("/api/admin/events?type=gift.redeem");
  check("event log filters by type", r.json.events?.length === 3 && r.json.events.every((e) => e.type === "gift.redeem"), r.text);
  r = await alice("/api/admin/user?id=2");
  check("user detail shows invite provenance", r.json.username === "bob" && r.json.invitedWith === oneTime, r.text);

  // ---- Console shell ------------------------------------------------------
  r = await alice("/admin");
  check("GET /admin serves the console", r.status === 200 && r.text.includes("PSYRENA") && r.text.includes("ADMIN"), "");
  r = await dave("/api/admin/me");
  check("/api/admin/me says non-admin", r.json.loggedIn === true && r.json.admin === false, r.text);
} catch (err) {
  failed++;
  console.error("FATAL:", err);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
