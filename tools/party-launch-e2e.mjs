/**
 * Party launch + invite push E2E (dev tool, not shipped).
 *
 * Covers the server half of the "leader takes the team in" flow, all over the
 * real HTTP/SSE surface with node fetch — no browser needed:
 *
 *   1. invite: an invite POST pushes an `invite` SSE event to the invitee
 *      (this is what the new invite popup listens to), and the invitee can
 *      accept it straight from the pushed roomId.
 *   2. launch: only the leader may POST /api/rooms/launch, and every member
 *      (leader included) receives a `partyLaunch` push carrying the room's
 *      difficulty.
 *   3. barrier: the fight-ready barrier releases with `fightStart` once every
 *      member is ready — and a member who posts {skip:true} ("not coming")
 *      counts toward it, so the rest are not held for the 45 s timeout.
 *   4. drop: a member leaving the room while the barrier is filling releases
 *      the remaining, already-ready members immediately.
 *   5. arena presence: /api/village/join {arena} is refused for a room you do
 *      not hold a seat in, and party members joining it see each other.
 *
 * Run: node tools/party-launch-e2e.mjs   (needs `npm run dev` already serving)
 */
const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password = PASS) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`${username} login -> ${res.status} ${await res.text()}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function api(cookie, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * Open a social stream and record every event.
 *
 * Hand-rolled SSE rather than a global EventSource: the stream is session
 * gated, and EventSource has no way to send the cookie.
 */
function listen(cookie) {
  const events = [];
  const ac = new AbortController();
  void (async () => {
    const res = await fetch(`${BASE}/api/social/stream`, {
      headers: { Cookie: cookie, Accept: "text/event-stream" },
      signal: ac.signal,
    });
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (!type || data === undefined) continue; // heartbeat comment
        try {
          events.push({ type, data: JSON.parse(data) });
        } catch {
          /* non-JSON frame */
        }
      }
    }
  })().catch(() => undefined); // aborting the stream is the normal exit

  return {
    events,
    close: () => ac.abort(),
    /** Wait until an event of `type` shows up, or give up after `ms`. */
    async wait(type, ms = 4000) {
      const until = Date.now() + ms;
      for (;;) {
        const hit = events.find((e) => e.type === type);
        if (hit) return hit.data;
        if (Date.now() > until) return null;
        await sleep(50);
      }
    },
    forget: () => events.splice(0, events.length),
  };
}

/** Everyone out of rooms/queues, so a re-run starts from the same place. */
async function reset(cookies) {
  for (const c of cookies) {
    await api(c, "/api/queue/leave", {});
    await api(c, "/api/rooms/leave", {});
  }
}

async function befriend(a, b, nameB) {
  // Idempotent: already-friends returns an error we can ignore.
  await api(a, "/api/social/friend", { op: "request", username: nameB });
  await api(b, "/api/social/friend", { op: "accept", username: "frank" });
}

async function main() {
  const frank = await login("frank");
  const jung = await login("jung");
  const adler = await login("adler");
  const cookies = [frank, jung, adler];
  await reset(cookies);

  const sFrank = listen(frank);
  const sJung = listen(jung);
  const sAdler = listen(adler);
  await sleep(400); // let the streams say hello

  // ---- 1. invite pushes, and the pushed roomId is joinable ----------------
  await befriend(frank, jung, "jung");
  await befriend(frank, adler, "adler");
  const created = await api(frank, "/api/rooms/create", {
    name: "Launch Test",
    isPublic: false,
    difficulty: "hard",
  });
  check(created.status === 200, `frank creates a room (${created.status})`);
  const roomId = created.json.room?.id;

  const inv = await api(frank, "/api/rooms/invite", { username: "jung" });
  check(inv.status === 200, `frank invites jung (${inv.status})`);
  const pushed = await sJung.wait("invite");
  check(pushed !== null, "jung's stream receives an `invite` push");
  check(pushed?.roomId === roomId, `the push carries the room id (${pushed?.roomId} === ${roomId})`);
  check(pushed?.from === "frank", `the push names the inviter (${pushed?.from})`);

  // The invite popup's Join button is exactly this call.
  const joined = await api(jung, "/api/rooms/join", { roomId: pushed.roomId });
  check(joined.status === 200, `jung joins from the pushed invite (${joined.status})`);
  check(
    joined.json.room?.members?.some((m) => m.username === "jung"),
    "jung is seated in the party"
  );

  await api(frank, "/api/rooms/invite", { username: "adler" });
  await api(adler, "/api/rooms/join", { roomId });

  // ---- 2. launch is leader-only and pushes every member -------------------
  const memberLaunch = await api(jung, "/api/rooms/launch", {});
  check(memberLaunch.status === 403, `a non-leader cannot launch (${memberLaunch.status})`);

  const launch = await api(frank, "/api/rooms/launch", {});
  check(launch.status === 200, `the leader launches (${launch.status})`);
  for (const [name, stream] of [["frank", sFrank], ["jung", sJung], ["adler", sAdler]]) {
    const got = await stream.wait("partyLaunch");
    check(got !== null, `${name} receives partyLaunch`);
    check(got?.difficulty === "hard", `${name}'s push carries the room difficulty (${got?.difficulty})`);
  }

  // ---- 3. the barrier releases when everyone is ready ---------------------
  const r1 = await api(frank, "/api/fight/ready", {});
  check(r1.json.solo === false && r1.json.total === 3, `frank readies: 1/3 (${JSON.stringify(r1.json)})`);
  const r2 = await api(jung, "/api/fight/ready", {});
  check(r2.json.ready === 2, `jung readies: 2/3 (ready=${r2.json.ready})`);
  check((await sFrank.wait("fightStart", 500)) === null, "no fightStart while a member is still loading");
  const r3 = await api(adler, "/api/fight/ready", {});
  check(r3.json.ready === 3 || r3.json.solo === false, "adler readies: the barrier fills");
  for (const [name, stream] of [["frank", sFrank], ["jung", sJung], ["adler", sAdler]]) {
    check((await stream.wait("fightStart")) !== null, `${name} receives fightStart`);
  }

  // ---- 4. a skipper counts, and a leaver releases the rest ---------------
  for (const s of [sFrank, sJung, sAdler]) s.forget();
  await reset(cookies);
  const room2 = await api(frank, "/api/rooms/create", { name: "Skip Test", isPublic: true });
  const roomId2 = room2.json.room?.id;
  await api(frank, "/api/rooms/invite", { username: "jung" });
  await api(jung, "/api/rooms/join", { roomId: roomId2 });
  await api(frank, "/api/rooms/invite", { username: "adler" });
  await api(adler, "/api/rooms/join", { roomId: roomId2 });

  await api(frank, "/api/fight/ready", {});
  await api(jung, "/api/fight/ready", {});
  const skip = await api(adler, "/api/fight/ready", { skip: true });
  check(skip.json.skipped === true, `a skipper is told it is not waiting (${JSON.stringify(skip.json)})`);
  check((await sFrank.wait("fightStart")) !== null, "a skipping member releases the barrier for the rest");

  for (const s of [sFrank, sJung, sAdler]) s.forget();
  await reset(cookies);
  const room3 = await api(frank, "/api/rooms/create", { name: "Drop Test", isPublic: true });
  const roomId3 = room3.json.room?.id;
  await api(frank, "/api/rooms/invite", { username: "jung" });
  await api(jung, "/api/rooms/join", { roomId: roomId3 });
  await api(frank, "/api/rooms/invite", { username: "adler" });
  await api(adler, "/api/rooms/join", { roomId: roomId3 });
  await api(frank, "/api/fight/ready", {});
  await api(jung, "/api/fight/ready", {});
  check((await sFrank.wait("fightStart", 500)) === null, "barrier still waiting on the third member");
  await api(adler, "/api/rooms/leave", {}); // he dropped
  check((await sFrank.wait("fightStart")) !== null, "a member DROPPING releases the barrier for the rest");

  // ---- 5. arena presence session is party-gated ---------------------------
  const outsider = await api(adler, "/api/village/join", { arena: roomId3 });
  check(outsider.status === 403, `a non-member cannot join the party's arena session (${outsider.status})`);
  const aFrank = await api(frank, "/api/village/join", { arena: roomId3 });
  check(aFrank.status === 200, `a member joins the arena session (${aFrank.status})`);
  check(aFrank.json.sessionId === `a${roomId3}`, `arena session id is a<roomId> (${aFrank.json.sessionId})`);
  const aJung = await api(jung, "/api/village/join", { arena: roomId3 });
  check(
    (aJung.json.players ?? []).some((p) => p.username === "frank"),
    "teammates see each other in the arena session roster"
  );

  // ---- 6. pets ride the village roster ------------------------------------
  await api(frank, "/api/village/join", { pet: "corgi" });
  const jungVillage = await api(jung, "/api/village/join", { pet: "husky" });
  const frankSeen = (jungVillage.json.players ?? []).find((p) => p.username === "frank");
  check(frankSeen?.pet === "corgi", `a village roster carries the other player's pet (${frankSeen?.pet})`);

  for (const s of [sFrank, sJung, sAdler]) s.close();
  await reset(cookies);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
