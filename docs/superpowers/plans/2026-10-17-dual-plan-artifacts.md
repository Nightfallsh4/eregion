# Dual PBT/DPBT Plan Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PBT and DPBT require, validate, and role-isolate paired Builder and Tester plan artifacts before implementation begins.

**Architecture:** Replace the single reservation with an atomic pair of feature-named paths under `acache/plans/`, and persist those exact paths in workflow state and plan handoffs. Centralise the path/handoff validation so the orchestrator can give the persistent Planner a corrective turn on invalid outputs, then route only the Builder plan to Builder and only the Tester plan to Tester. PBT and DPBT share this change through `runWorkflow`; `/b` remains untouched.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, Pi coding-agent extension APIs.

**Spec:** `docs/superpowers/specs/2026-10-17-dual-plan-artifacts-design.md`

## Global Constraints

- PBT and DPBT reserve both files in `acache/plans/`; `/b` continues to have no plan artifacts.
- Paired names use `builder-plan-<slug>.md` and `tester-plan-<slug>.md`, with a shared collision suffix.
- A plan handoff must contain exact `builderPlanPath` and `testerPlanPath` values matching the reserved pair.
- Both plan files must be regular, non-empty files below the project `acache/plans/` directory before Build/Test begins.
- Builder prompts/context must never name or render the tester plan; Tester prompts/context must never name or render the builder plan.
- Tester-plan conditions are semantically cleared only by a passing verification; both files remain after normal workflow cleanup.
- A failed plan-artifact validation returns ownership to the same persistent Planner session for a focused correction and revalidation.

## Review Focus

- A colliding builder filename with a free tester filename must still advance both names to the same suffix, rather than reserve a mismatched pair.
- A handoff that names an existing but different file must be rejected even when both reserved files happen to be non-empty.
- A directory, symlink/path escape, or empty placeholder in `acache/plans/` must never satisfy the plan barrier.
- Resuming an older state that has only `planPath` must rerun the plan barrier rather than incorrectly start Builder/Test.
- A Tester must not return `status: "pass"` while a tester-plan condition is omitted or unexecuted.

---

### Task 1: Model and reserve paired plan artifacts

**Files:**
- Modify: `extensions/eregion/one-for-all/types.ts`
- Modify: `extensions/eregion/one-for-all/plan-paths.ts`
- Modify: `extensions/eregion/one-for-all/state.ts`
- Create: `tests/plan-paths.test.ts`

**Interfaces:**
- Produces `PlanPaths` with `builderPlanPath: string` and `testerPlanPath: string`.
- Produces `reservePlanPaths(cwd: string, request: string): PlanPaths` and `releasePlanReservations(cwd: string, paths: PlanPaths): void`.
- Produces `assertPlanOutputsExist(cwd: string, paths: PlanPaths): void`.
- Extends `PhaseHandoff` and `WorkflowState` with the paired-path fields while retaining tolerant read support for legacy saved state.

- [ ] **Step 1: Write failing paired-reservation tests in `tests/plan-paths.test.ts`**

Cover a normal pair under `acache/plans/`, a collision on either member that advances both names to `-2`, release of both in-memory reservations, and a second reservation succeeding after empty placeholders are removed.

- [ ] **Step 2: Run the new reservation tests to verify failure**

Run: `bun test tests/plan-paths.test.ts`

Expected: FAIL because `reservePlanPaths` and paired-path types do not exist.

- [ ] **Step 3: Implement atomic `PlanPaths` reservation in `plan-paths.ts`**

Replace the single-plan reservation contract with a loop that checks both candidate paths before creating either placeholder. On a race while creating the second placeholder, remove the first placeholder/reservation and retry the next shared suffix. Keep output relative to `cwd`.

- [ ] **Step 4: Add paired state/handoff fields and plan-output validation**

In `types.ts`, add `builderPlanPath` and `testerPlanPath` to plan handoffs/state, retaining `planPath` only as a legacy persisted-state compatibility field. In `state.ts`, implement `assertPlanOutputsExist` to require exact expected paths, safe in-project resolution, containment in `acache/plans/`, regular non-empty files, and no path aliasing between the pair.

- [ ] **Step 5: Extend `tests/plan-paths.test.ts` with validation failures**

Assert rejection for an empty placeholder, a directory, a path outside `acache/plans/`, and two identical paths; assert acceptance only for two distinct non-empty regular files in the reserved location.

- [ ] **Step 6: Run paired-path tests to verify they pass**

