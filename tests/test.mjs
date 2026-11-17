import assert from "node:assert/strict";
import { state } from "herdr";
import { calls, handlers } from "gpui-kit";

const ROOT = new URL("../mods", import.meta.url).href;
const G = await import(`${ROOT}/office-prs/github.js`);
const PRS = (await import(`${ROOT}/office-prs/main.js`)).default;
const PR = await import(`${ROOT}/office/prs.js`);
const Office = (await import(`${ROOT}/office/main.js`)).default;

let pending = [];
const cx = {
  timer: { every() {}, after() {} },
  spawn(f) { pending.push(f(cx)); },
  notify() {},
  stop_propagation() {},
};
const settle = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } };

// ---- fixtures -------------------------------------------------------------------------
const node = (o) => ({
  id: o.id, number: o.n, title: o.title ?? `PR ${o.n}`, url: `https://github.com/${o.repo ?? "dino/gpap"}/pull/${o.n}`,
  isDraft: o.draft ?? false, createdAt: "2026-11-10T10:00:00Z", updatedAt: o.updated ?? "2026-11-12T10:00:00Z",
  headRefName: o.branch ?? `feat/${o.n}`, additions: 10, deletions: 2, mergeable: o.mergeable ?? "MERGEABLE",
  reviewDecision: o.decision ?? "REVIEW_REQUIRED", author: { login: o.author ?? "dennis" },
  repository: { nameWithOwner: o.repo ?? "dino/gpap" }, comments: { totalCount: o.comments ?? 0 },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "samuel" } }] },
  latestReviews: { nodes: o.approvals ? [{ state: "APPROVED", author: { login: "emilio" } }] : [] },
  commits: { nodes: [{ commit: { statusCheckRollup: o.checks ? { state: o.checks } : null } }] },
});
let mineNodes = [
  node({ id: "PR_a", n: 1, checks: "SUCCESS", decision: "APPROVED", approvals: 1 }),
  node({ id: "PR_b", n: 2, checks: "PENDING", branch: "fix/login" }),
  node({ id: "PR_c", n: 3, draft: true }),
  node({ id: "PR_d", n: 4, checks: "SUCCESS", mergeable: "CONFLICTING" }),
  node({ id: "PR_e", n: 5, checks: "SUCCESS" }),
];
let reviewNodes = [node({ id: "PR_r1", n: 77, repo: "gorilla/budget", author: "sebastian" }), node({ id: "PR_a", n: 1 })];
let mergedIds = new Set();
state.execImpl = async (cmd, args) => {
  assert.equal(cmd, "gh");
  if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "dennis\n", stderr: "" };
  if (args[0] === "pr") return { code: 0, stdout: "", stderr: "" };
  const q = args.find((a) => a.startsWith("query=")).slice(6);
  if (q.includes("nodes(ids")) {
    const ids = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return { code: 0, stdout: JSON.stringify({ data: { nodes: ids.map((id) => ({ id, merged: mergedIds.has(id) })) } }), stderr: "" };
  }
  assert.ok(args.includes("mine=is:pr is:open archived:false author:dennis sort:updated-desc"), args.join(" "));
  return { code: 0, stdout: JSON.stringify({ data: { mine: { nodes: mineNodes }, review: { nodes: reviewNodes } } }), stderr: "" };
};

