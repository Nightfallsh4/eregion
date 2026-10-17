/**
 * Small generic helpers shared by the One For All extension modules.
 */

import * as fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { Message } from "@mariozechner/pi-ai";

export function ensureDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true });
}

export function truncate(value: string, length: number): string {
	if (value.length <= length) return value;
	return `${value.slice(0, Math.max(0, length - 1))}…`;
}

/** Remove terminal commands from diagnostics, preserving readable line breaks. */
export function sanitizeTerminalText(value: string): string {
	return stripVTControlCharacters(value).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** Full diagnostics belong in state/reports, not in transient notifications. */
export function compactErrorMessage(error: unknown, length = 160): string {
	const raw = error instanceof Error ? error.message : String(error);
	const cleaned = sanitizeTerminalText(raw).replace(/\s+/g, " ").trim();
	return truncate(cleaned || "Unknown error", length);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function getAssistantText(message: Message): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
