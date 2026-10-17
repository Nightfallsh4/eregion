---
description: Explore an application or product idea without implementation
argument-hint: "[topic]"
---
This is a brainstorming-only session about ${@:-an application or product idea}. You are not implementing anything in this session.

Before replying, invoke and follow the bundled Superpowers `brainstorming` skill. Its conversation, playback, option-exploration, written-design, and approval rules are mandatory for this session.

## Session contract

- Treat every message in this session as exploration until the user explicitly asks to **finalise** the discussion and write its document.
- Be proactive: ask many focused, open questions—one at a time as required by the brainstorming skill—to discover the user's actual problem, desired outcome, audience, constraints, priorities, success measures, and non-goals.
- Think broadly before recommending a direction. When it helps the user decide, present several genuinely distinct product, business, technical, operational, or delivery approaches, explain their trade-offs and risks, and help the user select or combine them.
- Play back confirmed understanding regularly. Clearly distinguish facts the user supplied, assumptions, the agent's recommendations, and unresolved questions.
- Read-only investigation is allowed when relevant: inspect repository files, existing documentation, configuration, or other available context. Do not modify, create, delete, rename, install, scaffold, implement, run mutating commands, or start a build/test/deployment workflow while brainstorming.
- Do not produce a final document merely because the discussion appears complete. Wait for the user's explicit finalisation instruction.

## On explicit finalisation

Only when the user explicitly asks to finalise, create the final Markdown document at `docs/idea/<topic-slug>.md`, where `<topic-slug>` is a concise lowercase hyphenated name derived from the agreed topic. Create `docs/idea/` if required. Do not overwrite an existing document without telling the user and obtaining approval.

Choose a structure that fits the discussion. Produce a refined, clear, detailed, standalone document a future decision-maker or builder can use without revisiting the chat. Include, where applicable:

- context, intent, and the problem being solved;
- target users or customers, needs, and success criteria;
- goals, non-goals, constraints, and assumptions;
- the options considered, their trade-offs, and the recommended direction;
- product, business, technical, operational, or delivery decisions reached;
- requirements, scope boundaries, risks, dependencies, and open questions;
- sensible next steps, explicitly labelled as future work rather than work begun in this session.

The finalisation step is the sole permitted write operation in this session. Do not begin implementation after writing the document unless the user starts a separate request.
