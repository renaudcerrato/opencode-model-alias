# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-08-30

### Added
- Dual-target plugin: `./server` (config-hook alias resolution) and `./tui` (dialog-driven `/alias` command) from one package, installable with a single `opencode plugin install` (patches both `opencode.json` and `tui.json`).
- TUI `/alias` command: dialog menu (List / Set / Delete / Help) that manages the alias file entirely client-side — no session interaction, no agent turn, no transcript pollution.
- Set flow prompts for name, `provider/model`, and optional variant, validating against the provider list before writing; delete flow refuses to break chains.

### Changed
- The server plugin no longer registers a `/alias` server command: server-side slash commands always trigger an agent LLM turn (OpenCode's command pipeline calls the prompt loop unconditionally), so the command moved to the TUI where it can reply without one.
- `package.json` exports `./server` and `./tui`; `main` removed (the loader resolves targets exclusively via `exports` when present).

## [1.1.0] - 2026-08-29

### Added
- Object alias form `{ "model": "provider/model", "variant": "..." }` alongside legacy string aliases.
- Model variants: validated against provider metadata at set time (fail-closed, with supported-variants hint); alias-provided variants override agent/command-configured variants.
- Recursive alias chains (up to 16 hops) with cycle detection; string aliases inherit the variant of the nearest outer object-form entry.
- Fail-closed reads: invalid/unreadable alias files produce explicit errors for `/alias` commands; startup stays tolerant.
- Atomic writes (temp file + rename, mode 0600) with concurrent-modification checks on both `set` and `delete`.
- Config directory resolution mirroring OpenCode: `OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`.
- `/alias set <key> <provider/model> [variant]` with single provider-list fetch per set.
- Test suite: 182 tests with fs mocks; CI test workflow with coverage summary.

### Changed
- `/alias list` now shows the effective (own or inherited) variant per alias.
- Object-form `model` values are validated as `provider/model` identifiers at read time.
- CI: actions pinned by SHA, least-privilege `permissions`, coverage summary from a single test run.
- Simplified provider verification: a single `fetchProviders` callback replaces the dual probe/list path; an empty provider list fails closed.
- Coverage enforced at 100% (statements/branches/functions/lines); README badges auto-updated by CI.
- `/alias delete <key> [force]`: deleting an alias referenced by other aliases is refused (naming the dependents) unless `force` is given, so chains are never silently broken; unexpected extra arguments to `delete` are now rejected instead of ignored.
- `/alias help` documents the `force` flag.

### Fixed
- `writeAliases` no longer corrupts alias-to-alias chains: entries without a variant are serialized in string form (the normalized object form was rejected by the reader on the next command, making the file unreadable after any `set`/`delete` on a chained file).
- A leading UTF-8 BOM in the alias file is tolerated (Windows editors and PowerShell emit one); previously every alias silently stopped working.
- A zero-byte or whitespace-only alias file is treated as "no aliases yet" instead of a parse error.
- Whitespace-only `variant` values in hand-edited files are rejected, matching set-time validation.
- The config hook tolerates frozen/sealed configs and getter-only `model` fields instead of crashing startup.

## [1.0.5] - 2026-04-08

### Changed
- `/alias` help text now highlights the `!opencode models` command and reminds users to restart OpenCode after editing aliases so changes load into the session.

### Docs
- README now documents how to list available models and reiterates the need to restart OpenCode after alias updates.

## [1.0.3] - 2026-04-08

### Fixed
- Add LICENSE file to fix "license not found" badge in README

## [1.0.2] - 2026-04-08

### Changed
- Normalize `repository.url` in `package.json` to match npm expectations and avoid publish-time rewrites.

### CI
- Enable provenance statements and explicit public access when publishing via trusted publisher for more reliable npm releases.

## [1.0.1]

### Added
- Export plugin as PluginModule for OpenCode integration
- `/alias set <alias> <model>` command to create an alias
- `/alias list` command to show all aliases
- `/alias delete <alias>` command to remove an alias
- `/alias help` command for usage guidance
- Config hook to automatically resolve aliases in `agent.model` and `command.model` fields
- Jest test suite with 89% code coverage (21 tests)
- CI workflow with coverage badge generation
- npm publish workflow for automated releases

### Changed
- Update terminology from "skill" to "command" in documentation
- Refactor CI to use reusable workflow reference instead of duplicating jobs

### Fixed
- Jest settings for proper coverage collection
- Badge issues in documentation
- GitHub URL username typo in package.json

### Docs
- Add "Why This Plugin?" section explaining the problem/solution workflow
- Add badges (npm version, license, test coverage)
- Add markdown format alias usage examples
- Add OpenCode disclaimer to README
- Add AGENTS.md for AI agent guidance
- Add README.md with installation and usage instructions

### CI
- Add workflow_call trigger to enable reusable CI workflow
- Add npm publish workflow
