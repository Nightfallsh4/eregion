import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import butlerPersona, { BUTLER_PERSONA_PROMPT } from "../extensions/eregion/global/butler-persona.js";

test("butler persona adds its own system-prompt section without replacing others", () => {
	let handler: ((event: any) => void) | undefined;
	const pi = {
		on(event: string, callback: (event: any) => void) {
			assert.equal(event, "before_agent_start");
			handler = callback;
		},
	} as unknown as ExtensionAPI;

	butlerPersona(pi);
	assert.ok(handler);

	const event = { systemPromptOptions: { sections: { existing: "Keep this instruction." } } };
	handler(event);

	assert.equal(event.systemPromptOptions.sections.existing, "Keep this instruction.");
	assert.equal(event.systemPromptOptions.sections.eregion_butler_persona, BUTLER_PERSONA_PROMPT);
	assert.match(BUTLER_PERSONA_PROMPT, /English\s+butler/i);
	assert.match(BUTLER_PERSONA_PROMPT, /proactive personal AI assistant/i);
	assert.match(BUTLER_PERSONA_PROMPT, /Anticipate sensible next steps/i);
	assert.match(BUTLER_PERSONA_PROMPT, /good-natured sarcasm/i);
	assert.match(BUTLER_PERSONA_PROMPT, /every appropriate\s+interaction/i);
	assert.match(BUTLER_PERSONA_PROMPT, /formal English/i);
});
