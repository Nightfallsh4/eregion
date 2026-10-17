/**
 * Shared configuration constants for the One For All extension.
 *
 * Other workflows can import this module to reuse the same run layout,
 * timeouts, and display caps, or copy it as a starting point with different
 * values.
 */

import * as path from "node:path";

export const WORKFLOW_NAME = "one-for-all";
export const ACACHE_DIR = "acache";
export const RUNS_DIR = path.join(ACACHE_DIR, "workflow-runs");
/** Previous storage location retained for backwards-compatible status/resume. */
export const LEGACY_RUNS_DIR = path.join(ACACHE_DIR, "pbt-flow-runs");
export const MAX_ITERATIONS = 5;
export const MAX_LINT_REPAIR_ATTEMPTS = 3;
export const PHASE_TIMEOUT_MS = 25 * 60 * 1000;
export const CLARIFICATION_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_SLUG_LENGTH = 72;
export const MAX_PROMPT_HANDOFF_LENGTH = 16_000;
export const MAX_DISPLAY_OUTPUT_LENGTH = 300;
