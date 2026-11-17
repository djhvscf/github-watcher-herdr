// Your open pull requests on GitHub, kept an eye on. In the sidebar it lists them, most
// urgent first: reviews people asked of you, then yours with failing checks, conflicts,
// requested changes, running checks, approvals, ones still waiting, and drafts. It polls
// through `gh` every couple of minutes, toasts when something changes, and publishes what
// it found as shared("office.prs") so the office can pin them to its corkboard.
// Click a pull request to open it in the browser; the robot hands it to an agent.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, notify, run, theme, props, closeOverlay, panes, spaces } from "herdr";
import * as G from "./github.js";
import { POLL_EVERY, NOTIFY, HOST, FILTER, ACCOUNTS, FIX_WITH, REVIEW_WITH } from "./settings.js";

const RAIL = 160; // narrower than this (a folded sidebar): just a count

const color = (t, state) => ({
  review: t.accent, failing: t.blocked, conflict: t.ansi5, changes: t.ansi3,
  running: t.working, approved: t.done, waiting: t.dim, draft: t.dim, merged: t.done,
}[state] ?? t.dim);

function ago(ms, now) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// What the agent is asked to do, by what the pull request is waiting on.
function taskFor(p) {
  const it = `${p.url} (${p.repo}#${p.number}, "${p.title}")`;
  const tree = `Use a new git worktree for the PR's branch${p.branch ? ` (${p.branch})` : ""}, not my current checkout.`;
  const ask = "Show me what you changed before you push anything.";
  switch (p.state) {
    case "review": return `Review the pull request ${it}. Read it with gh pr view, gh pr diff and gh pr checks. If you need to run the code, ${tree.charAt(0).toLowerCase()}${tree.slice(1)} Tell me what you find here; don't comment, approve or request changes on GitHub unless I ask.`;
    case "failing": return `Checks are failing on my pull request ${it}. Find out why with gh pr checks and gh run view --log-failed. ${tree} Fix it and run the tests. ${ask}`;
    case "conflict": return `My pull request ${it} conflicts with its base branch. ${tree} Bring it up to date with the base, resolve the conflicts and run the tests. ${ask}`;
    case "changes": return `Reviewers asked for changes on my pull request ${it}. Read the reviews with gh pr view --comments (and gh api for inline review comments). ${tree} Address them. ${ask}`;
    default: return `Check on my pull request ${it}: its checks, reviews and comments (gh pr view --comments, gh pr checks). Tell me what's left before it can merge.`;
  }
}

// The space whose terminals sit in this repo, and the repo's folder there.
function homeOf(p) {
  const name = (p.repo.split("/")[1] ?? "").toLowerCase();
  if (!name) return null;
  for (const pane of panes()) {
    if (!pane.cwd) continue;
    const sep = pane.cwd.includes("\\") ? "\\" : "/";
    const parts = pane.cwd.split(/[\\/]+/);
    const at = parts.map((s) => s.toLowerCase()).lastIndexOf(name);
    if (at < 0) continue;
    const space = spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
    if (space) return { space: space.id, folder: parts.slice(0, at + 1).join(sep) || sep };
  }
  return null;
}

function handOff(p) {
  const home = homeOf(p);
  const args = { name: `PR #${p.number}`, argv: p.kind === "review" ? REVIEW_WITH : FIX_WITH, task: taskFor(p) };
  if (home) Object.assign(args, home);
  else notify({ title: `No space for ${p.repo.split("/")[1]}`, body: "Started it in the space you're in.", level: "info", timeout: 5000 });
  run("tab.new", args);
}

export default class PullRequests extends View {
  init(_props, cx) {
    this.me = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.width = 268;
    this.loading = false;
    this.hovered = null;
    this.folded = new Set();
    cx.timer.every(30000, (cx) => { this.poll(cx, false); cx.notify(); });
    // A dialog opened on purpose refreshes unless what's shown is under a minute old.
    this.poll(cx, props()?.overlay ? 60000 : false);
  }

