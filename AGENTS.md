# AGENTS.md - opencode-model-alias

References:
- https://agentsmd.io/agents-md-best-practices

## Project Overview

This is an OpenCode V2 plugin that maps aliases from `plugins[].options.aliases` to configured agent models. OpenCode V1 support remains documented in `V1.md` and retains the file-backed `/alias` command.

## Do

- Use TypeScript for all source files
- Use `@opencode-ai/plugin` for type definitions
- Keep `src/index.ts` as the main entry point
- Follow the existing code patterns in the plugin

## Don't

- Add unnecessary dependencies
- Use default exports for anything other than the main plugin
- Make large speculative changes without confirming with user

## Commands

- `npm test` - Run Jest with coverage (100% thresholds)
- `npm run typecheck` - Type check the TypeScript plugin

## Project Structure

- `src/index.ts` - V1 and V2 plugin implementations, alias parsing and resolution
- `package.json` - Project metadata and dependencies
- `tsconfig.json` - TypeScript configuration
- `README.md` - V2 installation and usage
- `V1.md` - Legacy V1 installation and usage

## Testing

- Test agent-to-alias bindings through `options.agents` and `options.aliases`; bound agent definitions omit `model`.
- V2 reads `model-aliases.json` only when `options.aliases` is absent. V2 does not register `/alias`.
- V1 `/alias` and V1 agent/command model resolution are documented in `V1.md`.
- Run behavior tests and typecheck with the commands above; use an isolated V2 server config for host-level checks.

## When stuck

- Ask a clarifying question
- Propose a short plan before implementing
- Don't push large changes without confirmation
