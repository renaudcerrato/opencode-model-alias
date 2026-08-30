# opencode-model-alias

[![License: MIT](https://img.shields.io/github/license/mattaschmann/opencode-model-alias)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

> **Note:** This project is not built by the OpenCode team and is not affiliated with OpenCode in any way.

[OpenCode](https://opencode.ai) plugin that lets you define model aliases for consistent use across machines — with support for **model variants** and **alias chains**.

> **Fork notice:** This is a fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias). All credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann); see [Credits](#creditsinspirations). This fork adds model variants and alias chains.

> **Fork notice:** This is a fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias). All credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann); see [Credits](#creditsinspirations). This fork adds model variants and alias chains.

## Contents

- [Installation](#installation)
- [Why This Plugin?](#why-this-plugin)
- [Usage](#usage)
  - [The `/alias` Command](#the-alias-command)
  - [Using Aliases](#using-aliases)
  - [Alias Definitions](#alias-definitions)
  - [Alias File Location](#alias-file-location)
- [Development](#development)
- [References](#references)
- [Credit/Inspirations](#creditsinspirations)
- [License](#license)

## Installation

Clone the repo to a local workspace:

```sh
git clone https://github.com/renaudcerrato/opencode-model-alias.git ~/workspace/opencode-model-alias
```

Then add the plugin to your OpenCode config (`opencode.jsonc`):

```json
{
  "plugin": ["~/workspace/opencode-model-alias"]
}
```

## Why This Plugin?

When you create custom skills, agents, or commands in OpenCode, you can specify which model to use. However, sharing these configurations across multiple computers is problematic because each machine may use different models.

### The Problem

Imagine you have a custom command that uses GPT-4o Mini for cost efficiency:

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

With model aliases, you can use a consistent identifier across machines:

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

Now your command configuration is portable, and each computer maps "cheap" to whatever model that machine prefers.

## Usage

### The `/alias` Command

Manage model aliases directly from OpenCode:

```bash
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

# Show available models in correct format
!opencode models
```

Tip: type `!opencode models` in the TUI to list the currently available models in the correct provider/model format.

> **Important:** Restart OpenCode after adding, updating, or deleting aliases so the new mappings load into your session.

### Using Aliases

In your OpenCode config (e.g., `~/.config/opencode/opencode.json`):

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

Or in markdown format:

```markdown
---
description: Some agent
mode: subagent
model: cheap
---
```

The plugin automatically resolves these aliases by looking up the model in your alias file.

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
- An alias-provided variant **overrides** any variant configured on the agent or command.
- Chains support up to 16 hops; cycles are rejected.
- Deleting an alias that other aliases chain through is refused — the error names the dependent aliases. Delete those first, or bypass the check with `alias delete <key> force`.
- Alias keys **shadow model references**: an agent/command `model` matching an alias key is always resolved through it, even if it looks like a `provider/model` identifier. Avoid naming aliases after real model ids.

### Alias File Location

The alias file lives next to your OpenCode config — `~/.config/opencode/model-aliases.json` by default, or in the directory set by `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`, matching how OpenCode resolves its own global config.

The plugin does **not** create the file or directory implicitly — the file is only written when you set or delete an alias via `/alias`.

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