  // Polls when the snapshot is older than POLL_EVERY (or `fresh` ms, when given), unless
  // another copy is at it. Only the copy that polls posts the toasts.
  poll(cx, fresh) {
    const d = shared(G.KEY);
    const age = Date.now() - (d?.at ?? 0);
    if (age < (fresh || POLL_EVERY) || this.loading) return;
    const lease = shared(G.LEASE);
    if (lease && lease.by !== this.me && lease.until > Date.now()) return;
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    setShared(G.LEASE, { by: this.me, until: Date.now() + 90000 });
    cx.notify();
    cx.spawn(async (cx) => {
      const prev = shared(G.KEY);
      try {
        const { next, events } = await G.fetchAll(prev, { host: HOST, filter: FILTER, accounts: ACCOUNTS });
        setShared(G.KEY, next);
        if (NOTIFY) this.announce(events);
      } catch (e) {
        // Keep the last good lists; say what's wrong. Try again on the next round.
        setShared(G.KEY, { mine: [], review: [], merged: [], ...(prev ?? {}), v: 1, at: Date.now(), error: String(e?.message ?? e) });
      }
      setShared(G.LEASE, null);
      this.loading = false;
      cx.notify();
    });
  }

  announce(events) {
    const list = events.slice(0, 4);
    for (const { kind, pr } of list) {
      const m = G.MESSAGES[kind];
      notify({ title: `${m.title} · ${G.ref(pr)}`, body: pr.title, level: m.level, action: { name: "mod.open", args: { name: "office-prs" } } });
    }
    if (events.length > list.length)
      notify({ title: `${events.length - list.length} more pull request updates`, level: "info", action: { name: "mod.open", args: { name: "office-prs" } } });
  }

  badge(t, p, size = 20) {
    const c = color(t, p.state);
    const s = G.STATES[p.state];
    return div().size(size).flex_none().rounded(6).bg(c + "26").text_color(c).text_size(size * 0.55).font_bold()
      .flex().items_center().justify_center()
      .map((el) => (p.state === "running" ? el.frames(["◐", "◓", "◑", "◒"], 260) : el.child(s.glyph)));
  }

