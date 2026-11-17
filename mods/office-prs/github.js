// GitHub, through the `gh` CLI the person already signed in with. One GraphQL call per
// poll fetches both lists: pull requests you opened, and ones waiting on your review.
// Everything here except `fetchAll` and `openInBrowser` is plain data in, data out.
import { exec } from "herdr";

export const KEY = "office.prs"; // shared(): what the office and every copy of this mod read
export const LEASE = "office.prs.lease"; // shared(): which copy is polling right now

// What a pull request is waiting on, most urgent first. `review` is someone else's PR
// that asks for your review; the rest are your own.
export const STATES = {
  review: { rank: 8, label: "Your review", short: "👀 YOU", glyph: "👀" },
  failing: { rank: 7, label: "Checks failing", short: "CI ✗", glyph: "✗" },
  conflict: { rank: 6, label: "Merge conflict", short: "CONFLICT", glyph: "⚠" },
  changes: { rank: 5, label: "Changes requested", short: "CHANGES", glyph: "✎" },
  running: { rank: 4, label: "Checks running", short: "CI …", glyph: "◌" },
  approved: { rank: 3, label: "Approved", short: "✓ LGTM", glyph: "✓" },
  waiting: { rank: 2, label: "Waiting for review", short: "WAITING", glyph: "…" },
  draft: { rank: 1, label: "Draft", short: "DRAFT", glyph: "◇" },
  merged: { rank: 0, label: "Merged", short: "MERGED", glyph: "🎉" },
};

const FIELDS = `id number title url isDraft createdAt updatedAt headRefName additions deletions mergeable reviewDecision
  author { login } repository { nameWithOwner } comments { totalCount }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  latestReviews(first: 10) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const QUERY = `query($mine: String!, $review: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { issueCount nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 30) { issueCount nodes { ...pr } }
}
fragment pr on PullRequest { ${FIELDS} }`.replace(/\s+/g, " ");

export function stateOf(p) {
  if (p.draft) return "draft";
  if (p.checks === "FAILURE" || p.checks === "ERROR") return "failing";
  if (p.mergeable === "CONFLICTING") return "conflict";
  if (p.decision === "CHANGES_REQUESTED") return "changes";
  if (p.checks === "PENDING" || p.checks === "EXPECTED") return "running";
  if (p.decision === "APPROVED") return "approved";
  return "waiting";
}

// One search result node to the small record we keep in shared state.
export function slim(n, kind) {
  if (!n || !n.id) return null;
  const p = {
    id: n.id,
    kind, // "mine" | "review"
    repo: n.repository?.nameWithOwner ?? "",
    number: n.number,
    title: n.title ?? "",
    url: n.url,
    branch: n.headRefName ?? null,
    author: n.author?.login ?? null,
    draft: Boolean(n.isDraft),
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    decision: n.reviewDecision ?? null,
    mergeable: n.mergeable ?? null,
    comments: n.comments?.totalCount ?? 0,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    approvals: (n.latestReviews?.nodes ?? []).filter((r) => r.state === "APPROVED").length,
    waitingOn: (n.reviewRequests?.nodes ?? []).map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean),
    createdAt: Date.parse(n.createdAt) || null,
    updatedAt: Date.parse(n.updatedAt) || null,
  };
  p.state = kind === "review" ? "review" : stateOf(p);
  return p;
}

export const byUrgency = (a, b) => (STATES[b.state]?.rank ?? 0) - (STATES[a.state]?.rank ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

// The GraphQL answer to { mine, review } lists. Your own PRs never show up as reviews.
export function parse(json, login) {
  const data = json?.data ?? {};
  const mine = (data.mine?.nodes ?? []).map((n) => slim(n, "mine")).filter(Boolean);
  const ids = new Set(mine.map((p) => p.id));
  const review = (data.review?.nodes ?? []).map((n) => slim(n, "review"))
    .filter((p) => p && !ids.has(p.id) && p.author !== login);
  return { mine: mine.sort(byUrgency), review: review.sort(byUrgency) };
}

// What changed since the last poll that's worth a toast. Nothing on the first poll, and
// nothing about PRs that just appeared in your own list (you opened them, you know).
export function changes(prev, next) {
  if (!prev || !prev.at) return [];
  const out = [];
  const before = new Map((prev.mine ?? []).map((p) => [p.id, p]));
  for (const p of next.mine) {
    const was = before.get(p.id);
    if (!was) continue;
    const red = (s) => s === "FAILURE" || s === "ERROR";
    if (red(p.checks) && !red(was.checks)) out.push({ kind: "failing", pr: p });
    else if (p.checks === "SUCCESS" && (was.checks === "PENDING" || was.checks === "EXPECTED" || red(was.checks))) out.push({ kind: "passed", pr: p });
    if (p.decision === "APPROVED" && was.decision !== "APPROVED") out.push({ kind: "approved", pr: p });
    if (p.decision === "CHANGES_REQUESTED" && was.decision !== "CHANGES_REQUESTED") out.push({ kind: "changes", pr: p });
    if (p.mergeable === "CONFLICTING" && was.mergeable !== "CONFLICTING") out.push({ kind: "conflict", pr: p });
  }
  const asked = new Set((prev.review ?? []).map((p) => p.id));
  for (const p of next.review) if (!asked.has(p.id)) out.push({ kind: "review", pr: p });
  return out;
}

// Your PRs that left the open list since the last poll: GitHub says whether they merged.
export const gone = (prev, next) => {
  const now = new Set(next.mine.map((p) => p.id));
  return (prev?.mine ?? []).filter((p) => !now.has(p.id));
};

export const MESSAGES = {
  failing: { level: "error", title: "Checks failed" },
  passed: { level: "success", title: "Checks passed" },
  approved: { level: "success", title: "Approved ✓" },
  changes: { level: "warning", title: "Changes requested" },
  conflict: { level: "warning", title: "Merge conflict" },
  review: { level: "info", title: "Review requested 👀" },
  merged: { level: "success", title: "Merged 🎉" },
};

export const ref = (p) => `${p.repo.split("/")[1] ?? p.repo}#${p.number}`;

