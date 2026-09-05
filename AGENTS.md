# Skilloom

## Agent workflow

- Follow the user's requested outcome through implementation and relevant verification when they ask for a change. A request to review or explain stays read-only unless it also authorizes fixes. Reuse decisions and authorization already given in the conversation.
- Inspect discoverable facts and make routine, reversible implementation choices. Ask only for unresolved decisions that materially affect scope, behavior, risk, or external actions; continue independent authorized work while waiting. Prepare a concrete result before seeking any remaining release approval.
- Use skills that materially help the task. These repository workflow rules take precedence over generic skill process defaults, subject to system/developer instructions and the user's request. Skill discovery, a planning template, or a finishing menu must not create an extra approval gate. If a skill blocks progress, cite its exact file and instruction and explain the unresolved requirement.
- Scale planning to the work. Use a short internal plan for a clear change; write a durable plan for meaningful sequencing, contracts, migrations, or long work. An authorized implementation task continues after planning. Keep changes cohesive and preserve unrelated work; add abstractions only for a current requirement or demonstrated consumer.
- When delegation is available and permitted by the session, use bounded specialists for independent work that benefits from parallel execution or fresh review. Keep one lead responsible for integration and final evidence. Give writers separate ownership and reviewers distinct questions. Reuse passing checks and stop review when requested risks are covered; repeat only for relevant changes or unresolved findings.
- Match verification to the claim. Use relevant tests and required CI for code; inspect or render documentation, copy, and visual changes as appropriate. Do not add tests that only restate the edit or repeat passing checks on unchanged inputs. Keep product-specific security, data, and release gates.
- Report the outcome, evidence, and remaining limits concisely. Identify the checked revision and environment when they matter. For long reviews, save detailed findings to a linked artifact. A running server, empty screen, queued job, or green build alone does not prove a requested user flow or deployment succeeded.

## Project context

Skilloom reconciles global and project Agent Skills through the skills CLI. Read `README.md`, `CONTEXT.md`, and `CONTRIBUTING.md` for the current product boundaries and development workflow. Use the scripts in `package.json`; scope tests to the changed behavior and complete the required CI checks.

Preserve machine/project identity and distinguish a catalog entry from verified installation or operation on the named machine. Configuration inspection is read-only; a request to inspect installed skills does not authorize installing, removing, or synchronizing them.
