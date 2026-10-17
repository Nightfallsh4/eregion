# Dual PBT/DPBT Plan Artifacts Design

## Intent

PBT and DPBT currently produce one plan that both the Builder and Tester read. Split this plan phase into two durable, role-specific artifacts so implementation guidance and test scenarios are independently owned and cannot be accidentally consumed across roles.

## Goals

- Every PBT and DPBT plan phase creates two non-empty files in the existing `acache/plans/` directory:
  - a builder plan containing build instructions, implementation constraints, and acceptance criteria;
  - a tester plan containing test cases, scenarios, commands, coverage expectations, and explicit pass conditions.
- The Builder reads only the builder plan. The Tester reads only the tester plan during authoring and verification.
- The orchestrator verifies both plan outputs programmatically before build or test authoring begins.
- If either output is missing, empty, unsafe, at an unexpected path, or absent from the planner handoff, the plan phase retains ownership. The orchestrator instructs the Planner to create/correct the named outputs and verifies again.
- The tester plan is cleared only semantically: its conditions are cleared when the Tester has executed them successfully. Neither plan file is deleted after a completed workflow or by normal workflow cleanup.
- The same behavior applies to PBT and DPBT, because both use `runWorkflow`; DPBT retains its separate design-review gate.

## Non-goals

- Do not change the focused `/b` workflow; it has no plan or tester phase.
- Do not replace the existing test-authoring, lint, issue-ledger, or verification repair loops.
- Do not permit Builder access to the tester plan or Tester access to the builder plan through workflow prompts/context.
- Do not move plan artifacts out of `acache/plans/`.

## Artifact Contract

For a feature slug `feature`, the orchestrator reserves a collision-safe pair such as:

- `acache/plans/builder-plan-feature.md`
- `acache/plans/tester-plan-feature.md`

Both paths are reserved together. If either name collides, the pair receives the same numeric suffix, for example `builder-plan-feature-2.md` and `tester-plan-feature-2.md`. This preserves a recognisable pair and avoids a partial reservation.

The planner handoff records `builderPlanPath` and `testerPlanPath`. The orchestrator accepts a plan phase only when those handoff values equal the paths it reserved and both files are regular, non-empty files under the project `acache/plans/` directory.

## Planner Recovery

A failed artifact check does not end the workflow or allow Build/Test to proceed. The orchestrator retains the planner session, records the plan phase as active, and sends a focused recovery task that identifies the validation failure and the two exact paths. The Planner may only correct the plan artifacts and must return a corrected plan handoff. The orchestrator repeats the same validation before proceeding. Recovery failures retain the actionable diagnostics in state and final reporting.

## Role Isolation and Test Clearance

Builder prompts mention the request and `builderPlanPath`, and render only the builder-plan handoff context. Tester authoring and verification prompts mention the request and `testerPlanPath`, and render only tester-plan context. The Tester must author/run coverage from the tester plan and report a passing verification only when all required tester-plan conditions have passed. Existing test failures continue into the durable Builder fix loop and are re-verified by the persistent Tester.

## Persistence and Observability

`WorkflowState`, handoffs, summaries, UI, and reports expose both paths. Old persisted single-plan runs are not treated as satisfying the new plan barrier: resuming one returns to planning so the two required outputs can be generated. Normal `/pbt-cleanup` and `/dpbt-cleanup` behavior continues to retain completed plan artifacts for inspection.

## Verification

Regression coverage must verify paired reservation/collision/release behavior; exact, non-empty, in-folder validation; planner-handoff path validation; recovery-task construction; builder/tester prompt isolation; tester-plan clearance language; status/report rendering; and preservation of `/b`'s no-plan behavior.
