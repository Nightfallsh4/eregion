# Eregion agent efficiency, reliability, and intelligence audit

**Date:** 2026-02-16
**Scope:** Read-only review of Eregion’s first-party runtime, workflow engine, agents, prompts, workflow presets, configuration, package loader, documentation, tests, and the integration point for vendored Superpowers. The vendored Superpowers integration and provenance were reviewed; upstream third-party skills themselves are treated as external code.

## Executive summary

Eregion already has strong workflow foundations:

- persistent, resumable specialist sessions;
- structured planner, builder, tester, designer, and documentation handoffs;
- issue-by-issue repair ledgers;
- parallel initial build and test authoring;
- configurable per-role models and reasoning effort;
- parent-session guardrail permission relays;
- lint quality gates;
- design approval for DPBT;
- live progress, reports, cleanup, and resume controls.

The principal gap is **verification integrity**. The workflow is carefully orchestrated, but its final success signal relies too heavily on LLM-reported handoffs. The Tester is instructed to run tests, but the orchestrator itself only runs the configured lint command. A valid-looking test handoff can therefore be accepted without an independent proof that required builds, type checks, or tests succeeded.

The recommended direction is to make task completion evidence-based, isolate each mutating role, measure real outcomes, and use those measurements to improve scheduling, model routing, recovery, and autonomy over time.

---

## Priority P0 — Make completion objectively verifiable

### 1. Add orchestrator-owned quality gates

**Finding**

`.pi/lint.json` is the only project quality command directly executed by the orchestrator. Test execution is delegated to the Tester agent and represented in a JSON handoff. `validateVerificationHandoff()` requires a test stage, status, and at least one test run, but does not verify that a passing handoff contains only successful commands or independently rerun those commands.

**Recommendation**

Replace the lint-only configuration with a project quality profile, for example `.pi/quality.json`:

```json
{
  "commands": {
    "format": "npm run format:check",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": "npm run build",
    "unit": "npm test",
    "integration": "npm run test:integration",
    "e2e": "npm run test:e2e",
    "security": "npm audit --omit=dev"
  },
  "required": ["lint", "typecheck", "build", "unit"]
}
```

The orchestrator should run applicable required commands directly, capture their output, and only mark a run complete when all required commands exit successfully. The Tester should continue to choose relevant tests, write tests, analyse failures, and produce rich issue reports; it should no longer be the sole authority for declaring verification successful.

**Expected benefit**

- Prevents false completion claims.
- Makes output reproducible without trusting a model’s summary.
- Supports repository-specific quality standards.
- Produces better repair prompts because diagnostics are machine-captured.

---

### 2. Isolate mutating phases and enforce role ownership

**Finding**

Initial Builder and Tester authoring phases run in parallel against the same checkout. Agent prompts define ownership, but do not technically prevent either role from modifying the other’s files. The Tester also receives editing and shell tools.

**Recommendation**

Run mutating phases in controlled workspaces:

- Builder changes production code in a dedicated worktree.
- Test author changes only tests and test configuration in a separate worktree.
- A controller validates each diff and merges/applies permitted changes into an integration workspace.
- The verifier executes all deterministic gates in the integration workspace.
- A phase change manifest validates allowed paths before accepting the phase handoff.

Examples of enforceable boundaries:

| Role | Permitted changes |
|---|---|
| Planner | Exact reserved plan file only |
| Designer | Exact isolated preview directory only |
| Builder | Production files; narrowly authorised test repairs only |
| Tester author | Tests and test configuration only |
| Documentation | `docs/` only |

**Expected benefit**

- Eliminates concurrent file races and clobbering.
- Detects role violations rather than merely asking agents not to commit them.
- Makes retry and resume behaviour safer.

---

### 3. Build an agent evaluation suite and release CI

**Finding**

The repository contains useful unit-style tests for guardrails, UI/report rendering, documentation prompts, and workflow effort configuration. It does not contain an end-to-end, fixture-driven evaluation suite that demonstrates actual PBT/DPBT task completion across realistic repositories. `package.json` also has no standard test, lint, typecheck, or CI scripts.

**Recommendation**

Create fixture repositories and benchmark scenarios for:

