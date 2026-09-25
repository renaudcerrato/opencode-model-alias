# opencode-model-alias

[![License: MIT](https://img.shields.io/github/license/mattaschmann/opencode-model-alias)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode](https://opencode.ai) V2 plugin for machine-specific model aliases. Multiple agents can share an alias, so changing its target in one place switches them together. Supports variants and alias chains. OpenCode V1 users: see the [legacy guide](V1.md).

> **Note:** This is a fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias) — all credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann) (see [Credits](#creditinspirations)). Not built by the OpenCode team and not affiliated with OpenCode in any way.

## Installation

Install the published plugin globally:

```sh
opencode plugin add @renaudcerrato/opencode-model-alias@2.1.0
```

To bind agents to aliases, replace the plugin entry added by the CLI in your global `~/.config/opencode/opencode.jsonc` with the object form below. Merge these fields into your existing config rather than replacing unrelated settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@renaudcerrato/opencode-model-alias@2.1.0",
    "options": {
      "aliases": { "cheap": "openai/gpt-4o-mini" },
      "agents": { "reviewer": "cheap", "planner": "cheap" }
    }
  }],
  "agents": {
    "reviewer": { "description": "Reviews changes", "system": "Review the work." },
    "planner": { "description": "Plans work", "system": "Plan the work." }
  }
}
```

Edit `options.aliases` to switch both agents. Keep only one entry for this plugin: `opencode plugin add` registers the package but does not supply its options.

## Usage

### Configure agents

Define machine-specific model targets in `options.aliases` and bind agents to them through `options.agents`, as in the [V2 installation example](#installation).

Changing `cheap` in the plugin options switches both agents, even across providers. OpenCode V2 reloads watched config changes; an already-selected session model may remain unchanged. Leave `model` out of bound agent definitions: an explicit model can override the plugin's in-memory assignment. V2 does not resolve aliases in command model fields or the default model; use direct `provider/model` identifiers there. An explicit command model takes precedence over its agent's model.

### Alias definitions

Define aliases inside `options.aliases`. String values name a direct model or another alias:

```json
{
  "cheap": "openai/gpt-4o-mini",
  "reviewer": "cheap"
}
```

Object values select a direct model and an optional variant:

```json
{
  "smart": {
    "model": "ollama-cloud/glm-5.3-flash",
    "variant": "max"
  }
}
```

Object `model` values must be direct `provider/model` identifiers, not alias names. String alias chains inherit the variant of their nearest object-form target and support at most 16 hops. With explicit `options.aliases`, an invalid bound alias or cycle fails plugin loading with a diagnostic; unbound aliases are not resolved. The plugin does not check whether a model or variant is available at setup, so an invalid selection may fail when an agent runs.

### Legacy file fallback

V2 reads the legacy [`model-aliases.json` file](V1.md#use-aliases-in-agents-and-commands) only when `options.aliases` is absent. An explicit `"aliases": {}` disables the fallback. Invalid bindings in the fallback file are skipped; malformed explicit options fail plugin loading instead. The file is not watched by this plugin, so restart OpenCode after manually editing it.

An alias in `options.aliases` can target different providers on different machines:

Workstation A:

```json
{ "cheap": "openai/gpt-4o-mini" }
```

Workstation B:

```json
{ "cheap": "ollama-cloud/glm-5.3-flash" }
```

Each target must be available from a provider configured on that machine.

### Migrate from V1 to V2

1. Keep the [V1 alias file](V1.md) as a read-only V2 fallback, or copy its entries into `options.aliases` in your V2 `opencode.jsonc`.
2. Replace the V1 `plugin` entry with the V2 `plugins` object and add agent-to-alias bindings under `options.agents` (see [Configure agents](#configure-agents)).
3. Remove `model` from each bound V2 agent definition. V2 command model fields and default models are not automatically aliased; replace alias values there with direct `provider/model` identifiers. Explicit command models continue to override agent models.
4. In V2, edit `options.aliases` instead of using `/alias`. Already-selected session models may keep their previous selection.

The plugin does not rewrite user configuration during migration. Removing `/alias` from V2 is a breaking change from 2.0.x; V1 command management remains available in the [legacy guide](V1.md).

## Development

```sh
npm install
npm test        # jest with coverage
npm run typecheck
```

## References

- [OpenCode V2 Plugins Documentation](https://opencode.ai/v2/docs/build/plugins)

## Credit/Inspirations

- [Matt Aschmann](https://github.com/mattaschmann) — original author of [opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias), which this fork builds on (MIT)
- https://gist.github.com/krystofrezac/7f16ba252279f889eb750a866b257a1d
- https://github.com/toninho09/opencode-usage

## License

[MIT](LICENSE) © Matt Aschmann; fork changes © Renaud Cerrato