// `token`: run as that account instead of gh's active one. Herdr's exec can't set GH_TOKEN,
// so it goes in as the Authorization header (gh keeps a header you set).
async function gh(args, host, token = null, timeout = 30000) {
  let full = host ? [...args, "--hostname", host] : [...args];
  if (token && full[0] === "api") full = ["api", "-H", `Authorization: token ${token}`, ...full.slice(1)];
  let r;
  try {
    r = await exec("gh", full, { timeout });
  } catch (e) {
    throw new Error("Couldn't run gh. Install the GitHub CLI (cli.github.com), then run gh auth login.");
  }
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || "").trim().split("\n").find((l) => l.trim()) ?? `gh exited ${r.code}`;
    throw new Error(/auth login|not logged|authentication|no oauth token|not found for|bad credentials/i.test(why) ? `gh isn't signed in (${why}). Run gh auth login in a terminal.` : why);
  }
  return r.stdout;
}

const graphql = async (query, vars, host, token) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  const json = JSON.parse(await gh(args, host, token));
  if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
  return json;
};

// One account's two lists. `user`: a gh account (gh auth status lists them); null: the active one.
async function fetchAccount(acct, prev, host, filter) {
  const token = acct.user ? (await gh(["auth", "token", "--user", acct.user], host)).trim() : null;
  const login = acct.user ?? (prev?.logins?.[""] && prev.host === host ? prev.logins[""] : (await gh(["api", "user", "--jq", ".login"], host)).trim());
  const terms = [filter, acct.filter].map((f) => (f ?? "").trim()).filter(Boolean).join(" ");
  const extra = terms ? ` ${terms}` : "";
  const json = await graphql(QUERY, {
    mine: `is:pr is:open archived:false author:${login} sort:updated-desc${extra}`,
    review: `is:pr is:open archived:false review-requested:${login} sort:updated-desc${extra}`,
  }, host, token);
  const lists = parse(json, login);
  for (const p of [...lists.mine, ...lists.review]) p.account = acct.label ?? null;
  return { login, token, ...lists };
}

