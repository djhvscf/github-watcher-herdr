// Pull requests in the office, from what the office-prs mod publishes as shared("office.prs").
// A corkboard on the wall with an index card per pull request, a little flag on the monitor
// of any agent whose branch has one, two lines on the whiteboard, and a banner (and a
// finish toward the pizza) when one merges. Without office-prs installed, none of it shows.
import { div } from "gpui-kit";
import { shared, run, exec } from "herdr";

const KEY = "office.prs";
const INK = "#3b2a1a";
const STALE = 30 * 60 * 1000;
const BASES = new Set(["main", "master", "develop", "dev", "trunk", "staging", "production", "release"]);

// Index cards by what the pull request is waiting on, most urgent first.
const CARDS = {
  review: { rank: 8, paper: "#9cc8ff", label: "👀 YOU", mark: "👀" },
  failing: { rank: 7, paper: "#ff8a80", label: "CI ✗", mark: "✗", blink: true },
  conflict: { rank: 6, paper: "#d7a8ff", label: "CONFLICT", mark: "⚠", blink: true },
  changes: { rank: 5, paper: "#ffcc80", label: "CHANGES", mark: "✎" },
  running: { rank: 4, paper: "#fff59d", label: "CI", mark: "…", dots: true },
  approved: { rank: 3, paper: "#a5e6a8", label: "✓ LGTM", mark: "✓" },
  waiting: { rank: 2, paper: "#fffaf0", label: "WAITING", mark: "…" },
  draft: { rank: 1, paper: "#d9d4c8", label: "DRAFT", mark: "◇" },
};

export const data = () => {
  const d = shared(KEY);
  return d && typeof d === "object" ? d : null;
};

export const open = (url) => { if (url) exec("gh", ["pr", "view", url, "--web"]).catch(() => null); };
const openList = () => run("mod.open", { name: "office-prs" });
const short = (p) => `${p.repo.split("/")[1] ?? p.repo}#${p.number}`;

// Your open pull request for an agent's branch, if there is one.
export function forBranch(d, branch) {
  if (!d || !branch || BASES.has(branch)) return null;
  return (d.mine ?? []).find((p) => p.branch === branch) ?? null;
}

// The whiteboard's PR lines, in its [color, text, show] form.
export function whiteboardRows(d) {
  if (!d) return [];
  const mine = d.mine?.length ?? 0, review = d.review?.length ?? 0;
  const red = (d.mine ?? []).filter((p) => p.state === "failing").length;
  return [
    ["#2b6cb0", `PRs      ${mine}${red ? `  (${red}✗)` : ""}`, mine > 0],
    ["#c07a1a", `REVIEW ME ${review}`, review > 0],
  ];
}

// Merges newer than `since`, oldest first.
export const mergesSince = (d, since) => (d?.merged ?? []).filter((m) => m.at > since).sort((a, b) => a.at - b.at);

function card(p, w, h) {
  const c = CARDS[p.state] ?? CARDS.waiting;
  const label = div().text_size(7).font_bold().text_color(INK).truncate();
  return div().id(`prcard-${p.id}`).relative().w(w).h(h).flex_none().bg(c.paper).border_1().border_color("#00000033")
    .flex().flex_col().items_center().justify_center().cursor_pointer().overflow_hidden()
    .tooltip(`${p.account ? `${p.account} · ` : ""}${p.repo}#${p.number} · ${p.title}`)
    .on_click((_e, cx) => { cx.stop_propagation(); open(p.url); })
    .when(Boolean(c.blink), (el) => el.loop("opacity", { from: 0.55, to: 1, period: 800 }))
    .child(div().absolute().top(1).left(w / 2 - 2).size(4).rounded_full().bg("#d94a3a"))
    .child(div().text_size(h < 24 ? 8 : 9).font_bold().text_color(INK).child(`#${p.number}`))
    .when(h >= 24, (el) => el.child(c.dots ? label.frames(["CI ·", "CI ··", "CI ···"], 500) : label.child(c.label)));
}

// The corkboard: up to six cards, two rows when the wall has room. Click a card to open the
// pull request; click the header for the whole list.
export function board(x, y, h, d, now) {
  const W = 164, inner = W - 14;
  const all = [...(d.review ?? []), ...(d.mine ?? [])]
    .sort((a, b) => (CARDS[b.state]?.rank ?? 0) - (CARDS[a.state]?.rank ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const bh = Math.min(h, 100);
  const rows = bh >= 76 ? 2 : 1;
  const cols = 3;
  const cw = Math.floor((inner - (cols - 1) * 4) / cols);
  const ch = Math.max(16, Math.floor((bh - 26 - (rows - 1) * 4) / rows));
  const shown = all.slice(0, rows * cols);
  const more = all.length - shown.length;
  const stale = now - (d.at ?? 0) > STALE;

  let content;
  if (d.error && !all.length) content = div().id("prboard-error").w(inner).h(ch).p(3).bg("#fffaf0").border_1().border_color("#00000033")
    .text_size(8).text_color("#c0392b").font_bold().tooltip(d.error).child(div().truncate().child("gh needs a hand: hover me"));
  else if (!all.length) content = div().w(inner).h(ch).bg("#fffaf0").border_1().border_color("#00000033")
    .flex().items_center().justify_center().text_size(9).font_bold().text_color(INK).child("INBOX ZERO ✨");
  else content = div().flex().flex_wrap().gap(4).w(inner).children(shown.map((p) => card(p, cw, ch)));

  return div().id("prboard").absolute().left(x).top(y).w(W).h(bh).p(4).bg("#c8955c").border_3().border_color("#7a5c3e")
    .flex().flex_col().gap(3)
    .when(stale, (el) => el.opacity(0.75))
    .child(div().id("prboard-head").flex().items_center().gap(4).h(13).px(3).bg("#fbf8f1").cursor_pointer()
      .tooltip(d.error ? `GitHub: ${d.error}` : stale ? "Last checked a while ago. Click to open the list." : "All your pull requests")
      .on_click(() => openList())
      .child(div().text_size(8).font_bold().text_color(INK).child("PULL REQUESTS"))
      .child(div().flex_1())
      .when(more > 0, (el) => el.child(div().text_size(8).font_bold().text_color("#7a5c3e").child(`+${more}`)))
      .when(Boolean(d.error) && all.length > 0, (el) => el.child(div().size(6).rounded_full().bg("#e05252"))))
    .child(content);
}

// A flag on the monitor of an agent whose branch has an open pull request.
export function deskTag(p, P) {
  const c = CARDS[p.state] ?? CARDS.waiting;
  return div().id(`prtag-${p.id}`).absolute().left(29 * P).top(2 * P).h(Math.max(12, 4 * P)).px(3).rounded(2)
    .bg(c.paper).border_1().border_color("#00000044").flex().items_center().gap(2).cursor_pointer()
    .text_size(8).font_bold().text_color(INK)
    .tooltip(`${short(p)} · ${p.title}`)
    .on_click((_e, cx) => { cx.stop_propagation(); open(p.url); })
    .when(Boolean(c.blink), (el) => el.loop("opacity", { from: 0.55, to: 1, period: 800 }))
    .child(`PR #${p.number}`)
    .child(c.dots ? div().frames(["·", "··", "···"], 500) : div().child(c.mark));
}

export const mergeBanner = (W, y, m, banner) => banner(W, y, `🎉 MERGED  ${short(m)}`, "#2f9a50");