- feature implementation;
- regression repair;
- test failure and repair loops;
- lint, typecheck, and build failures;
- malformed handoffs;
- denied guardrail permissions;
- model/provider outage;
- timeout and cancellation;
- concurrent edit conflict;
- interrupted and resumed workflow;
- DPBT approval/revision lifecycle;
- monorepo and multi-language projects.

Measure:

- independent acceptance-test pass rate;
- reviewer approval rate;
- unintended-file-change rate;
- retry/resume success rate;
- wall-clock time;
- tokens and cost per successful task;
- number of manual interventions.

Run the evaluation suite in CI against supported Pi versions before release.

**Expected benefit**

Eregion can improve against measured task outcomes rather than prompt intuition. This is the difference between a workflow and a workflow one can trust on a Friday afternoon.

---

## Priority P1 — Improve intelligence and autonomous completion

### 4. Add a fresh, independent final reviewer

**Finding**

The persistent Tester session both authors and verifies tests. This is efficient, but it is not independent: a session can preserve its own incorrect assumptions or test only the behaviour it expected.

**Recommendation**

After deterministic quality gates pass, dispatch a fresh Reviewer session. It should compare:

- original request;
- approved plan and design decisions, where applicable;
- repository diff;
- deterministic quality-gate results;
- test coverage and final artifacts.

The Reviewer should return either approval or structured issues routed through the existing Builder repair ledger. Use a stronger model only for high-risk or ambiguous reviews.

**Expected benefit**

Catches semantic failures such as “tests pass but the requested behaviour was never implemented,” incomplete acceptance criteria, accidental API changes, security regressions, and missing edge cases.

---

### 5. Introduce a repository-intelligence preflight

**Finding**

Each phase independently re-explores the repository. Persistent sessions reduce repeated context on later turns, but there is no standard, reusable project fact sheet.

**Recommendation**

Before planning, run a read-only deterministic reconnaissance pass that records:

- language, framework, and package manager;
- build, test, lint, typecheck, and CI commands;
- source, tests, docs, and configuration layout;
- uncommitted files;
- applicable code conventions;
- likely affected modules and tests;
- high-risk files such as migrations, authentication, deployment, and generated artifacts.

Store a compact project card keyed by Git HEAD plus a working-tree fingerprint. Supply phase-relevant excerpts to agents instead of having every role rediscover basic facts.

**Expected benefit**

- Faster phase startup.
- Fewer wrong ecosystem assumptions.
- Lower context use.
- More consistent plans, tests, and repair decisions.

---

### 6. Create an explicit task contract and risk-aware autonomy policy

**Finding**

Eregion currently distinguishes mostly between simple and interactive workflows. That is helpful, but it does not encode whether a request is safe to complete autonomously or requires a human decision.

**Recommendation**

Normalize each request into a durable task contract:

- objective;
- non-goals;
- measurable acceptance criteria;
- affected files or systems;
- required quality gates;
- risk classification;
- approval requirements;
- cost/time budget.

Autonomously continue low-risk, reversible work. Require focused approval only for consequential actions: database migrations, dependency upgrades, authentication or permission changes, destructive edits, production/deployment changes, external paid services, or large estimated cost.

**Expected benefit**

Agents become more autonomous without becoming indiscriminate. A rather more useful trait than courage without a map.

---

### 7. Add failure classification and targeted recovery policies

**Finding**

The workflow has fixed iteration caps, a useful issue ledger, and consecutive-fingerprint plateau detection. It does not distinguish enough between implementation failures, flaky tests, environment outages, malformed handoffs, permissions blocks, or provider failures.

**Recommendation**

Classify failures into categories and attach a recovery policy:

| Failure class | Recovery policy |
|---|---|
| Implementation defect | Route one issue to Builder |
| Stale test/configuration | Permit narrow test repair |
| Flaky test | Controlled retry and flake evidence |
| Dependency/infrastructure | Report environmental blocker with reproducible command |
| Model/provider failure | Backoff and route to configured fallback model |
| Guardrail block | Request narrow explicit approval or pause |
| Malformed handoff | Schema-repair turn; do not accept fallback completion |
| Worktree conflict | Controlled merge/conflict resolution phase |

