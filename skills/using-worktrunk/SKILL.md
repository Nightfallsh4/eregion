---
name: using-worktrunk
description: Use when creating, entering, inspecting, merging, or removing Git worktrees, or when a task needs an isolated workspace and Worktrunk (`wt`) is available.
---

# Using Worktrunk

Worktrunk is the required native worktree tool. When `wt` is available, this fulfils the native-tool step of `superpowers:using-git-worktrees`; do not use raw `git worktree` commands instead.

## Preflight

```bash
command -v wt
wt --version
wt list --format=json
```

If `wt` is unavailable, say so before using the `git worktree` fallback. Do not install Worktrunk, run `wt config shell install`, install a Pi plugin, or change Worktrunk configuration unless the user explicitly requests it.

## Create, enter, and inspect

| Need | Command |
| --- | --- |
| Create a feature workspace | `wt switch --create <branch> --format=json` |
| Create from an explicitly requested base | `wt switch --create <branch> --base=<base> --format=json` |
| Enter or materialise an existing branch | `wt switch <branch> --format=json` |
| Inspect all worktrees | `wt list --format=json` |
| Include CI and PR state | `wt list --full --format=json` |

Read `wt list --format=json` first. If the current worktree already isolates the task, reuse it; do not nest or create another worktree merely from habit.

`wt switch` changes an interactive parent shell only when Worktrunk shell integration is active. A one-shot agent shell does **not** retain that directory. Read the returned JSON `path`, then run subsequent commands from that path (for example, `cd -- "<path>" && <command>`) or use absolute file paths. To start a separate agent CLI inside a selected worktree, use `wt switch ... -x <agent-command> -- <agent-arguments>`.

## Lifecycle safety

Use ordinary Git commands inside the selected worktree for source control work. Use Worktrunk for the worktree lifecycle.

- Run `wt merge [<target>]` only when the user explicitly asks to merge. It may commit, squash, rebase, update the target, and remove the worktree.
- Run `wt remove [<branch>]` only when the user explicitly asks to remove that worktree.
- Ask again before adding `--force`/`-f`, `--force-delete`/`-D`, or `--reap`; each can discard work, delete unmerged branches, or terminate processes.
- Do not treat “the task is complete” as consent to merge or clean up.

## Never substitute raw Git while Worktrunk works

| Temptation | Required response |
| --- | --- |
| “`git worktree add` is quicker.” | Use `wt switch --create`; it applies the configured path, hooks, and lifecycle. |
| “The branch exists, so use `git worktree add`.” | Use `wt switch <branch>`; it creates the branch’s configured worktree if needed. |
| “Delete it now; it is probably merged.” | Inspect with `wt list`, then obtain explicit removal approval. |
| “Force it; the agent is in a hurry.” | Stop and obtain explicit approval for the exact force flag. |
