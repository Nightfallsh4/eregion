# Orchestrator-Owned Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lint-only workflow gate with an orchestrator-run, project-defined required quality profile.

**Architecture:** `quality.ts` will validate and execute `.pi/quality.json`, returning a captured result for each named command. PBT/DPBT and just-build will load that profile before dispatching agents and run every required command at their existing gates; state, the widget, and reports will persist and show these direct runs. Tester handoff validation will reject a claimed pass containing any non-zero test run.

**Tech Stack:** TypeScript ESM, Node.js child processes, Node built-in test runner, Pi extension APIs.

**Spec:** `docs/superpowers/specs/2026-05-22-orchestrator-quality-gates-design.md`

## Global Constraints

- Do not use worktrees; implement in the current workspace by user instruction.
- `.pi/quality.json` is mandatory before a workflow starts; errors must instruct the operator to run `/pbt-lint-setup`.
- Every `required` entry must name a configured command; required commands are executed by the orchestrator, not trusted from a handoff.
- Preserve bounded output capture, timeouts, abort behaviour, persistent-agent repair routing, and existing command name `/pbt-lint-setup`.
- A passing Tester verification handoff must contain only exit-code-zero `testRuns` and complete tester-plan clearance.

## Review Focus

- Missing, malformed, or legacy lint-only configuration must fail before any child agent starts and name `/pbt-lint-setup`.
- A required name absent from `commands`, duplicate required name, empty command, or empty required list must reject the profile rather than silently skipping a gate.
- Optional configured commands must not be executed merely because they appear in `commands`.
- A pass handoff containing a failed test run must be rejected even when clearance is complete.
- A required command failure must preserve the command name and captured stdout/stderr in state/report diagnostics and block completion.

---

### Task 1: Define and validate the quality profile

**Files:**
- Create: `extensions/eregion/one-for-all/quality.ts`
- Modify: `tests/lint-setup.test.ts`
- Modify: `extensions/eregion/one-for-all/index.ts:42,353-369`
- Modify: `extensions/eregion/one-for-all/types.ts:59-67,224-227`

**Interfaces:**
- Produces: `QUALITY_CONFIG_PATH`, `QualityConfig`, `readQualityConfig(cwd)`, `runQualityCommand(cwd, name, command, signal)`, `renderQualityFailure(run)`, and `buildQualitySetupTask(force)`.
- Produces: `QualityRun`, containing the profile command `name`, command details, gate stage, attempt, iteration, and captured output.
- Consumes: existing bounded shell execution semantics from `lint.ts`, moved without weakening timeout/abort/output capture behaviour.

- [ ] **Step 1: Write failing unit tests for setup guidance and profile validation**

Extend `tests/lint-setup.test.ts` to assert that setup guidance names `.pi/quality.json`, shows `commands` plus `required`, and directs profile configuration. Add temporary-directory tests for a valid profile, missing profile, required name missing from `commands`, duplicate required names, and empty required list.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx tsx --test tests/lint-setup.test.ts`

Expected: FAIL because quality-profile exports and guidance do not yet exist.

- [ ] **Step 3: Implement `quality.ts` and update setup command wiring/types**

Move the existing shell runner into `quality.ts`, generalize its result with the command name, and validate the exact profile schema from the spec. Update `/pbt-lint-setup` to guard and describe `.pi/quality.json` while retaining the command name. Replace lint-specific state types with profile/quality-run data.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npx tsx --test tests/lint-setup.test.ts`

Expected: PASS.

### Task 2: Harden Tester verification handoff consistency

**Files:**
- Modify: `tests/plan-role-isolation.test.ts:24-28`
- Modify: `extensions/eregion/one-for-all/handoffs.ts:341-358`

**Interfaces:**
- Consumes: `PhaseHandoff.testRuns`.
- Produces: `validateVerificationHandoff(handoff)` rejection for a passing handoff with a non-zero test run.

- [ ] **Step 1: Write a failing handoff validation assertion**

Add a pass-status verification handoff with valid tester-plan clearance but one `testRuns` entry with `exitCode: 1`; assert it throws with an exit-code/success diagnostic.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx tsx --test tests/plan-role-isolation.test.ts`

Expected: FAIL because the current validator accepts the inconsistent pass handoff.

- [ ] **Step 3: Reject non-successful runs in pass handoffs**

In `validateVerificationHandoff`, after confirming test runs exist, reject `status=pass` when any captured test run has a non-zero exit code.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx tsx --test tests/plan-role-isolation.test.ts`

Expected: PASS.

### Task 3: Execute required profile commands in both orchestrators

**Files:**
- Modify: `extensions/eregion/one-for-all/orchestrator.ts`
- Modify: `extensions/eregion/one-for-all/build-orchestrator.ts`
- Modify: `extensions/eregion/one-for-all/prompts.ts`
- Modify: `tests/workflow-ui.test.ts`

**Interfaces:**
- Consumes: `readQualityConfig(cwd)` and each `QualityConfig.required` name.
- Produces: one persisted `QualityRun` per required command at each gate, with `stage` and `attempt` supplied by the orchestrator.
- Consumes: `renderQualityFailure(run)` for persistent Builder/Tester repair prompts.

- [ ] **Step 1: Write failing tests for user-visible preflight/profile language**

Update missing-config assertions in `tests/workflow-ui.test.ts` to expect the quality-profile setup diagnostic, and add assertions that the setup command's visible message names `.pi/quality.json`.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: FAIL because the current command and preflight still describe lint-only configuration.

- [ ] **Step 3: Replace lint gates with required-quality gate loops**

Load the profile at the beginning of `runWorkflow` and `runBuildWorkflow`. Replace single lint command execution with a loop over `required`, recording each result and failing the gate unless every required command succeeds. Preserve retry budgets and send machine-captured quality diagnostics to the existing persistent Builder/Tester repair turns; update prompt wording to say quality gate rather than lint-only gate.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: PASS.

### Task 4: Expose quality profile evidence and update user documentation

**Files:**
- Modify: `extensions/eregion/one-for-all/ui.ts`
- Modify: `extensions/eregion/one-for-all/state.ts`
- Modify: `extensions/eregion/one-for-all/report.ts`
- Modify: `extensions/eregion/one-for-all/docs.md`
- Modify: `skills/pbt/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `WorkflowState.qualityProfile` and `WorkflowState.qualityRuns`.
- Produces: status, report, and documentation language that identifies required commands and their captured outcomes.

- [ ] **Step 1: Write failing report/UI assertions**

Add a `QualityRun` fixture to an existing UI/report test and assert that the final report labels the section `Quality gates`, includes the profile command name, and renders the command/exit code.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: FAIL because reports and widgets still expose lint-only state.

- [ ] **Step 3: Render quality-profile state and document the setup contract**

Replace lint-only labels/state summaries/reports with quality-profile equivalents. Update README, PBT skill, and extension documentation to describe `.pi/quality.json`, direct required-command execution, captured diagnostics, and `/pbt-lint-setup` migration.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `npx tsx --test tests/workflow-ui.test.ts`

Expected: PASS.

### Task 5: Run the complete regression suite

**Files:**
- Verify: `tests/**/*.test.ts`

- [ ] **Step 1: Run all tests**

Run: `npx tsx --test tests/*.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 2: Inspect the final diff against the spec**

Run: `git diff --check && git diff -- extensions/eregion/one-for-all tests/lint-setup.test.ts tests/plan-role-isolation.test.ts tests/workflow-ui.test.ts README.md skills/pbt/SKILL.md`

Expected: no whitespace errors; profile execution, handoff consistency, setup migration, captured diagnostics, and documentation changes present.