// Polls GitHub once. `prev` is the last shared snapshot. `accounts`: [{ user, label, filter }],
// or empty for gh's active account. Returns the new snapshot and the events to announce.
// Throws (with a person-readable message) only when every account fails.
export async function fetchAll(prev, { host = null, filter = "", accounts = [] } = {}) {
  const list = accounts.length ? accounts : [{ user: null, label: null, filter: "" }];
  const results = await Promise.all(list.map((a) => fetchAccount(a, prev, host, filter).then((r) => ({ a, r }), (e) => ({ a, e }))));
  const ok = results.filter((x) => x.r);
  const errors = results.filter((x) => x.e).map(({ a, e }) => (a.label || a.user ? `${a.label || a.user}: ` : "") + String(e?.message ?? e));
  if (!ok.length) throw new Error(errors.join("\n"));

  // Merge the accounts: a PR shows once; your own PRs (any account) never show as reviews.
  const logins = new Set(ok.map((x) => x.r.login));
  const seen = new Set();
  const mine = [], review = [];
  for (const { r } of ok) for (const p of r.mine) if (!seen.has(p.id)) { seen.add(p.id); mine.push(p); }
  for (const { r } of ok) for (const p of r.review) if (!seen.has(p.id) && !logins.has(p.author)) { seen.add(p.id); review.push(p); }
  const now = Date.now();
  const next = {
    v: 1, at: now, host, error: errors.length ? errors.join("\n") : null,
    login: ok.map((x) => x.r.login).join(", "),
    logins: Object.fromEntries(ok.map(({ a, r }) => [a.user ?? "", r.login])),
    accounts: list.length > 1 ? list.map((a) => a.label || a.user) : [],
    mine: mine.sort(byUrgency), review: review.sort(byUrgency),
    merged: (prev?.merged ?? []).filter((m) => now - m.at < 7 * 86400000),
  };
  // An account that failed this round keeps its last lists, so nothing flickers away.
  for (const { a } of results.filter((x) => x.e)) {
    const label = a.label ?? null;
    for (const key of ["mine", "review"]) for (const p of prev?.[key] ?? []) if ((p.account ?? null) === label && !seen.has(p.id)) { seen.add(p.id); next[key].push(p); }
  }
  next.mine.sort(byUrgency);
  next.review.sort(byUrgency);
  const events = changes(prev, next);

  // Merged or just closed? Ask about the ones that left (ids are GitHub node ids), as the
  // account that saw them.
  const left = gone(prev, next).filter((p) => /^[A-Za-z0-9_=-]+$/.test(p.id)).slice(0, 20);
  for (const { a, r } of ok) {
    const mineLeft = left.filter((p) => (p.account ?? null) === (a.label ?? null));
    if (!mineLeft.length) continue;
    try {
      const ids = mineLeft.map((p) => `"${p.id}"`).join(",");
      const res = await graphql(`query { nodes(ids: [${ids}]) { ... on PullRequest { id merged } } }`, {}, host, r.token);
      const merged = new Set((res.data?.nodes ?? []).filter((n) => n?.merged).map((n) => n.id));
      for (const p of mineLeft) {
        if (!merged.has(p.id)) continue;
        next.merged = [{ id: p.id, repo: p.repo, number: p.number, title: p.title, url: p.url, branch: p.branch, account: p.account ?? null, at: now }, ...next.merged].slice(0, 20);
        events.push({ kind: "merged", pr: p });
      }
    } catch {}
  }
  return { next, events };
}

// The browser, by way of gh, which knows how to open one on every platform.
export function openInBrowser(url) {
  if (url) exec("gh", ["pr", "view", url, "--web"]).catch(() => null);
}
