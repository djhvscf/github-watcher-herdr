// Your settings for the PR watcher. install.ps1 never overwrites this file once it exists.
// Saving it reloads the mod.
export const POLL_EVERY = 2 * 60 * 1000; // how often to ask GitHub
export const NOTIFY = true; // toasts for: checks failed/passed, approved, changes, conflict, review asked, merged
export const HOST = null; // GitHub Enterprise: "github.mycompany.com". null: github.com
export const FILTER = ""; // extra search terms for both lists, e.g. "org:my-org" or "-repo:me/dotfiles"
// Several GitHub accounts at once (all signed in to gh: `gh auth login` adds one, `gh auth status`
// lists them). Empty: just gh's active account. `filter` narrows that account's lists.
//   { user: "my-personal-login", label: "PAP", filter: "org:my-pap-org" },
//   { user: "my-work-login", label: "Iron", filter: "" },
export const ACCOUNTS = [];
export const FIX_WITH = ["claude"]; // the agent the robot hands your own PRs to
export const REVIEW_WITH = ["codex"]; // the agent the robot hands review requests to