Run: `bun test tests/plan-paths.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the paired reservation contract**

```bash
git add extensions/eregion/one-for-all/types.ts extensions/eregion/one-for-all/plan-paths.ts extensions/eregion/one-for-all/state.ts tests/plan-paths.test.ts
git commit -m "feat: reserve paired workflow plan artifacts"
```

### Task 2: Enforce the plan handoff and recover invalid planner outputs

**Files:**
- Modify: `extensions/eregion/one-for-all/handoffs.ts`
- Modify: `extensions/eregion/one-for-all/prompts.ts`
- Modify: `extensions/eregion/one-for-all/orchestrator.ts`
- Create: `tests/plan-handoff.test.ts`

**Interfaces:**
- Produces `validatePlanHandoff(handoff: PhaseHandoff, paths: PlanPaths): void`.
- Produces `buildPlanTask(request: string, paths: PlanPaths, answers: WorkflowAnswer[], interactive: boolean): string`.
- Produces `buildPlanRecoveryTask(paths: PlanPaths, validationError: string): string`.
- Consumes `assertPlanOutputsExist` before accepting a plan handoff.

- [ ] **Step 1: Write failing plan-handoff and prompt tests in `tests/plan-handoff.test.ts`**

Construct plan handoffs with both exact fields, one missing field, swapped fields, and mismatched paths. Assert only the exact pair passes `validatePlanHandoff`. Assert normal and recovery planner tasks name both paths, require both artifacts, and say that Planner may not modify production code or tests.

- [ ] **Step 2: Run the handoff tests to verify failure**

Run: `bun test tests/plan-handoff.test.ts`

Expected: FAIL because the paired handoff validator and recovery task do not exist.

- [ ] **Step 3: Parse and validate paired plan-path fields in `handoffs.ts`**

Extend `normalizeHandoff` to preserve `builderPlanPath` and `testerPlanPath`. Add `validatePlanHandoff` that requires phase `plan`, both exact reserved paths, and both paths listed as created plan artifacts. Do not silently add missing plan artifacts after validation.

- [ ] **Step 4: Rewrite planner task builders for paired output and recovery**

Make normal planning instruct the planner to create only the exact builder/tester files, describing their distinct required contents. Add a concise recovery prompt that names the validation failure and forces correction of only the reserved files plus a complete replacement handoff. Continue interactive clarification behavior unchanged.

- [ ] **Step 5: Change the plan phase in `orchestrator.ts` to persist and recover**

Reserve/load `PlanPaths`, use a persistent `planner.jsonl` session for both simple and interactive planning, and accept a handoff only after `validatePlanHandoff` and `assertPlanOutputsExist` pass. Catch only output-contract/validation failures, issue `buildPlanRecoveryTask` to the same Planner, reparse/revalidate, and retain meaningful failure diagnostics if recovery cannot produce valid artifacts. When loading legacy state without the two paths, reserve a pair and invalidate its old single-plan barrier so planning runs again.

- [ ] **Step 6: Add orchestration-boundary regression coverage**

Test the exported validator/recovery task plus the plan-phase helper or injected planner runner introduced in Step 5: first response with a missing/empty tester plan triggers exactly one recovery call to the same session; a corrected second response advances; an invalid handoff never appears in `state.handoffs` or starts Build/Test.

- [ ] **Step 7: Run handoff/recovery tests to verify they pass**

Run: `bun test tests/plan-handoff.test.ts tests/plan-paths.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit planner validation and recovery**

```bash
git add extensions/eregion/one-for-all/handoffs.ts extensions/eregion/one-for-all/prompts.ts extensions/eregion/one-for-all/orchestrator.ts tests/plan-handoff.test.ts tests/plan-paths.test.ts
git commit -m "feat: recover invalid paired planner outputs"
```

### Task 3: Isolate Builder/Tester plan consumption and tester-plan clearance

**Files:**
- Modify: `extensions/eregion/one-for-all/prompts.ts`
- Modify: `agents/planner-simple.md`
- Modify: `agents/planner-interactive.md`
- Modify: `agents/builder.md`
- Modify: `agents/tester.md`
- Modify: `extensions/eregion/one-for-all/handoffs.ts`
- Create: `tests/plan-role-isolation.test.ts`

**Interfaces:**
- Changes initial build task signature to `buildInitialBuildTask(request, builderPlanPath, planHandoff, iteration)`.
- Changes test-authoring and test-verification task signatures to accept `testerPlanPath` only.
- Adds `TesterPlanCondition { id: string; status: "passed" | "failed" | "blocked"; evidence: string }` and `PhaseHandoff.testerPlanClearance?: TesterPlanCondition[]`.
- Extends verification validation to require a non-empty all-`passed` `testerPlanClearance` record before `status: "pass"`.

- [ ] **Step 1: Write failing role-isolation tests in `tests/plan-role-isolation.test.ts`**