Persist failure signatures and successful remedies per project, so later runs can reuse known working fixes and avoid repeating failed strategies.

**Expected benefit**

Higher autonomous recovery rates and fewer wasted iterations.

---

## Priority P1 — Improve speed, cost, and scalability

### 8. Use adaptive model and effort routing

**Finding**

Bundled workflows default all roles to high reasoning effort. Eregion supports per-role model/effort pins well, but routing is static. `AgentResult` collects token, cache, turn, and cost statistics, but the orchestrators do not persist or use those measurements for future decisions.

**Recommendation**

Add a model-policy layer that selects model and effort using task complexity, risk, repository size, recent agent reliability, latency, context needs, and budget:

- cheap/fast model for reconnaissance, documentation, and straightforward lint repair;
- strong Planner/Reviewer for ambiguous or high-risk decisions;
- reliable Builder/Verifier for implementation and test analysis;
- configured fallback when a pinned provider/model fails.

Persist phase duration, usage, cost, error type, retry count, and final outcome. Expose per-workflow metrics with a command such as `/pbt-metrics`.

**Expected benefit**

Better speed and cost control while reserving the highest reasoning capacity for work that actually needs it.

---

### 9. Replace broad parallelism with dependency-aware scheduling

**Finding**

The initial Builder and test-authoring phases are parallelised, which is fast but unsafe in one working tree. Other read-only work that could safely happen in parallel is not centrally scheduled.

**Recommendation**

Use a small DAG scheduler:

- parallelise read-only repository reconnaissance, API/docs discovery, static test strategy, and risk/security review;
- isolate or serialize operations that mutate overlapping files;
- select likely affected tests from changed files for fast feedback;
- retain configurable full-suite gates before final completion.

**Expected benefit**

Reduced wall-clock time without trading correctness for concurrent file roulette.

---

### 10. Add structured long-horizon project memory

**Finding**

Persistent phase sessions retain useful conversational context, but raw sessions grow and are not a reliable form of project memory across independent runs.

**Recommendation**

Maintain a compact, queryable memory store containing only verified facts:

- architecture and integration facts;
- accepted project conventions;
- quality commands that work;
- user preferences;
- known high-risk areas;
- previous failure signatures and successful recovery strategies;
- approved product/design decisions.

Retrieve only entries relevant to the task and changed paths. Summarise persistent sessions at phase boundaries to control context growth.

**Expected benefit**

More consistent decisions across runs, fewer repeated investigations, and lower token use.

---

## Reliability and safety hardening

### 11. Make handoffs strict, versioned, and evidence-backed

**Finding**

`requireHandoff()` falls back to a summary-only handoff when an agent returns no parseable structured handoff. That is reasonable for reporting but risky when a handoff is a control-plane boundary.

**Recommendation**

- Version the handoff protocol.
- Validate with a strict TypeBox or Zod schema.
- Reject unparseable handoffs for control transitions; request a focused schema-repair turn instead.
- Validate artifact paths against each phase allowlist.
- Require phase evidence:
  - Planner: reserved non-empty plan and affected file/test list.
  - Builder: validated diff and changed-file manifest.
  - Tester: orchestrator-captured command results.
  - Reviewer: acceptance-criteria traceability.
- Apply sensible field-size bounds to avoid excessive state and prompt payloads.

---

### 12. Improve OpenRouter model discovery and fallback

**Finding**

The OpenRouter extension can fetch a full live catalogue before opening the model selector, with a ten-second request timeout. It has in-memory fallback but no persistent cache, capability ranking, or explicit workflow fallback reporting.

**Recommendation**

- Persist a TTL/ETag-backed model cache.
- Refresh in the background where possible.
- Maintain a curated coding-capable shortlist.
- Filter on required capability, context size, reasoning support, and configured budget.
- Emit a routing event when a requested model is unavailable.
- Apply explicit per-role fallback chains rather than silently selecting an arbitrary authenticated model.

---

### 13. Add permission preflight without weakening guardrails

**Finding**

Guardrails correctly fail closed and relay prompts to the parent session. Predictable workflow permissions may nevertheless interrupt agents repeatedly.

**Recommendation**

