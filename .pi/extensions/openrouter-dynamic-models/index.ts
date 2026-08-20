/**
 * OpenRouter Dynamic Models Extension
 *
 * Fetches the latest models from the OpenRouter API immediately before the
 * built-in model selector opens, ensuring the modal has an up-to-date list
 * without delaying pi startup.
 *
 * How it works:
 * 1. Before Ctrl+L or an unqualified /model opens the selector, refresh models
 * 2. Provides /fetch-or-models for a manual refresh
 *
 * It deliberately does not fetch during extension loading, session startup,
 * model cycling, or after a model has been selected.
 *
 * The extension replaces built-in OpenRouter models with live data from the
 * API, so you see exactly what OpenRouter offers without waiting for pi updates.
 *
 * Prerequisites:
 * - Set OPENROUTER_API_KEY environment variable
 * - Or add OpenRouter API key via /login
 * - Or configure in models.json
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import * as zlib from "node:zlib";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OpenRouterModel {
	id: string;
	name: string;
	context_length: number;
	architecture: {
		modality: string;
		input_modalities: string[];
		output_modalities: string[];
	};
	pricing: {
		prompt: string;
		completion: string;
		input_cache_read?: string;
		input_cache_write?: string;
		web_search?: string;
	};
	top_provider: {
		context_length: number | null;
		max_completion_tokens: number | null;
		is_moderated: boolean;
	};
	supported_parameters: string[];
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
		default_effort?: string;
	};
}

interface OpenRouterResponse {
	data: OpenRouterModel[];
}

interface ProviderModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";

// Models that support reasoning/thinking (based on supported_parameters)
const REASONING_PARAMETERS = new Set(["reasoning", "reasoning_effort", "include_reasoning"]);

// Modalities that indicate image support
const IMAGE_MODALITIES = new Set(["image", "vision"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCost(value: string | undefined | null): number {
	if (!value) return 0;
	const num = parseFloat(value);
	return isNaN(num) || num < 0 ? 0 : num;
}

function supportsReasoning(model: OpenRouterModel): boolean {
	// Check the explicit reasoning field first
	if (model.reasoning) {
		return true;
	}
	// Fall back to checking supported_parameters
	return model.supported_parameters.some((p) => REASONING_PARAMETERS.has(p));
}

function getThinkingLevelMap(model: OpenRouterModel): Record<string, string | null> | undefined {
	if (!supportsReasoning(model)) return undefined;

	// If the API provides reasoning.supported_efforts, map them
	if (model.reasoning?.supported_efforts && model.reasoning.supported_efforts.length > 0) {
		const efforts = new Set(model.reasoning.supported_efforts);
		const map: Record<string, string | null> = {};

		// Map pi thinking levels to OpenRouter efforts
		map["off"] = model.reasoning.mandatory ? null : "off";
		map["minimal"] = efforts.has("minimal") ? "minimal" : null;
		map["low"] = efforts.has("low") ? "low" : null;
		map["medium"] = efforts.has("medium") ? "medium" : null;
		map["high"] = efforts.has("high") ? "high" : null;
		map["xhigh"] = efforts.has("xhigh") ? "xhigh" : null;

		return map;
	}

	return undefined;
}

function supportsImages(model: OpenRouterModel): boolean {
	return model.architecture.input_modalities.some((m) => IMAGE_MODALITIES.has(m));
}

function convertModel(raw: OpenRouterModel): ProviderModelConfig | null {
	// Filter out models with negative pricing (like openrouter/auto)
	const promptPrice = parseCost(raw.pricing.prompt);
	const completionPrice = parseCost(raw.pricing.completion);
	if (promptPrice < 0 || completionPrice < 0) {
		return null;
	}

	const contextWindow = raw.context_length || raw.top_provider.context_length || 128000;
	const maxTokens = raw.top_provider.max_completion_tokens || 16384;

	return {
		id: raw.id,
		name: raw.name || raw.id,
		reasoning: supportsReasoning(raw),
		thinkingLevelMap: getThinkingLevelMap(raw),
		input: supportsImages(raw) ? ["text", "image"] : ["text"],
		cost: {
			input: promptPrice * 1_000_000, // Convert per-token to per-million-tokens
			output: completionPrice * 1_000_000,
			cacheRead: parseCost(raw.pricing.input_cache_read) * 1_000_000,
			cacheWrite: parseCost(raw.pricing.input_cache_write) * 1_000_000,
		},
		contextWindow,
		maxTokens,
	};
}

/**
 * Read the raw response body as a Uint8Array, bypassing any automatic
 * content-decoding the fetch implementation might (or might not) do.
 *
 * We use response.body (ReadableStream) directly to get the raw bytes,
 * then detect gzip by checking the magic bytes (0x1f, 0x8b) ourselves.
 * This works regardless of whether the environment auto-decompresses or not.
 */
