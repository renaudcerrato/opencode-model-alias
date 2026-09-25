# opencode-model-alias

[![License: MIT](https://img.shields.io/github/license/mattaschmann/opencode-model-alias)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode](https://opencode.ai) plugin for machine-specific model aliases. Multiple agents can share an alias, so changing its target in one place switches them together. Supports variants, alias chains, and OpenCode V1 and V2.

> **Note:** This is a fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias) — all credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann) (see [Credits](#creditinspirations)). Not built by the OpenCode team and not affiliated with OpenCode in any way.

## Installation

### OpenCode V2

Install the published plugin globally:

```sh
opencode plugin add @renaudcerrato/opencode-model-alias@2.0.0
```

To bind agents to aliases, replace the plugin entry added by the CLI in your global `~/.config/opencode/opencode.jsonc` with the object form below. Merge these fields into your existing config rather than replacing unrelated settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@renaudcerrato/opencode-model-alias@2.0.0",
    "options": { "agents": { "reviewer": "cheap", "planner": "cheap" } }
  }],
  "agents": {
    "reviewer": { "description": "Reviews changes", "system": "Review the work." },
    "planner": { "description": "Plans work", "system": "Plan the work." }
  }
}
```

Define `cheap` in your [local alias file](#alias-file-location) and restart OpenCode. Keep only one entry for this plugin: `opencode plugin add` registers the package but does not supply its `options.agents` bindings.

### OpenCode V1

For OpenCode V1 (1.18.29 or later), add the plugin to your OpenCode config (`opencode.jsonc`), pinned to a version:

```json
{
  "plugin": ["@renaudcerrato/opencode-model-alias@2.0.0"]
}
```

OpenCode resolves and installs npm plugin references automatically on startup — no manual install step. Pinning the version is recommended: it guarantees the plugin behavior stays identical across machines until you choose to upgrade.

<details>
<summary>Alternative: install from source (V1)</summary>

Clone the repo to a local workspace:

```sh
git clone https://github.com/renaudcerrato/opencode-model-alias.git ~/workspace/opencode-model-alias
```

Then reference the local path in your OpenCode config (`opencode.jsonc`):

```json
{
  "plugin": ["~/workspace/opencode-model-alias"]
}
```

</details>

## Usage

### Configure agents (V2)

Bind agents to an alias through `options.agents`, as in the [V2 installation example](#opencode-v2).

Define `cheap` in the local [alias file](#alias-file-location). Changing that one target switches both agents, even across providers. Leave `model` out of bound agent definitions: an explicit model can override the plugin's in-memory assignment. V2 does not resolve aliases in command model fields or the default model; use direct `provider/model` identifiers there. An explicit command model takes precedence over its agent's model.

### The `/alias` Command

Manage aliases with the same commands on V1 and V2:

```text
# List all aliases
/alias list

# Set a new alias
/alias set cheap openai/gpt-4o-mini

# Set an alias with a model variant
/alias set smart ollama-cloud/glm-5.3-flash max

# Delete an alias
/alias delete cheap

# Show help
/alias help
```

> **Important:** Restart OpenCode after adding, updating, or deleting aliases so the new mappings load into your session.

In V2, run `/alias` in OpenChamber/Desktop. The plugin command uses one agent turn to return feedback; it is not a client-only TUI command.

> **V2 behavior note:** The command result is passed directly to an ordinary tool-capable model turn, without any additional prompt instructions. Alias data comes from the local, user-controlled file; the prompt is not a security boundary. Only the first 1,200 characters of the result are passed to that turn, so a long `/alias list` may omit later entries from its feedback.

### Using aliases in V1

OpenCode V1 (1.18.29+) resolves aliases in configured agent and command model fields:

```json
{
  "agent": {
    "my-agent": {
      "model": "cheap"
    }
  },
  "command": {
    "my-command": {
      "model": "cheap"
    }
  }
}
```

Or in V1 agent markdown frontmatter:

```markdown
---
description: Some agent
mode: subagent
model: cheap
---
```

### Alias Definitions

Aliases live in `model-aliases.json` (see [Alias File Location](#alias-file-location)). Two forms are supported:

**String form** — maps an alias to a model or another alias:

```json
{
  "cheap": "openai/gpt-4o-mini",
  "reviewer": "cheap"
}
```

**Object form** — selects a direct model and an optional variant:

```json
{
  "smart": {
    "model": "ollama-cloud/glm-5.3-flash",
    "variant": "max"
  }
}
```

Rules:

- The object form's `model` must be a **direct `provider/model` identifier** — it cannot reference another alias. Use the string form for alias-to-alias references.
- The optional `variant` must be listed in the model's provider metadata; `/alias set` validates this and rejects unsupported variants, listing the supported ones.
- Setting an alias without a variant removes any previous variant (complete replacement).
- String alias chains inherit the variant of the nearest object-form entry in their resolution chain.
- In V1, an alias-provided variant overrides a configured agent or command variant. In V2, it is assigned to bound agents.
- Chains support up to 16 hops; cycles are rejected.
- Deleting an alias that other aliases chain through is refused — the error names the dependent aliases. Delete those first, or bypass the check with `alias delete <key> force`.
- In V1, alias keys **shadow model references**: an agent/command `model` matching an alias key is always resolved through it, even if it looks like a `provider/model` identifier. Avoid naming aliases after real model ids.

For example, with `"reviewer": "cheap"` and `"cheap": { "model": "openai/gpt-4o-mini", "variant": "max" }`, `reviewer` inherits variant `max`. `/alias list` shows the full chain.

### Alias File Location

The alias file lives at `~/.config/opencode/model-aliases.json` by default. It uses `OPENCODE_CONFIG_DIR` when set, otherwise `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set.

The alias file is not created at startup. `/alias set` creates the config directory if needed and writes the file.

The file format and path are the same for V1 and V2. The same `cheap` alias can target different providers on different machines:

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

1. Keep `model-aliases.json` at the same path; its JSON syntax does not change.
2. Replace the V1 `plugin` entry with the V2 `plugins` object and add agent-to-alias bindings under `options.agents` (see [Configure agents (V2)](#configure-agents-v2)).
3. Remove `model` from each bound V2 agent definition. V2 command model fields and default models are not automatically aliased; replace alias values there with direct `provider/model` identifiers. Explicit command models continue to override agent models.
4. Restart OpenCode after updating the plugin configuration or aliases.

The plugin does not rewrite user configuration during migration. V1 and V2 use different plugin APIs; V2 behavior is not a drop-in equivalent for V1 command-model aliasing.

## Development

```sh
npm install
npm test        # jest with coverage
npm run typecheck
```

## References

- [OpenCode V2 Plugins Documentation](https://opencode.ai/v2/docs/build/plugins)
- [GitHub Issue #3439](https://github.com/anomalyco/opencode/issues/3439)

## Credit/Inspirations

- [Matt Aschmann](https://github.com/mattaschmann) — original author of [opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias), which this fork builds on (MIT)
- https://gist.github.com/krystofrezac/7f16ba252279f889eb750a866b257a1d
- https://github.com/toninho09/opencode-usage

## License

[MIT](LICENSE) © Matt Aschmann; fork changes © Renaud Cerrato
