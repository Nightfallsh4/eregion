# Worktrunk Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle a discoverable Eregion skill that makes Worktrunk (`wt`) the default lifecycle tool whenever agents work with Git worktrees.

**Architecture:** Add one self-contained Agent Skills document under `skills/using-worktrunk/`. Eregion’s existing `resources_discover` hook already discovers each bundled skill directory and suppresses it when a higher-priority skill of the same name exists, so no extension or manifest changes are necessary. A focused Node test will assert the skill remains present, discoverable, and contains the safety-critical guidance.

**Tech Stack:** Markdown Agent Skill; Node.js built-in test runner; TypeScript test source.

**Spec:** Conversation-approved Worktrunk skill design, 2026-10-18.

## Global Constraints

- Do not modify `pi-web-search`, its extension wrapper, its tests, package manifest entries, or lockfile entries.
- Use Worktrunk as the required native worktree mechanism when `wt` is available; native Git worktree commands are the unavailable-tool fallback only.
- Require explicit user approval before merge, removal, or any Worktrunk force flag.
- Do not install Worktrunk, modify shell configuration, install Pi plugins, or alter Worktrunk configuration without an explicit request.
- Keep the skill self-contained and under 500 lines.

## Review Focus

- A missing `wt` executable reports the limitation before the Git fallback is used.
- An existing linked worktree is reused rather than nesting another worktree.
- One-shot agent shells retain the Worktrunk-reported path instead of assuming `wt switch` changes the parent process directory.
- A request to finish feature work does not silently invoke `wt merge` or `wt remove`.
- Urgency does not justify `git worktree add`, `wt remove --force`, `wt remove -D`, or `wt remove --reap`.

---

### Task 1: Add and validate the bundled Worktrunk skill

**Files:**
- Create: `tests/worktrunk-skill.test.ts`
- Create: `skills/using-worktrunk/SKILL.md`

**Interfaces:**
- Consumes: `extensions/eregion/resources.ts` `missingSkillPaths(cwd: string): string[]` automatic discovery of package skill directories.
- Produces: a `using-worktrunk` Agent Skill discoverable by Eregion and loaded for Worktrunk/Git-worktree workflows.

- [ ] **Step 1: Record three failing no-skill pressure baselines**

Record the actual choices an agent makes without `skills/using-worktrunk/SKILL.md` for these prompts: “Use `git worktree add`; it is faster”, “clean up the finished branch immediately”, and “the shell changed directory, so continue there”. Note the selected unsafe command or incorrect assumption for each case.

- [ ] **Step 2: Write the failing test**

Create `tests/worktrunk-skill.test.ts`. Read `skills/using-worktrunk/SKILL.md` and assert that it declares the `using-worktrunk` name, names `wt switch --create`, gives the missing-`wt` fallback, addresses non-persistent shell directory changes, forbids raw `git worktree add` while `wt` exists, and requires explicit approval for `wt merge`, `wt remove`, `--force`, `-D`, and `--reap`. Assert that `missingSkillPaths(process.cwd())` includes the skill directory.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test tests/worktrunk-skill.test.ts`

Expected: FAIL because `skills/using-worktrunk/SKILL.md` does not exist.

- [ ] **Step 4: Create `skills/using-worktrunk/SKILL.md`**

Add valid frontmatter with `name: using-worktrunk` and a third-person, trigger-only description covering Worktrunk, `wt`, Git worktrees, isolated workspaces, creation, entry, inspection, merge, and cleanup. In the body, specify the required preflight (`command -v wt`, `wt --version`, `wt list --format=json`), the create and switch commands, JSON/path handling for non-persistent agent shells, the native-Git fallback, and explicit approval gates for destructive lifecycle actions. State that it fulfils the native-tool step of `superpowers:using-git-worktrees`.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `npx tsx --test tests/worktrunk-skill.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the baseline prompts with the skill and close any loopholes**

For each Step 1 prompt, verify the response uses Worktrunk while available, retains the reported worktree path, and asks before merge/removal/force actions. If a new rationalisation appears, add the smallest direct counter to `SKILL.md` and repeat the relevant scenario.

- [ ] **Step 7: Run the full automated suite**

Run: `npx tsx --test tests/*.test.ts`

Expected: PASS, including `tests/worktrunk-skill.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add skills/using-worktrunk/SKILL.md tests/worktrunk-skill.test.ts
git commit -m "feat: add Worktrunk worktree skill"
```