Use sentinel strings for the two paths. Assert Builder task text includes only the builder sentinel, Test authoring/verification task text includes only the tester sentinel, and planner prompts distinguish implementation instructions from test cases/scenarios. Assert a passing verification handoff without required tester-plan clearance is rejected while a failing handoff remains valid.

- [ ] **Step 2: Run the role-isolation tests to verify failure**

Run: `bun test tests/plan-role-isolation.test.ts`

Expected: FAIL because existing prompts share one `planPath` and verification has no clearance field.

- [ ] **Step 3: Route role-specific paths through prompts and orchestrator calls**

Update all initial Builder, test-authoring, and verification invocation sites to use their role’s path. Ensure compact handoff renderers do not leak the opposite path. Preserve approved DPBT design references as an independent shared input.

- [ ] **Step 4: Update subagent instructions and verification contract**

Require both planner agents to create the paired documents with their distinct content; every tester-plan scenario must have a stable checklist ID. Require Builder to read only `builderPlanPath`. Require Tester to read only `testerPlanPath`, report its `testerPlanClearance` entries by those IDs with evidence, and return `status: "pass"` only when every reported condition is `passed`. Add the typed clearance field and validate non-empty/all-passed clearance only for `status: "pass"`; failing handoffs must still be able to report failed/blocked conditions and issues.

- [ ] **Step 5: Run role-isolation tests to verify they pass**

Run: `bun test tests/plan-role-isolation.test.ts tests/plan-handoff.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit role-isolated plans and clearance protocol**

```bash
git add extensions/eregion/one-for-all/prompts.ts extensions/eregion/one-for-all/orchestrator.ts extensions/eregion/one-for-all/handoffs.ts agents/planner-simple.md agents/planner-interactive.md agents/builder.md agents/tester.md tests/plan-role-isolation.test.ts
git commit -m "feat: isolate builder and tester workflow plans"
```

### Task 4: Surface both artifacts and document retained plan history

**Files:**
- Modify: `extensions/eregion/one-for-all/state.ts`
- Modify: `extensions/eregion/one-for-all/ui.ts`
- Modify: `extensions/eregion/one-for-all/report.ts`
- Modify: `extensions/eregion/one-for-all/docs.md`
- Modify: `README.md`
- Modify: `skills/pbt/SKILL.md`
- Modify: `tests/workflow-ui.test.ts`

**Interfaces:**
- `summarizeState`, UI, and final report render `Builder plan:` and `Tester plan:` for PBT/DPBT.
- `/b` retains its existing `Plan: not used` display.

- [ ] **Step 1: Write failing observability assertions in `tests/workflow-ui.test.ts`**

Create a PBT state containing both paths and assert status/report/widget output names both. Reuse a `/b` state and assert it still says its plan is not used and does not render dual paths.

- [ ] **Step 2: Run the UI/report assertions to verify failure**

Run: `bun test tests/workflow-ui.test.ts`

Expected: FAIL because PBT/DPBT currently display one `planPath`.

- [ ] **Step 3: Render paired paths without changing cleanup semantics**

Update state summaries, live widget, final report, completion notification, and user-facing docs to describe the paired plans and tester-plan clearance. State explicitly that normal cleanup preserves both plan files. Keep `/b` behavior and old state rendering safe during migration.

- [ ] **Step 4: Run UI/report assertions to verify they pass**

Run: `bun test tests/workflow-ui.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit observability and documentation**

```bash
git add extensions/eregion/one-for-all/state.ts extensions/eregion/one-for-all/ui.ts extensions/eregion/one-for-all/report.ts extensions/eregion/one-for-all/docs.md README.md skills/pbt/SKILL.md tests/workflow-ui.test.ts
git commit -m "docs: describe paired PBT plan artifacts"
```

### Task 5: Run the complete verification suite

**Files:**
- Modify: any files only if a failing test identifies a real defect in the preceding tasks.

**Interfaces:**
- Consumes all paired-plan interfaces and existing workflow tests.
- Produces a clean full-suite result with no changes to unrelated Butler, guardrail, lint, documentation, or workflow-effort behavior.

- [ ] **Step 1: Run all repository tests**

Run: `bun test tests/*.test.ts`

Expected: PASS.

- [ ] **Step 2: Inspect the working tree and targeted diffs**

Run: `git status --short && git diff --check && git diff -- extensions/eregion/one-for-all agents tests README.md skills/pbt/SKILL.md`

Expected: only the paired-plan implementation, tests, and documentation changes; no whitespace errors and no modification to the user’s pre-existing unrelated work.

- [ ] **Step 3: Commit final verification fixes if needed**

```bash
git add <only-files-fixed-by-verification>
git commit -m "test: verify paired workflow plan artifacts"
```
