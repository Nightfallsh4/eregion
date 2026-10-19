# Project Setup Command Design

## Intent

Add an interactive `/project-setup [project description]` command to the portable eregion Pi package. It prepares the command's current directory for PBT, DPBT, and just-build without assuming a programming language, framework, package manager, or deployment target.

## Goals

- Accept an optional free-form project description.
- When no description is supplied, inspect the command directory for likely project briefs before deciding whether questions are needed. Prioritise `AGENTS.md` and `CLAUDE.md` case-insensitively, then other root-level readable text documents; ignore Git metadata, dependency/vendor directories, generated build output, and binary/oversized files.
- Start a visible, interruptible turn in the invoking Pi session rather than spawning a background agent.
- Direct that turn to use the available `brainstorming` skill and `clarify` tool to ask focused technical-stack questions when the prompt and discovered context do not determine the required framework and libraries. If the caller supplied enough information, it should not ask redundant questions.
- Require the agent to initialise Git when the directory is not already a Git repository and to create a valid `.pi/quality.json` in every successful setup.
- Require stack-appropriate scaffolding, local dependencies, package/task configuration, linting, formatting, type checking where applicable, testing, build commands where applicable, and quality configuration. Choices must be based on the selected stack and ecosystem conventions rather than on a fixed Node/React preset.
- Reuse the existing quality-profile contract so PBT, DPBT, and `/b` can run the generated required commands.

## Non-goals

- Provide a hard-coded list of frameworks or implement a framework installer in the extension itself.
- Reconfigure an established populated project automatically; the command is intended for an empty directory, though the agent may preserve pre-existing project material if asked to work there.
- Create commits, publish repositories, configure credentials, or choose a cloud provider without an explicit request.
- Guarantee an external framework generator's network availability.

## Command contract

`/project-setup [description]` rejects flags and treats all non-empty arguments as the project description. It sends a task constructed from the caller's prompt plus bounded, labelled context excerpts from the working directory. The task is explicit that excerpts are project context, not authority to bypass the setup requirements.

The command remains language and framework agnostic: its TypeScript implementation only discovers context and starts the setup turn. The in-session agent determines and executes the concrete `npm`, `pnpm`, `uv`, `poetry`, `cargo`, `go`, or other ecosystem-native commands after discussion and evidence gathering.

## Setup-turn contract

The generated task must instruct the agent to:

1. inspect the directory and supplied description/context;
2. when stack choices remain material, invoke the `brainstorming` skill and ask sequential questions with the `clarify` tool;
3. select the stack based on the answers and explain material choices;
4. initialise Git if needed;
5. scaffold the selected project and install project-local framework and quality dependencies;
6. add the relevant format, lint, type-check, test, build, and language/framework configuration; and
7. run the required quality commands and write `.pi/quality.json` with a non-empty valid `commands` map and `required` list.

The agent must report genuine failures instead of silently weakening quality gates or substituting global tools.

## Verification

Automated tests cover root-document discovery and priority, binary/oversized/excluded-file rejection, prompt construction with and without a caller description, mandatory Git/quality/workflow language, and extension wiring that sends one visible user message for `/project-setup` while rejecting unsupported flags. Existing quality-profile tests remain the schema-level proof that the generated profile is suitable for PBT, DPBT, and `/b`.