  row(t, p, now, wide) {
    const c = color(t, p.state);
    const s = G.STATES[p.state];
    const hovered = this.hovered === p.id;
    const meta = [
      s.label,
      p.kind === "mine" && p.approvals && p.state !== "approved" ? `✓ ${p.approvals}` : null,
      p.kind === "review" && p.author ? `by ${p.author}` : null,
      p.comments ? `💬 ${p.comments}` : null,
      wide ? `+${p.additions} −${p.deletions}` : null,
    ].filter(Boolean).join(" · ");
    return h_flex().id(`pr-${p.id}`).flex_none().px(8).py(6).gap(8).items_start().rounded(7).cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(`${p.account ? `${p.account} · ` : ""}${p.repo}#${p.number}\n${p.title}${p.branch ? `\n${p.branch}` : ""}`)
      .on_hover((h, cx) => {
        if (h) this.hovered = p.id;
        else if (this.hovered === p.id) this.hovered = null;
        cx.notify();
      })
      .on_click(() => G.openInBrowser(p.url))
      .child(div().pt(2).child(this.badge(t, p)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(4).items_center().text_size(11).text_color(t.dim)
          .when(Boolean(p.account), (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).text_color(t.foreground).child(p.account)))
          .child(div().truncate().child(wide ? `${p.repo}#${p.number}` : G.ref(p)))
          .child(div().flex_1())
          .child(div().flex_none().child(ago(p.updatedAt, now))))
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(p.title))
        .child(div().truncate().text_size(11).text_color(c).child(meta)))
      .when(hovered && p.kind !== "merged", (el) => el.child(
        div().id(`pr-agent-${p.id}`).flex_none().size(22).rounded(6).text_size(13).flex().items_center().justify_center()
          .bg(t.raised).hover((s) => s.bg(t.selected))
          .tooltip(p.kind === "review" ? `Review with ${REVIEW_WITH[0]}` : `Hand to ${FIX_WITH[0]}`)
          .on_click((_e, cx) => { cx.stop_propagation(); handOff(p); })
          .child("🤖")));
  }

  section(t, id, label, list, now, wide) {
    if (!list.length) return [];
    const open = !this.folded.has(id);
    const head = h_flex().id(`sec-${id}`).flex_none().px(8).pt(10).pb(4).gap(6).items_center().cursor_pointer()
      .text_size(11).font_medium().text_color(t.dim).hover((el) => el.text_color(t.foreground))
      .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
      .child(div().child(label))
      .child(div().child(String(list.length)))
      .child(div().flex_1())
      .child(div().text_size(10).child(open ? "▾" : "▸"));
    return [head, ...(open ? list.map((p) => this.row(t, p, now, wide)) : [])];
  }

  // A folded sidebar: one tile with the count, colored by the most urgent.
  rail(t, d, all) {
    const top = all[0];
    const c = top ? color(t, top.state) : t.dim;
    return v_flex().id("prs").size_full().items_center().pt(8).gap(4).bg(t.chrome).border_t(1).border_color(t.border)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(div().id("prs-rail").size(28).rounded(7).bg(c + "26").text_color(c).text_size(12).font_bold()
        .flex().items_center().justify_center().cursor_pointer().hover((el) => el.bg(t.hover))
        .tooltip(d?.error ?? `${all.length} open pull requests`)
        .on_click(() => run("mod.open", { name: "office-prs" }))
        .child(d?.error ? "!" : String(all.length)));
  }

  render(cx) {
    const t = theme();
    const d = shared(G.KEY);
    const overlay = props()?.overlay;
    const all = [...(d?.review ?? []), ...(d?.mine ?? [])];
    if (!overlay && this.width < RAIL) return this.rail(t, d, all);
    const now = Date.now();
    const wide = Boolean(overlay) || this.width > 420;
    const reviews = d?.review ?? [];
    const mine = d?.mine ?? [];
    const merged = (d?.merged ?? []).filter((m) => now - m.at < 86400000);

    const header = h_flex().flex_none().px(16).h(41).pt(14).pb(5).gap(6).items_center()
      .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Pull requests"))
      .when(all.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(all.length))))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(this.loading ? "checking…" : d?.at ? ago(d.at, now) : ""))
      .child(div().id("prs-refresh").text_size(13).text_color(t.dim).cursor_pointer().hover((el) => el.text_color(t.foreground))
        .tooltip("Check GitHub now").on_click((_e, cx) => this.refresh(cx))
        .child("↻").when(this.loading, (el) => el.loop("opacity", { from: 0.3, to: 1, period: 600 })))
      .when(Boolean(overlay), (el) => el.child(div().id("prs-close").text_size(13).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click(() => closeOverlay(overlay)).child("✕")));

    let body;
    if (!d) body = [div().px(16).text_size(12).text_color(t.dim).child(this.loading ? "Asking GitHub…" : "Nothing yet.")];
    else body = [
      ...(d.error ? [div().mx(8).mb(6).p(8).rounded(7).bg(t.blocked + "1f").text_size(11.5).text_color(t.blocked).child(d.error)] : []),
      ...this.section(t, "review", "Needs your review", reviews, now, wide),
      ...this.section(t, "mine", "Yours", mine, now, wide),
      ...(merged.length ? this.section(t, "merged", "Merged today",
        merged.map((m) => ({ ...m, id: `m-${m.id}`, kind: "merged", state: "merged", updatedAt: m.at, comments: 0, approvals: 0 })), now, wide)
        .map((el, i) => (i === 0 ? el : el.opacity(0.7))) : []),
      ...(!d.error && !all.length ? [div().px(16).pt(6).text_size(12).text_color(t.dim)
        .child(`No open pull requests${d.login ? ` for ${d.login}` : ""}. Inbox zero ✨`)] : []),
    ];

    return v_flex().id("prs").size_full().min_h(0).text_size(13)
      .bg(overlay ? t.popover : t.chrome).when(!overlay, (el) => el.border_t(1).border_color(t.border))
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(header)
      .child(v_flex().id("prs-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(body));
  }
}
