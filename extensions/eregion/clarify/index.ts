/**
 * Clarify Extension - Ask one or more clarifying questions with options
 *
 * The LLM calls the `clarify` tool with 1+ questions, each with 3-4 relevant
 * options. Users can pick an option or type a custom answer.
 *
 * Single question: simple option list
 * Multiple questions: tab navigation + submit review step
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClarifyOption {
	label: string;
	description?: string;
}

interface ClarifyQuestion {
	id: string;
	label: string;
	prompt: string;
	options: ClarifyOption[];
}

interface ClarifyAnswer {
	questionId: string;
	answer: string;
	wasCustom: boolean;
	index?: number;
}

interface ClarifyResult {
	questions: ClarifyQuestion[];
	answers: ClarifyAnswer[];
	cancelled: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option (e.g. 'Use a database')" }),
	description: Type.Optional(
		Type.String({ description: "Short clarification shown below the label (e.g. 'SQLite or PostgreSQL')" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier, e.g. 'scope', 'storage', 'auth'" }),
	prompt: Type.String({ description: "The clarifying question to ask the user" }),
	options: Type.Array(OptionSchema, {
		description: "3-4 relevant options the user can pick. A 'Custom answer' option is added automatically.",
	}),
});

const ClarifyParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more clarifying questions. For a single question, shows a simple list. For multiple, shows tab navigation.",
		minItems: 1,
	}),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function renderOption(
	lines: string[],
	add: (s: string) => void,
	theme: { fg: (color: string, text: string) => string; bg?: (color: string, text: string) => string },
	index: number,
	label: string,
	selected: boolean,
	description?: string,
	isCustom?: boolean,
) {
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const num = `${index + 1}. `;
	const color = selected ? "accent" : "text";
	const suffix = isCustom ? theme.fg("muted", " ✎") : "";
	add(`${prefix}${theme.fg(color, num + label)}${suffix}`);
	if (description) {
		add(`     ${theme.fg("muted", description)}`);
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function clarify(pi: ExtensionAPI) {
	pi.registerTool({
		name: "clarify",
		label: "Clarify",
		description:
			"Ask the user one or more clarifying questions with predefined options and a custom answer option. Use when you need to narrow down requirements, preferences, or decisions before proceeding.",
		promptSnippet: "Ask clarifying questions to the user",
		promptGuidelines: [
			"Use clarify when the task is ambiguous or requires user input on multiple dimensions.",
			"Provide 3-4 relevant, actionable options per question so the user can choose quickly.",
			"Do not ask questions that the agent can infer from context or existing code.",
		],
		parameters: ClarifyParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Cannot ask clarifying questions in non-interactive mode." }],
					details: {
						questions: params.questions,
						answers: [] as ClarifyAnswer[],
						cancelled: true,
					} as ClarifyResult,
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions provided." }],
					details: { questions: [], answers: [], cancelled: true } as ClarifyResult,
				};
			}

			const questions: ClarifyQuestion[] = params.questions.map((q) => ({
				id: q.id,
				label: q.id,
				prompt: q.prompt,
				options: q.options,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<ClarifyResult>((tui, theme, _kb, done) => {
				// ── State ──
				let currentTab = 0;
				let selectedIndex = 0;
				let customMode = false;
				let customQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, ClarifyAnswer>();

				// ── Editor for custom answer ──
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// ── Helpers ──
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function finish(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion() {
					return questions[currentTab] ?? null;
				}

				function optionsFor(question: (typeof questions)[0]) {
					const opts: Array<{ label: string; description?: string; isCustom?: boolean }> = [
						...question.options,
						{ label: "Custom answer", isCustom: true },
					];
					return opts;
				}

				function allAnswered() {
					return questions.every((q) => answers.has(q.id));
				}

				function answerCount() {
					let count = 0;
					for (const q of questions) {
						if (answers.has(q.id)) count++;
					}
					return count;
				}

				function recordAnswer(questionId: string, answer: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { questionId, answer, wasCustom, index });
				}

				function advanceTab() {
					if (!isMulti) {
						finish(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					selectedIndex = 0;
					refresh();
				}

				// ── Editor submit ──
				editor.onSubmit = (value) => {
					if (!customQuestionId) return;
					const trimmed = value.trim();
					recordAnswer(customQuestionId, trimmed || "(no response)", true);
					customMode = false;
					customQuestionId = null;
					editor.setText("");
					advanceTab();
				};

				// ── Input handling ──
				function handleInput(data: string) {
					// Custom answer editor mode
					if (customMode) {
						if (matchesKey(data, Key.escape)) {
							customMode = false;
							customQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter)) {
							if (allAnswered()) {
								finish(false);
							}
						} else if (matchesKey(data, Key.escape)) {
							finish(true);
						} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							if (allAnswered()) {
								finish(false);
							}
						} else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
							currentTab = questions.length - 1;
							selectedIndex = 0;
							refresh();
						}
						return;
					}

					// Question tabs navigation (multi)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							selectedIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							selectedIndex = 0;
							refresh();
							return;
						}
					}

					const q = currentQuestion();
					if (!q) return;

					const opts = optionsFor(q);

					// Navigation
					if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
						selectedIndex = Math.min(opts.length - 1, selectedIndex + 1);
						refresh();
						return;
					}

					// Number shortcuts: 1-9
					const num = parseInt(data, 10);
					if (!isNaN(num) && num >= 1 && num <= opts.length) {
						selectOption(num - 1, q);
						return;
					}

					// Select
					if (matchesKey(data, Key.enter) || matchesKey(data, " ")) {
						selectOption(selectedIndex, q);
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						finish(true);
					}
				}

				function selectOption(idx: number, q: (typeof questions)[0]) {
					const opts = optionsFor(q);
					const opt = opts[idx];
					if (!opt) return; // out of bounds

					if (opt.isCustom) {
						customMode = true;
						customQuestionId = q.id;
						editor.setText("");
						refresh();
					} else {
						recordAnswer(q.id, opt.label, false, idx + 1);
						advanceTab();
					}
				}

				// ── Render ──
				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					// Top border
					add(theme.fg("accent", "─".repeat(width)));

					// Title
					const title = isMulti ? `Clarify (${answerCount()}/${questions.length})` : "Clarify";
					add(theme.fg("text", theme.bold(` ${title}`)));
					lines.push("");

					// Tab bar for multi-question
					if (isMulti) {
						const tabParts: string[] = [];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const dot = isAnswered ? "●" : "○";
							const label = `${dot} ${questions[i].label}`;
							if (isActive) {
								tabParts.push(
									theme.bg("selectedBg", theme.fg("text", ` ${label} `)),
								);
							} else {
								const color = isAnswered ? "success" : "dim";
								tabParts.push(theme.fg(color, ` ${label} `));
							}
						}
						// Submit tab
						const isSubmitTab = currentTab === questions.length;
						const submitLabel = `✓ Submit`;
						if (isSubmitTab) {
							tabParts.push(
								theme.bg("selectedBg", theme.fg("text", ` ${submitLabel} `)),
							);
						} else {
							tabParts.push(
								theme.fg(allAnswered() ? "success" : "dim", ` ${submitLabel} `),
							);
						}
						add(tabParts.join(""));
						lines.push("");
					}

					// ── Content ──
					if (currentTab === questions.length) {
						// Submit review
						add(theme.fg("text", theme.bold(" Review your answers")));
						lines.push("");
						for (const q of questions) {
							const a = answers.get(q.id);
							if (a) {
								add(`  ${theme.fg("accent", q.label + ":")}`);
								const display = a.wasCustom
									? `${theme.fg("muted", "(custom) ")}${theme.fg("text", a.answer)}`
									: `${theme.fg("text", `${a.index}. ${a.answer}`)}`;
								add(`    ${display}`);
							} else {
								add(`  ${theme.fg("accent", q.label + ":")} ${theme.fg("warning", "(unanswered)")}`);
							}
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", "  Press Enter to confirm answers"));
						} else {
							add(theme.fg("warning", "  Answer all questions to proceed"));
						}
					} else if (customMode) {
						// Custom answer editor
						const q = currentQuestion();
						if (q) {
							add(theme.fg("text", ` ${q.prompt}`));
							lines.push("");
							add(theme.fg("muted", "  Options for reference:"));
							const opts = optionsFor(q);
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const mark = opt.isCustom ? theme.fg("muted", "○") : theme.fg("dim", "○");
								const label = opt.isCustom ? `${opt.label} ✎` : opt.label;
								add(`  ${mark} ${theme.fg("dim", label)}`);
								if (opt.description) {
									add(`     ${theme.fg("dim", opt.description)}`);
								}
							}
							lines.push("");
							add(theme.fg("accent", "  Your answer:"));
							for (const line of editor.render(width - 4)) {
								add(`    ${line}`);
							}
						}
					} else {
						// Question with options
						const q = currentQuestion();
						if (q) {
							add(theme.fg("text", ` ${q.prompt}`));
							lines.push("");
							const opts = optionsFor(q);
							for (let i = 0; i < opts.length; i++) {
								const opt = opts[i];
								const selected = i === selectedIndex;
								renderOption(lines, add, theme, i, opt.label, selected, opt.description, opt.isCustom);
							}
						}
					}

					// ── Footer ──
					lines.push("");
					if (customMode) {
						add(theme.fg("dim", " Enter to submit custom answer  ·  Esc to go back"));
					} else if (currentTab === questions.length) {
						const hint = allAnswered()
							? " Enter to submit  ·  ← go back  ·  Esc cancel"
							: " ← / → navigate tabs  ·  Esc cancel";
						add(theme.fg("dim", hint));
					} else {
						const nav = isMulti ? " Tab/←→ navigate  ·  " : "";
						add(theme.fg("dim", `${nav}↑↓/jk navigate  ·  1-9 number shortcut  ·  Enter select  ·  Esc cancel`));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// ── Build result ──
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the clarifying questions." }],
					details: result,
				};
			}

			const summary = result.answers
				.map((a) => {
					const q = questions.find((q) => q.id === a.questionId);
					const label = q?.label ?? a.questionId;
					if (a.wasCustom) {
						return `${label}: "${a.answer}" (custom)`;
					}
					return `${label}: ${a.index}. ${a.answer}`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: `Clarified:\n${summary}` }],
				details: result,
			};
		},

		// ── Custom Rendering ──

		renderCall(args, theme, _context) {
			const qs = (args.questions as ClarifyQuestion[]) ?? [];
			const count = qs.length;
			const labels = qs.map((q) => q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("✨ clarify "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			text += theme.fg(
				"dim",
				labels ? ` (${truncateToWidth(labels, 40)})` : "",
			);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as ClarifyResult | undefined;
			if (!details) {
				const txt = result.content[0];
				return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const q = details.questions.find((q) => q.id === a.questionId);
				const label = q?.label ?? a.questionId;
				const prefix = a.wasCustom
					? `${theme.fg("accent", "✎")} ${theme.fg("muted", label + ":")} `
					: `${theme.fg("success", "✓")} ${theme.fg("accent", label + ":")} `;
				const answer = a.wasCustom
					? theme.fg("text", a.answer)
					: theme.fg("text", `${a.index}. ${a.answer}`);
				return prefix + answer;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
