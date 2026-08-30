/**
 * OpenCode model aliases — server plugin.
 *
 * Resolves model aliases in agent/command configs at startup. The `/alias`
 * command itself lives in the TUI plugin (src/tui.tsx): a dialog-driven UI
 * that manages the alias file without touching the session, so no agent
 * turn is triggered.
 *
 * See alias-core.ts for the alias file format and resolution rules.
 */

import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import { resolveConfigAliases } from "./alias-core.js";

export const aliasPlugin: Plugin = async () => {
	return {
		config: async (opencodeConfig: Config) => {
			// Alias resolution assigns into the host's config object. A frozen
			// config must not crash the hook (and with it OpenCode startup), so
			// tolerate assignment failures and resolve what we can.
			try {
				resolveConfigAliases(opencodeConfig);
			} catch {
				// resolveConfigAliases already tolerates unreadable alias files;
				// this guards against unexpected host config shapes.
			}
		},
	};
};

export const server = aliasPlugin;

const pluginModule: PluginModule = {
	id: "opencode-model-alias",
	server,
};

export default pluginModule;