async function readRawBody(response: Response): Promise<Uint8Array> {
	if (response.body) {
		// Read from the readable stream directly
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalLength = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.length;
		}
		// Combine all chunks into one buffer
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}
	// Fallback: use arrayBuffer
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Decode a gzip-compressed buffer.
 */
function gunzip(buffer: Uint8Array): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zlib.gunzip(Buffer.from(buffer), (err, result) => {
			if (err) reject(err);
			else resolve(result);
		});
	});
}

/**
 * Fetch models from the OpenRouter API.
 * Returns an array of model configs, or null if the fetch failed.
 *
 * Reads the raw response body bytes directly and detects gzip by checking
 * the magic bytes (0x1f 0x8b). This avoids relying on the environment's
 * automatic content-decoding, which is inconsistent across Node.js versions
 * and configurations.
 */
async function fetchOpenRouterModels(): Promise<ProviderModelConfig[] | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);

		const response = await fetch(OPENROUTER_API_URL, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip, identity",
			},
		});
		clearTimeout(timeout);

		if (!response.ok) {
			console.error(`[openrouter-dynamic] API returned ${response.status}: ${response.statusText}`);
			return null;
		}

		// Read raw bytes from the response body stream.
		// We do NOT use response.text() or response.json() because the fetch
		// implementation's automatic gzip decompression is unreliable in some
		// environments. Instead we get the raw bytes and handle decompression
		// ourselves by checking the gzip magic bytes (0x1f 0x8b).
		let rawBody: Uint8Array;
		try {
			rawBody = await readRawBody(response);
		} catch (readError) {
			console.error(
				`[openrouter-dynamic] Failed to read response body: ${readError instanceof Error ? readError.message : String(readError)}`,
			);
			return null;
		}

		if (rawBody.length === 0) {
			console.error("[openrouter-dynamic] Empty response body");
			return null;
		}

		// Check for gzip magic bytes: 0x1f 0x8b
		const isGzip = rawBody[0] === 0x1f && rawBody[1] === 0x8b;

		let bodyText: string;
		if (isGzip) {
			// Decompress gzip manually
			try {
				const decoded = await gunzip(rawBody);
				bodyText = decoded.toString("utf-8");
			} catch (decompressError) {
				console.error(
					`[openrouter-dynamic] Gzip decompression failed: ${decompressError instanceof Error ? decompressError.message : String(decompressError)}`,
				);
				return null;
			}
		} else {
			// Not gzip — decode raw bytes as UTF-8 directly
			bodyText = new TextDecoder().decode(rawBody);
		}

		// Now parse the text as JSON
		let parsed: unknown;
		try {
			parsed = JSON.parse(bodyText);
		} catch (parseError) {
			const preview =
				bodyText.length > 0
					? `First 100 hex: ${Buffer.from(bodyText.slice(0, 100)).toString("hex")}`
					: "Body is empty";
			console.error(
				`[openrouter-dynamic] JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}. ${preview}`,
			);
			return null;
		}

		const models = Array.isArray(parsed) ? parsed : (parsed as OpenRouterResponse).data;

		if (!Array.isArray(models)) {
			console.error("[openrouter-dynamic] Unexpected API response format: `data` is not an array");
			return null;
		}

		const converted: ProviderModelConfig[] = [];
		for (const raw of models) {
			const model = convertModel(raw);
			if (model) {
				converted.push(model);
			}
		}

		console.error(`[openrouter-dynamic] Fetched ${converted.length} models from OpenRouter`);
		return converted;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			console.error("[openrouter-dynamic] Request timed out after 10s");
		} else {
			// Log more details for debugging
			const msg = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : "";
			console.error(`[openrouter-dynamic] Fetch failed: ${msg}`);
			if (stack) {
				console.error(`[openrouter-dynamic] Stack: ${stack.split("\n").slice(0, 3).join("\n")}`);
			}
		}
		return null;
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Keep a cached copy of the last successfully fetched models
	// so we can restore them if a subsequent fetch fails
	let lastSuccessfulModels: ProviderModelConfig[] | null = null;

	/**
	 * Refresh OpenRouter models from the API and register them.
	 * If the fetch fails, we keep the previously fetched models.
	 * If there's no previous fetch, we don't register anything
	 * (built-in models will be used as fallback by the model registry).
	 */
	async function refreshModels(): Promise<boolean> {
		const models = await fetchOpenRouterModels();
		if (models && models.length > 0) {
			lastSuccessfulModels = models;
			pi.registerProvider("openrouter", {
				name: "OpenRouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "OPENROUTER_API_KEY",
				api: "openai-completions",
				authHeader: true,
				models,
			});
			return true;
		}

		// Fetch failed — if we have cached models, re-register with those
		if (lastSuccessfulModels && lastSuccessfulModels.length > 0) {
			console.error("[openrouter-dynamic] Using cached models (fetch failed)");
			pi.registerProvider("openrouter", {
				name: "OpenRouter",
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "OPENROUTER_API_KEY",
				api: "openai-completions",
				authHeader: true,
				models: lastSuccessfulModels,
			});
			return true;
		}

		return false;
	}

	/**
	 * The built-in model modal is opened by Ctrl+L and by `/model` without an
	 * argument. Pi does not expose a pre-modal event, so wrapping its editor
	 * intercepts only that action, refreshes the provider, then
	 * forwards the key to Pi's regular editor. The built-in handler opens the
	 * modal against the freshly registered model list.
	 */
	class RefreshBeforeModelSelectorEditor extends CustomEditor {
		private refreshing = false;
		private readonly isModelSelectorKey: (data: string) => boolean;
		private readonly isSubmitKey: (data: string) => boolean;

		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings);
			this.isModelSelectorKey = (data) => keybindings.matches(data, "app.model.select");
			this.isSubmitKey = (data) => keybindings.matches(data, "tui.input.submit");
		}

		private forwardInput(data: string): void {
			super.handleInput(data);
		}

		override handleInput(data: string): void {
			// Ctrl+L opens the selector directly. Enter opens it when the current
			// command is `/model`; `/model <query>` is a separate direct-selection
			// path and intentionally does not cause a refresh.
			const opensModelSelector =
				this.isModelSelectorKey(data) || (this.isSubmitKey(data) && this.getText().trim() === "/model");

			if (!this.refreshing && opensModelSelector) {
				this.refreshing = true;
				void refreshModels().finally(() => {
					this.refreshing = false;
					this.forwardInput(data);
				});
				return;
			}

			this.forwardInput(data);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new RefreshBeforeModelSelectorEditor(tui, theme, keybindings),
		);
	});

	// ── Manual refresh command ──
	pi.registerCommand("fetch-or-models", {
		description: "Manually refresh OpenRouter models from OpenRouter API",
		handler: async (_args, ctx) => {
			const success = await refreshModels();
			if (success) {
				ctx.ui.notify("OpenRouter models refreshed", "info");
			} else {
				ctx.ui.notify(
					lastSuccessfulModels
						? "OpenRouter fetch failed, using cached models"
						: "OpenRouter fetch failed, using built-in models",
					"warning",
				);
			}
		},
	});
}
