# Contributing

Install dependencies with `npm install`. Production behavior starts with a failing Vitest test. Keep upstream `skills` parsing and command construction inside `src/adapters/skills.ts` so CLI changes do not leak into the resolver.

Before opening a pull request, run:

```sh
npm run verify
git diff --check
git status --short
```

Tests must use temporary homes, repositories, and skill sources. Never point a test at the developer's global skill directory. Do not record credentials, absolute home paths, ANSI snapshots, or generated acceptance state.

`npm test` runs the unit and integration suite with Vitest under Node. Bun support is checked by executing the packaged CLI and interactive PTY flows under Bun, included in `npm run verify`. Native `bun test` is not a supported runner for this Vitest suite; its partial mock and assertion APIs differ.

Use the existing exit codes and JSON envelopes for public command behavior. Update the README and tests together when a command, schema, or output contract changes.
