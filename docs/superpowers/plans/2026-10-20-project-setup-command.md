# Project Setup Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a framework-agnostic `/project-setup` command that starts a visible setup turn which discovers project intent, asks for unresolved technical choices, scaffolds the chosen stack, and always prepares Git plus a valid PBT/DPBT/`b` quality profile.

**Architecture:** Keep extension mechanics deterministic and stack-neutral in a new `project-setup.ts` helper: safely collect bounded root-level project-context excerpts and render the setup task. The existing One For All entrypoint owns command registration and sends that task as an in-session user message, allowing the agent to use the installed brainstorming skill and clarify extension to choose the actual ecosystem at runtime.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, Pi extension APIs, existing `.pi/quality.json` contract.

**Spec:** `docs/superpowers/specs/2026-10-20-project-setup-command-design.md`

## Global Constraints

- `/project-setup [description]` must make no language, framework, package-manager, or library choice itself.
- A missing description must inspect bounded, root-level project text; prioritise `AGENTS.md` and `CLAUDE.md` case-insensitively.
- The generated setup task must require use of the available `brainstorming` skill and `clarify` tool for unresolved material stack decisions.
- A successful setup must initialise Git when absent and create valid `.pi/quality.json` with non-empty `commands` and `required` entries for PBT, DPBT, and `/b`.
- The setup turn runs visibly in the current Pi session, not through a background/subagent session.
- Never depend on globally installed framework or quality tools, weaken genuine findings, commit, publish, or configure credentials implicitly.

## Review Focus

- A binary, dependency, Git, or build-output file must never become prompt context; tests pin allow-list/exclusion and binary detection in Task 1.
- A very large root document must not overflow the agent prompt; Task 1 tests bounded excerpts and total-document limits.
- Case variations of `agents.md`/`claude.md` must receive priority over generic text; Task 1 tests ordering.
- An empty directory with no description must still make the setup agent ask through brainstorming/clarify rather than invent a framework; Task 2 tests mandatory task language.
- Invalid command flags must not start a setup turn; Task 3 tests the handler warning and absence of sent messages.

---

### Task 1: Safe project-context discovery and setup task renderer

**Files:**
- Create: `extensions/eregion/one-for-all/project-setup.ts`
- Create: `tests/project-setup.test.ts`

**Interfaces:**
- Produces: `ProjectContextExcerpt { path: string; content: string }`.
- Produces: `findProjectSetupContext(cwd: string): ProjectContextExcerpt[]`.
- Produces: `buildProjectSetupTask(description: string, context: ProjectContextExcerpt[]): string`.
- Consumes: the existing `QUALITY_CONFIG_PATH` exported by `quality.ts`.

- [ ] **Step 1: Write failing discovery and task-contract tests**

Create temporary root fixtures containing case-varied `AGENTS.md`, `claude.MD`, ordinary Markdown/text files, a binary file, an oversized text file, and excluded directories. Assert priority/order, bounded text-only excerpts, and that no-prompt task text requires brainstorming, `clarify`, Git initialisation, stack-specific local dependencies/configuration, required quality commands, and `.pi/quality.json`; assert prompt-bearing task includes the description without selecting a framework.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test tests/project-setup.test.ts`

Expected: FAIL because `project-setup.ts` does not exist.

- [ ] **Step 3: Implement bounded root-document discovery and `buildProjectSetupTask` in `extensions/eregion/one-for-all/project-setup.ts`**

Use synchronous Node filesystem primitives consistent with `quality.ts`. Inspect only root regular files; accept text-like project documents, sort special files before ordinary files, cap each excerpt and total output, and exclude binaries/oversized/unreadable files. Render distinct no-description instructions to inspect the supplied context and use brainstorming plus clarify for unresolved stack decisions, then render the common Git, scaffold, local dependency, quality-config, command-run, and failure-reporting constraints.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx --test tests/project-setup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/eregion/one-for-all/project-setup.ts tests/project-setup.test.ts
git commit -m "feat: define framework-agnostic setup task"
```

### Task 2: Register the visible `/project-setup` command

**Files:**
- Modify: `extensions/eregion/one-for-all/index.ts`
- Modify: `tests/workflow-ui.test.ts`

**Interfaces:**
- Consumes: `findProjectSetupContext(ctx.cwd)` and `buildProjectSetupTask(description, context)` from `project-setup.ts`.
- Produces: a `/project-setup [description]` command that calls `pi.sendUserMessage()` exactly once for valid input.

- [ ] **Step 1: Write failing command-wiring tests**

Extend the existing extension API fixture with `/project-setup` assertions: an empty-directory invocation sends one visible current-session task; an invocation with text forwards its description; a `--`-prefixed input warns with usage and sends no task. Assert the sent task contains the mandatory Git and `.pi/quality.json` requirements rather than a framework-specific command.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: FAIL because `project-setup` is not registered.

- [ ] **Step 3: Import the project-setup helpers and register `/project-setup` in `extensions/eregion/one-for-all/index.ts`**

Reject an initial `--` argument with a concise usage notification. Otherwise treat the trimmed argument as an optional description, discover context from `ctx.cwd`, and send the rendered task through `pi.sendUserMessage()` so the work stays visible and interruptible in the active session.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/eregion/one-for-all/index.ts tests/workflow-ui.test.ts
git commit -m "feat: add project setup command"
```

### Task 3: Document the command and execute regression checks

**Files:**
- Modify: `README.md`
- Modify: `extensions/eregion/one-for-all/docs.md`

**Interfaces:**
- Consumes: the `/project-setup [description]` command contract from Task 2.
- Produces: user-facing instructions that document prompted/no-prompt behaviour, context discovery, framework agnosticism, interactive clarification, and mandatory Git/quality setup.

- [ ] **Step 1: Write failing documentation assertions**

Add focused assertions in `tests/project-setup.test.ts` that README and One For All documentation name `/project-setup`, its optional description, brainstorming/clarify flow when omitted, and mandatory `.pi/quality.json` setup.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test tests/project-setup.test.ts`

Expected: FAIL because user documentation does not yet describe the command.

- [ ] **Step 3: Document project setup in `README.md` and `extensions/eregion/one-for-all/docs.md`**

Add concise usage examples for both forms. Explain that the command is framework-agnostic, reads eligible root project briefs when no description is supplied, asks only material unresolved stack questions in the current session, then initializes Git and creates framework-appropriate local tooling plus the required workflow quality profile.

- [ ] **Step 4: Run focused and full regression tests**

Run: `npx tsx --test tests/project-setup.test.ts tests/workflow-ui.test.ts tests/lint-setup.test.ts && npx tsx --test tests/*.test.ts`

Expected: PASS with no test failures.

- [ ] **Step 5: Inspect the final diff and commit**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only project-setup implementation, tests, and documentation changes.

```bash
git add README.md extensions/eregion/one-for-all/docs.md tests/project-setup.test.ts
git commit -m "docs: explain project setup workflow"
```
