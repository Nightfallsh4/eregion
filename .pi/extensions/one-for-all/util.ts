/**
 * Small generic helpers shared by the One For All extension modules.
 */

import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";

export function ensureDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true });
}

export function truncate(value: string, length: number): string {
	if (value.length <= length) return value;
	return `${value.slice(0, Math.max(0, length - 1))}…`;
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