// ---- github.js ------------------------------------------------------------------------
{
  const { next, events } = await G.fetchAll(null);
  assert.equal(events.length, 0, "no toasts on the first poll");
  assert.equal(next.login, "dennis");
  assert.deepEqual(next.mine.map((p) => [p.number, p.state]),
    [[4, "conflict"], [2, "running"], [1, "approved"], [5, "waiting"], [3, "draft"]]);
  assert.deepEqual(next.review.map((p) => p.number), [77], "own PR filtered out of reviews");
  assert.equal(next.review[0].state, "review");

  // Second poll: checks fail on #2, #5 approved, #4 still conflict, new review, #3 merged.
  mineNodes = [
    node({ id: "PR_a", n: 1, checks: "SUCCESS", decision: "APPROVED" }),
    node({ id: "PR_b", n: 2, checks: "FAILURE", branch: "fix/login" }),
    node({ id: "PR_d", n: 4, checks: "SUCCESS", mergeable: "CONFLICTING" }),
    node({ id: "PR_e", n: 5, checks: "SUCCESS", decision: "APPROVED" }),
  ];
  reviewNodes.push(node({ id: "PR_r2", n: 9, repo: "dino/nua", author: "emilio" }));
  mergedIds.add("PR_c");
  const r2 = await G.fetchAll(next);
  assert.deepEqual(r2.events.map((e) => `${e.kind}:${e.pr.number}`).sort(), ["approved:5", "failing:2", "merged:3", "review:9"]);
  assert.equal(r2.next.merged[0].number, 3);
  assert.equal(G.stateOf({ checks: "ERROR" }), "failing");
  assert.equal(G.ref(r2.next.review[0]), "budget#77");
  state.shared[G.KEY] = r2.next;

  // gh missing / signed out
  const saved = state.execImpl;
  state.execImpl = async () => { throw new Error("not found"); };
  await assert.rejects(G.fetchAll(null), /Install the GitHub CLI/);
  state.execImpl = async () => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login\n" });
  await assert.rejects(G.fetchAll(null), /isn't signed in/);
  state.execImpl = saved;
  console.log("github.js: ok");
}

// ---- office-prs view -------------------------------------------------------------------
{
  state.spaces = [{ id: "s1", name: "gpap", tabs: [{ id: "t1" }] }];
  state.panes = [{ pane: "p1", tab: "t1", cwd: "C:\\Users\\dennis\\src\\gpap\\backend", branch: "fix/login" }];
  const v = new PRS();
  state.props = {};
  v.init({}, cx);
  await settle();
  const root = v.render(cx);
  assert.ok(root.__node);
  // a row click opens the browser; hover a row and hand it to the agent
  const rowClick = handlers.find((h) => h.kind === "on_click" && h.id === "pr-PR_b");
  rowClick.fn({}, cx);
  assert.deepEqual(state.execs.at(-1), ["gh", "pr", "view", "https://github.com/dino/gpap/pull/2", "--web"]);
  v.hovered = "PR_b";
  handlers.length = 0;
  v.render(cx);
  handlers.find((h) => h.id === "pr-agent-PR_b").fn({}, cx);
  const tab = state.runs.at(-1);
  assert.equal(tab.name, "tab.new");
  assert.equal(tab.args.space, "s1");
  assert.equal(tab.args.folder, "C:\\Users\\dennis\\src\\gpap");
  assert.deepEqual(tab.args.argv, ["claude"]);
  assert.match(tab.args.task, /failing/);
  v.hovered = "PR_r1";
  v.render(cx);
  handlers.find((h) => h.id === "pr-agent-PR_r1").fn({}, cx);
  assert.deepEqual(state.runs.at(-1).args.argv, ["codex"]);
  assert.equal(state.runs.at(-1).args.space, undefined, "no space for gorilla/budget");
  assert.match(state.notifications.at(-1).title, /No space for budget/);

  // refresh posts toasts for changes; manual refresh button
  const before = state.notifications.length;
  mineNodes[0] = node({ id: "PR_a", n: 1, checks: "FAILURE", decision: "APPROVED" });
  v.refresh(cx);
  await settle();
  assert.equal(state.notifications.length, before + 1);
  assert.match(state.notifications.at(-1).title, /Checks failed · gpap#1/);
  assert.equal(state.shared[G.LEASE], null);

  // rail, overlay, error, empty, nothing yet
  v.width = 100; v.render(cx);
  v.width = 268; state.props = { overlay: "o1" }; v.render(cx); state.props = {};
  const ok = state.shared[G.KEY];
  state.shared[G.KEY] = { ...ok, error: "gh isn't signed in." }; v.render(cx);
  state.shared[G.KEY] = { ...ok, mine: [], review: [], merged: [] }; v.render(cx);
  state.shared[G.KEY] = undefined; v.render(cx); v.width = 100; v.render(cx); v.width = 268;
  state.shared[G.KEY] = ok;

  // an error keeps the last lists
  state.execImpl = async () => ({ code: 1, stdout: "", stderr: "HTTP 502\n" });
  v.refresh(cx); await settle();
  assert.equal(state.shared[G.KEY].error, "HTTP 502");
  assert.equal(state.shared[G.KEY].mine.length, 4);
  console.log("office-prs view: ok");
}

// ---- office ----------------------------------------------------------------------------
{
  const d = state.shared[G.KEY];
  assert.equal(PR.forBranch(d, "fix/login").number, 2);
  assert.equal(PR.forBranch(d, "main"), null);
  state.agents = [
    { address: "t1", pane: "p1", space: "s1", space_name: "gpap", tab: "t1", tab_name: "fix login", status: "working", title: "Fixing", program: { key: "claude" } },
    { address: "t2", pane: "p2", space: "s1", space_name: "gpap", tab: "t1", tab_name: "", status: "idle", title: "", program: { key: "codex" } },
  ];
  state.panes.push({ pane: "p2", tab: "t1", cwd: "/x", branch: "main" });
  state.terminals = state.agents.map((a) => ({ address: a.address, state: "live", turn: 1 }));
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const o = new Office();
  o.init({}, cx);
  handlers.length = 0;
  for (const H of [250, 170, 520]) { o.size = { width: 1400, height: H }; o.render(cx); }
  assert.ok(handlers.some((h) => h.id === "prtag-PR_b"), "desk flag for fix/login");
  assert.ok(handlers.some((h) => h.id === "prboard-head"), "corkboard drawn");
  handlers.find((h) => h.id === "prcard-PR_b").fn({}, cx);
  assert.deepEqual(state.execs.at(-1).slice(0, 3), ["gh", "pr", "view"]);
  handlers.find((h) => h.id === "prboard-head").fn({}, cx);
  assert.deepEqual(state.runs.at(-1), { name: "mod.open", args: { name: "office-prs" } });

  // a merge after the office opened: banner + a finish toward the pizza
  state.shared[G.KEY] = { ...d, merged: [{ id: "PR_z", repo: "dino/gpap", number: 12, title: "x", url: "u", at: Date.now() + 5 }, ...d.merged] };
  o.render(cx);
  assert.equal(o.merge?.number, 12);
  assert.equal(o.finishes.length, 1);
  o.render(cx);
  assert.equal(o.finishes.length, 1, "counted once");

  // without office-prs: no board, no flags
  state.shared[G.KEY] = undefined;
  handlers.length = 0;
  o.render(cx);
  assert.ok(!handlers.some((h) => String(h.id).startsWith("pr")), "nothing PR-ish without the addon");
  // error-only board and inbox zero
  state.shared[G.KEY] = { at: Date.now(), error: "gh isn't signed in.", mine: [], review: [], merged: [] }; o.render(cx);
  state.shared[G.KEY] = { at: Date.now() - 3600e3, error: null, mine: [], review: [], merged: [] }; o.render(cx);
  console.log("office: ok");
}
// ---- several gh accounts --------------------------------------------------------------
{
  const seenArgs = [];
  const data = {
    "dennis-personal": { mine: [node({ id: "P1", n: 101, repo: "pap/gpap", author: "dennis-personal", checks: "FAILURE" })], review: [] },
    "dennis-iron": { mine: [node({ id: "I1", n: 7, repo: "iron/api", author: "dennis-iron" })],
      review: [node({ id: "I2", n: 8, repo: "iron/web", author: "coworker" }), node({ id: "P1", n: 101, repo: "pap/gpap", author: "dennis-personal" })] },
  };
  let ironDown = false;
  state.execImpl = async (cmd, args) => {
    seenArgs.push(args);
    if (args[0] === "auth" && args[1] === "token") {
      const u = args[args.indexOf("--user") + 1];
      if (u === "dennis-iron" && ironDown) return { code: 1, stdout: "", stderr: "no oauth token found for github.com account dennis-iron\n" };
      return { code: 0, stdout: `tok-${u}\n`, stderr: "" };
    }
    assert.equal(args[0], "api");
    assert.equal(args[1], "-H", "token passed as a header");
    const who = args[2].replace("Authorization: token tok-", "");
    const q = args.find((a) => a.startsWith("query=")).slice(6);
    if (q.includes("nodes(ids")) return { code: 0, stdout: JSON.stringify({ data: { nodes: [] } }), stderr: "" };
    const mine = args.find((a) => a.startsWith("mine="));
    assert.ok(mine.includes(`author:${who}`), mine);
    if (who === "dennis-personal") assert.ok(mine.endsWith("org:pap"), mine);
    return { code: 0, stdout: JSON.stringify({ data: { mine: { nodes: data[who].mine }, review: { nodes: data[who].review } } }), stderr: "" };
  };
  const accounts = [{ user: "dennis-personal", label: "PAP", filter: "org:pap" }, { user: "dennis-iron", label: "Iron" }];
  const { next } = await G.fetchAll(null, { accounts });
  assert.deepEqual(next.mine.map((p) => `${p.account}:${p.number}`), ["PAP:101", "Iron:7"]);
  assert.deepEqual(next.review.map((p) => `${p.account}:${p.number}`), ["Iron:8"], "own PR from the other account isn't a review");
  assert.deepEqual(next.accounts, ["PAP", "Iron"]);
  assert.equal(next.error, null);
  // Iron's sign-in breaks: PAP still updates, Iron keeps its last lists, the error names Iron
  ironDown = true;
  data["dennis-personal"].mine[0] = node({ id: "P1", n: 101, repo: "pap/gpap", author: "dennis-personal", checks: "SUCCESS" });
  const r2 = await G.fetchAll(next, { accounts });
  assert.match(r2.next.error, /^Iron: gh isn't signed in/);
  assert.deepEqual(r2.next.mine.map((p) => p.number).sort(), [101, 7]);
  assert.deepEqual(r2.events.map((e) => e.kind), ["passed"]);
  // every account down: the poll fails as a whole
  data["dennis-personal"] = null;
  state.execImpl = async () => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials\n" });
  await assert.rejects(G.fetchAll(next, { accounts }), /PAP: .*\nIron: /s);
  state.shared[G.KEY] = r2.next;
  const v = new PRS(); state.props = {}; v.init({}, cx); v.render(cx); state.props = { overlay: "o" }; v.render(cx); state.props = {};
  console.log("accounts: ok");
}
console.log(`element methods used: ${[...calls.keys()].length}`);
