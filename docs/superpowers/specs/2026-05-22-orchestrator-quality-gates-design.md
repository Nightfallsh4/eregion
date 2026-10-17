# Orchestrator-Owned Quality Gates Design

## Intent

Make workflow completion reproducible from project-defined commands rather than relying on a Tester agent's claimed pass result. Projects provide a `.pi/quality.json` profile, and the PBT/DPBT and just-build orchestrators execute its required commands themselves, persist their outputs, and refuse completion when any required command fails.

## Goals

- Replace `.pi/lint.json` with `.pi/quality.json` as the project quality configuration.
- Validate the profile before any agent workflow phase begins. A missing, unreadable, malformed, or incomplete profile is a hard failure that explains the cause and tells the operator to run `/pbt-lint-setup`.
- Run every command named by `required` directly through the existing bounded, abort-aware shell runner.
- Capture command name, command text, exit code, stdout, and stderr in workflow state and reports.
- Require every direct required-command run to succeed before PBT/DPBT or just-build can complete.
- Retain Tester ownership of test selection, test authoring, failure analysis, and detailed handoffs, while requiring a passing Tester handoff to contain only successful reported test runs.
- Update `/pbt-lint-setup` (its name is retained for command compatibility) so it creates the quality profile rather than a lint-only configuration.

## Non-goals

- Infer or install a universal set of quality tools without repository evidence.
- Treat optional commands as failures; only profile entries named in `required` are gates.
- Trust command exit codes reported in an agent handoff instead of the orchestrator's own execution.
- Do not preserve `.pi/lint.json` compatibility; projects must run setup to create the new explicit profile.

## Quality profile

```json
{
  "commands": {
    "format": "npm run format:check",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": "npm run build",
    "unit": "npm test"
  },
  "required": ["lint", "typecheck", "build", "unit"]
}
```

`commands` maps non-empty names to non-empty shell commands. `required` is a non-empty, duplicate-free list, and every required name must exist in `commands`. The setup agent chooses commands that are actually appropriate and reproducible for the inspected repository; the shown names are conventional examples, not mandatory categories.

## Execution behaviour

At workflow startup, the orchestrator loads and validates `.pi/quality.json` before it invokes a subagent. It saves the profile's required names and commands in state for inspection.

At each existing quality barrier, the orchestrator executes every required command itself and records a `QualityRun` for each attempt. It retains the existing repair routing: build barriers return failures to the persistent Builder; test-authoring and verification barriers return failures to the persistent Tester. The command output passed to repair turns is machine-captured. A barrier passes only when every required command succeeds.

Just-build runs the same required command set after its sole Builder handoff and after each repair turn. It cannot complete until all required commands succeed.

PBT/DPBT run the profile at their build, test-authoring, and test-verification barriers. The final verification barrier is therefore an independent execution of all required checks, including configured unit/integration/e2e commands, after the Tester has declared the relevant suites and plan conditions passed.

## Handoff integrity

A `testStage=verification`, `status=pass` handoff must continue to contain tester-plan clearance and at least one test run. It must additionally contain only `exitCode: 0` test runs. This validates internal consistency of the handoff but is not considered authoritative quality evidence; the direct profile runs are.

## Observability

Workflow state, status summaries, widgets, and final reports refer to the quality profile and quality runs rather than a singular lint command. Reports preserve each command's captured diagnostics. The UI may show the most recent quality run, including its profile command name.
