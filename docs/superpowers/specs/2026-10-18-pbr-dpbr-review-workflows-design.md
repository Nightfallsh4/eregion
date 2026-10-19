# PBR and DPBR Review Workflow Design

## Intent

Add review-centred counterparts to the existing PBT and DPBT workflows. `/pbr` replaces PBT's independent Tester authoring and verification phases with a Reviewer; `/dpbr` retains DPBT's design mockup and explicit approval gate, then follows the same Plan → Builder → Reviewer flow. Existing PBT, DPBT, and `/b` behaviour remains unchanged.

## Workflow model

1. The Planner writes a single feature-named Builder plan.
2. That plan must contain a non-empty `## Acceptance Criteria` section. The orchestrator validates this after the Plan handoff and sends a focused recovery turn to the Planner until it is present.
3. The Builder owns all test work. Its prompt requires the Superpowers test-driven-development skill, a red/green/refactor workflow, relevant test creation or updates, local verification, and an implementation handoff. Builders must never commit.
4. The Reviewer receives the accepted Builder plan and runs in plan-only mode. It reads the code and plan, inspects the Git diff, assesses the acceptance criteria, confirms tests were changed when warranted, and runs every required `.pi/quality.json` command. It reports a structured pass/fail review handoff with exact issues.
5. On a failed review, the persistent Builder receives the Reviewer issues and repairs them. The Reviewer then repeats its review. The loop honours the workflow iteration budget.
6. When every review gate passes, the Reviewer stages and commits the reviewed changes. A narrowly scoped plan-only exception permits only this final `git add`/`git commit` action; it must not allow working-tree file edits. The Reviewer reports the commit SHA.
7. After the Reviewer phase, the orchestrator independently reruns every required quality command and verifies that `HEAD` advanced to the Reviewer-reported commit before marking the run complete.

## Reviewer standards

A passing review requires all of the following:

- implementation and updated/created tests meet every Builder-plan acceptance criterion;
- tests are present or deliberately unchanged only when the requested change genuinely needs none, with review evidence;
- `git diff` (and whitespace diagnostics) reveals no unrelated, malformed, or low-quality change;
- the project builds, tests pass, lint passes, and type checks pass through the required quality profile;
- code structure, naming, duplication, error handling, and repository conventions meet a high standard;
- the final commit was created by the Reviewer after all review checks passed.

The Reviewer may never edit, write, delete, format, or otherwise change working-tree files. Every defect, including test defects, returns to the Builder. It can stage and commit only after a passing review, through the narrow reviewer-only plan-only exception described above.

## Compatibility and observability

PBR and DPBR receive matching workflow definitions, models/effort role configuration, command and tool entry points, resume/stop/status/inspect/cleanup controls, Herdr labels, state persistence, activity events, UI status, final reporting, docs support, and optional final Docs-agent behaviour. Their run state records reviewer handoffs, reviewer quality evidence, baseline/final commit information, and the orchestrator's final quality gate. PBT/DPBT retain their paired Builder/Tester plans and Tester lifecycle exactly as they are.

## Acceptance Criteria

1. `/pbr` and `/dpbr` (including their interactive variants) are discoverable and runnable alongside existing workflows.
2. PBR/DPBR planning cannot advance without a non-empty `## Acceptance Criteria` section in the Builder plan.
3. PBR/DPBR Builders are instructed and equipped to perform TDD and own test changes; they do not commit.
4. The Reviewer is read-only except for a final, successful-review-only Git stage/commit exemption, and all repair work is routed to the Builder.
5. Review failures loop Builder → Reviewer until passing, plateauing, or exhausting the existing iteration budget.
6. Completion requires a passing Reviewer handoff, passing orchestrator-run required quality commands, and a Reviewer-created commit verified against Git.
7. PBT, DPBT, and `/b` retain their existing behaviour and test coverage.