At workflow start, present a bounded preflight summary of expected external paths, network use, tools, temporary directories, and commands. Let the user approve only the anticipated scope. Preserve existing operation-level prompts for unexpected access.

**Expected benefit**

Fewer pauses and faster autonomous operation without converting security into blind trust.

---

### 14. Replace regex shell policing with command-aware policy

**Finding**

`global/plan-only.ts` detects destructive commands through regular expressions. During this audit, a read-only diagnostic command was blocked because it used `2>/dev/null`; the broad redirection matcher treated it as a write. Conversely, regex matching cannot safely understand all shell forms.

**Recommendation**

- Prefer structured tools over raw shell commands where practical.
- Parse shell syntax conservatively for plan-only decisions, or execute within a restricted environment.
- Differentiate stderr redirection from file-writing redirection.
- Add regression tests for harmless diagnostics and shell bypass attempts.

**Related defect**

The extension registers `Ctrl+Alt+P`, while several plan-only error messages still tell users to use `Ctrl+Shift+P`.

---

### 15. Strengthen bash-path guardrails

**Finding**

`global/guardrails.ts` tokenises a limited subset of shell commands and generally inspects the first relevant argument. Complex shell forms, quoted paths, multiple path arguments, substitutions, wrappers, and nested command execution cannot be reliably understood by a simple token scan.

**Recommendation**

- Prefer isolated workspaces/sandboxes for workflows.
- Make decisions from structured tool arguments where possible.
- Use a conservative command parser for unavoidable shell execution.
- Add adversarial tests covering quotes, multiple paths, substitutions, pipelines, and interpreter wrappers.

---

## Documentation and maintenance findings

Operational documentation currently contains stale details that can mislead agents and maintainers.

### `extensions/eregion/one-for-all/docs.md`

The document refers to several obsolete runtime surfaces:

- non-existent `pbt_flow_*` tools instead of registered `pbt_*` tools such as `pbt_start`, `pbt_resume`, and `pbt_status`;
- legacy `/pbt-flow` command wording;
- legacy `.pi/extensions/one-for-all/` installation layout rather than the portable package layout;
- obsolete `acache/pbt-flow-runs/` storage path rather than `acache/workflow-runs/`;
- `pi.appendEntry("pbt-flow", ...)`, while the implementation uses `"workflow-run"`.

### `skills/pbt/SKILL.md`

The bundled PBT skill directs agents to `.pi/extensions/one-for-all/`, which does not describe the installed package’s source location. It should reference the package’s documented runtime structure or avoid hard-coding an installation-specific path.

### Recommended maintenance improvement

Add documentation-contract tests that compare:

- registered command/tool names;
- configuration key names;
- storage paths;
- help text;
- package layout references;
- examples in README, skills, and module documentation.

This prevents correct code from being accompanied by instructions for a previous incarnation of itself, an occupational hazard of successful refactoring.

---

## Recommended implementation sequence

1. **Create quality profiles and orchestrator-owned build/typecheck/test gates.**
2. **Introduce worktrees, diff ownership checks, and strict evidence-backed handoffs.**
3. **Build fixture-driven evaluations, outcome telemetry, package scripts, and CI.**
4. **Add an independent Reviewer and a risk-aware task contract.**
5. **Implement repository preflight, durable project memory, and failure classification.**
6. **Add adaptive model/effort routing, cached model catalogues, and dependency-aware scheduling.**
7. **Harden plan-only/guardrails shell handling and repair documentation drift.**

## Success metrics

Track the following after each milestone:

| Metric | Desired direction |
|---|---|
| Independent acceptance-test pass rate | Increase |
| False completion rate | Decrease toward zero |
| Unintended file-change rate | Decrease toward zero |
| Resume/recovery success rate | Increase |
| Median workflow duration | Decrease |
| Cost per accepted task | Decrease |
| Manual intervention rate | Decrease |
| Regression suite coverage of workflow failures | Increase |
| Reviewer-found post-test defects | Initially increase, then decline |

## Non-goals

- Do not remove human approval for consequential actions.
- Do not weaken guardrails merely to make workflows appear faster.
- Do not optimise model cost before collecting outcome-quality evidence.
- Do not treat lint success as proof of runtime correctness.
- Do not turn project memory into unverified model speculation; persist verified facts only.
