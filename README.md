# opencode-model-alias

[![License: MIT](https://img.shields.io/github/license/mattaschmann/opencode-model-alias)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-model-alias/actions/workflows/test.yml)

> **Note:** This project is not built by the OpenCode team and is not affiliated with OpenCode in any way.

[OpenCode](https://opencode.ai) plugin that allows users to define model aliases for consistent use across machines — with support for **model variants**, **alias chains**, and **fail-closed validation**.

> **Fork notice:** This is a hardened fork of [mattaschmann/opencode-model-alias](https://github.com/mattaschmann/opencode-model-alias). All credit for the original idea and implementation goes to [Matt Aschmann](https://github.com/mattaschmann); see [Credits](#creditsinspirations). This fork adds model-variant presets, recursive alias chains with cycle/depth protection, fail-closed error handling, atomic writes, and config-directory detection.

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
  "contextscout": "cheap"
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
- The optional `variant` must be listed in the model's provider metadata; `/alias set` validates this and fails closed, listing the supported variants on rejection.
- String alias chains inherit the variant of the nearest outer object-form entry in their resolution chain.
- An alias-provided variant **overrides** any variant configured on the agent or command.
- Chains support up to 16 hops; cycles are rejected.

### The `set` Command with Variants

```bash
# Set an alias with a variant (object form is written)
/alias set smart ollama-cloud/glm-5.3-flash max

# Setting without a variant removes any previous variant (complete replacement)
/alias set smart ollama-cloud/glm-5.3-flash

# Variants cannot be combined with alias targets
/alias set reviewer smart max
# Error: variant 'max' cannot be applied to alias target 'smart'
```

An unsupported variant is rejected with the list of supported ones:

```
Error: variant 'turbo' is not listed for model 'ollama-cloud/glm-5.3-flash'. Supported variants: low, max.
```

### Alias File Location

The alias file is resolved the same way OpenCode resolves its own global config directory:

1. `OPENCODE_CONFIG_DIR` environment variable (used as the config directory itself), if set
2. `$XDG_CONFIG_HOME/opencode`, if `XDG_CONFIG_HOME` is set
3. `~/.config/opencode` (default)

The plugin reads `model-aliases.json` from that directory. It does **not** create the file or directory implicitly — the file is only written when you set or delete an alias via `/alias`.

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
  "contextscout": "cheap",
  "externalscout": "cheap"
}
```

### Fail-Closed Behavior

The plugin never guesses:

- An unreadable or invalid alias file produces an explicit `Error: ...` for `/alias` commands; nothing is written.
- Malformed alias definitions (missing `model`, non-string `variant`, unknown fields, object-form entries pointing at other aliases) are rejected.
- `/alias set` verifies targets against the provider list and validates variants against provider metadata before writing.
- Writes are atomic (temp file + rename) with a concurrent-modification check.
- At startup, an unreadable alias file is tolerated (aliases are simply not applied) so a broken file never prevents OpenCode from launching.

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