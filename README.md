# opencode-model-alias

[![License: MIT](https://img.shields.io/github/license/mattaschmann/opencode-model-alias)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode](https://opencode.ai) plugin that lets you define model aliases for consistent use across machines — with support for **model variants**, **alias chains**, and both the V1 and V2 plugin APIs. Alias configuration differs between the two APIs.

> **Note:** This is a fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias) — all credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann) (see [Credits](#creditinspirations)). Not built by the OpenCode team and not affiliated with OpenCode in any way.

## Contents

- [Installation](#installation)
- [Why This Plugin?](#why-this-plugin)
- [Usage](#usage)
  - [V1 and V2 Compatibility](#v1-and-v2-compatibility)
  - [The `/alias` Command](#the-alias-command)
  - [Using Aliases](#using-aliases)
  - [Alias Definitions](#alias-definitions)
  - [Alias Chains](#alias-chains)
  - [Alias File Location](#alias-file-location)
  - [Migrate from V1 to V2](#migrate-from-v1-to-v2)
- [Development](#development)
- [References](#references)
- [Credit/Inspirations](#creditinspirations)
- [License](#license)

## Installation

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

## Why This Plugin?

When you share OpenCode agents or commands across computers, the model available on one machine may not be available on another. A stable alias lets each machine choose its own provider/model target.

### The Problem

For example, a V1 custom command can specify a machine-specific model directly:

```json
{
  "command": {
    "my-command": {
      "model": "openai/gpt-4o-mini"
    }
  }
}
```

If you share this command with a colleague who uses Anthropic, or if you switch to a different provider on another computer, you need to manually update the model in your config. This becomes tedious and error-prone as you accumulate more commands.

### The Solution

With aliases, you can use a consistent identifier in V1 agent and command model fields, or bind V2 agents to an alias. The alias file stays local to each machine:

1. **In your shared config:** Use the alias

   ```json
   {
     "command": {
       "my-command": {
         "model": "cheap"
       }
     }
   }
   ```

2. **On each machine:** Define the alias in `~/.config/opencode/model-aliases.json`
   ```json
   {
     "cheap": "openai/gpt-4o-mini"
   }
   ```

V1 resolves aliases in configured `agent.*.model` and `command.*.model` fields. V2 applies aliases only to agents listed in the plugin's `options.agents` map; see [V1 and V2 Compatibility](#v1-and-v2-compatibility). In both cases, each computer maps the same alias to a model available on that machine.

Aliases can also **chain** — an alias pointing at another alias — so you can define stable role names (like `reviewer`) on top of machine-specific model mappings (see [Alias Chains](#alias-chains)).

## Usage

### V1 and V2 Compatibility

The plugin supports both OpenCode plugin API generations, but their hooks and alias behavior are different:

| OpenCode API | Plugin registration | Where aliases apply |
| --- | --- | --- |
| V1 (1.18.29+) | `plugin` array | Configured `agent.*.model` and `command.*.model` values |
| V2 | `plugins` array of objects | Only agents explicitly bound in `options.agents` |

V2 example (`opencode.jsonc`):

```json
{
  "plugins": [
    {
      "package": "@renaudcerrato/opencode-model-alias@2.0.0",
      "options": {
        "agents": {
          "reviewer": "cheap",
          "planner": "cheap"
        }
      }
    }
  ],
  "agents": {
    "reviewer": { "description": "Reviews changes", "system": "Review the work." },
    "planner": { "description": "Plans work", "system": "Plan the work." }
  }
}
```

Leave `model` out of each bound V2 agent definition so the alias can supply it; an explicit agent model can take precedence. The plugin transforms those agent models in memory and does not edit your config files. V2 does **not** automatically resolve aliases in command model fields or default models. Use direct `provider/model` identifiers for those settings. A command's explicitly configured model takes precedence over its agent's model.

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

### Using Aliases

#### V1 agent and command models

In V1, use aliases in configured agent and command model fields (for example, in `~/.config/opencode/opencode.json`):

```json
{
  "agent": {
    "my-agent": {
      "model": "cheap"
    }
  },
  "command": {
    "my-command": {
      "model": "expensive"
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

The V1 config hook resolves these aliases from the alias file before use. V2 uses the `options.agents` binding shown above instead of alias-valued `agent.model` fields; command model fields are not aliased in V2.

### Alias Definitions

Aliases live in `model-aliases.json` (see [Alias File Location](#alias-file-location)). Two forms are supported:

**String form** — maps an alias to a model or to another alias:

```json
{
  "cheap": "openai/gpt-4o-mini",
  "reviewer": "cheap"
}
```

**Object form** — a complete preset with an optional model variant:

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
- Where aliases are applied, an alias-provided variant **overrides** the configured variant (V1 agent/command models and V2 bound agents).
- Chains support up to 16 hops; cycles are rejected.
- Deleting an alias that other aliases chain through is refused — the error names the dependent aliases. Delete those first, or bypass the check with `alias delete <key> force`.
- In V1, alias keys **shadow model references**: an agent/command `model` matching an alias key is always resolved through it, even if it looks like a `provider/model` identifier. Avoid naming aliases after real model ids.

### Alias Chains

A string alias can point at **another alias** instead of a model. When OpenCode resolves a model reference, it follows the chain until it reaches a real model — so you can layer aliases on top of each other:

```json
{
  "cheap": {
    "model": "openai/gpt-5.6-luna",
    "variant": "max"
  },
  "reviewer": "cheap",
  "researcher": "cheap"
}
```

Here `reviewer` and `researcher` both resolve to `openai/gpt-5.6-luna` with variant `max`:

```
reviewer → cheap → openai/gpt-5.6-luna [max]
researcher → cheap → openai/gpt-5.6-luna [max]
```

This is the portability story one level deeper: `cheap` is the machine-specific mapping, while `reviewer` and `researcher` are stable role names your V1 agents/commands or V2 bound agents can use. Switch this machine to a different model by changing **one line** — every role alias follows. `/alias list` shows the full chain for each alias, including the inherited variant.

Chains can be several hops deep (`a → b → c → provider/model`), which is handy for progressive refinement — e.g. a generic `fast` alias, a team-level `reviewer → fast`, and a personal override on top. Two guardrails keep chains sane: resolution stops after **16 hops**, and **cycles are rejected**. Deleting an alias that others chain through is refused (see the rules above) so a chain is never silently broken.

### Alias File Location

The alias file lives at `~/.config/opencode/model-aliases.json` by default. It uses `OPENCODE_CONFIG_DIR` when set, otherwise `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set.

The alias file is not created at startup. `/alias set` creates the config directory if needed and writes the file.

The JSON format and path are the same for V1 and V2. Keep the alias name stable and point it at a model available on each machine. For example, V2 agents `reviewer` and `planner` can both use `cheap`, while each machine maps it to a different provider:

Workstation A:

```json
{ "cheap": "openai/gpt-4o-mini" }
```

Workstation B:

```json
{ "cheap": "ollama-cloud/glm-5.3-flash" }
```

Each model target must be available from a provider configured on that machine.

Example `model-aliases.json`:

```json
{
  "cheap": {
    "model": "openai/gpt-5.6-luna",
    "variant": "max"
  },
  "genius": {
    "model": "openai/gpt-5.6-sol"
  },
  "smart": {
    "model": "ollama-cloud/glm-5.3-flash",
    "variant": "max"
  },
  "reviewer": "cheap",
  "researcher": "cheap"
}
```

### Migrate from V1 to V2

1. Keep `model-aliases.json` at the same path; its JSON syntax does not change.
2. Replace the V1 `plugin` entry with the V2 `plugins` object and add agent-to-alias bindings under `options.agents` (see the example above).
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

- [OpenCode Plugins Documentation](https://opencode.ai/docs/plugins/)
- [GitHub Issue #3439](https://github.com/anomalyco/opencode/issues/3439)

## Credit/Inspirations

- [Matt Aschmann](https://github.com/mattaschmann) — original author of [opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias), which this fork builds on (MIT)
- https://gist.github.com/krystofrezac/7f16ba252279f889eb750a866b257a1d
- https://github.com/toninho09/opencode-usage

## License

[MIT](LICENSE) © Matt Aschmann; fork changes © Renaud Cerrato
