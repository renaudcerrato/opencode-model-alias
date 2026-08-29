/**
 * OpenCode model aliases.
 *
 * Define machine-specific model mappings in:
 *   ~/.config/opencode/model-aliases.json
 *
 * Example:
 *   {
 *     "cheap": "openai/gpt-4o-mini",
 *     "smart": { "model": "ollama-cloud/glm-5.3-flash", "variant": "max" }
 *   }
 *
 * A string value maps to a model or another alias. An object value is a
 * complete preset: `model` must be a direct `provider/model` identifier
 * (not another alias) and the optional `variant` must be listed in the
 * model's provider metadata. String aliases inherit the variant of the
 * nearest outer object-form entry in their resolution chain; an
 * alias-provided variant overrides any variant configured on the agent
 * or command.
 *
 * Manage aliases with `/alias list`, `/alias set <key> <provider/model> [variant]`,
 * `/alias delete <key>`, and `/alias help`. Use `!opencode models` to find
 * model identifiers in the correct `provider/model` format.
 *
 * Agent and command models support alias chains up to 16 hops. `/alias set`
 * resolves existing aliases from JSON and verifies missing targets against
 * known providers. It rejects unknown targets, cycles, and deeper chains.
 * Restart OpenCode after changing aliases.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

// Mirror opencode's own global-config resolution (packages/core/src/global.ts):
//   1. OPENCODE_CONFIG_DIR env var, if set
//   2. $XDG_CONFIG_HOME/opencode, falling back to ~/.config/opencode
// Whitespace-only values are treated as unset, matching opencode.
function resolveConfigDir(): string {
	const envDir = process.env.OPENCODE_CONFIG_DIR;
	if (envDir && envDir.trim() !== "") return envDir;
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	const base =
		xdgConfigHome && xdgConfigHome.trim() !== ""
			? xdgConfigHome
			: join(homedir(), ".config");
	return join(base, "opencode");
}

const CONFIG_DIR = resolveConfigDir();
const ALIAS_FILE = join(CONFIG_DIR, "model-aliases.json");
const MAX_ALIAS_DEPTH = 16;
const RIGHT_ARROW = " → ";

type AliasFailure = "cycle" | "depth";

type AliasTarget = {
	model: string;
	variant?: string;
};

type AliasEntry = string | AliasTarget;

type AliasMap = Record<string, AliasEntry>;

type AliasChain = {
	values: string[];
	failure?: AliasFailure;
};

type AliasResolution = {
	value: string | undefined;
	variant?: string;
	failure?: AliasFailure;
};

function parseAliasTarget(value: unknown, key: string): AliasTarget {
	if (typeof value === "string") {
		return { model: value };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(
			`alias '${key}' must be a string or an object with a 'model' field`,
		);
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.some((k) => k !== "model" && k !== "variant")) {
		throw new Error(`alias '${key}' accepts only 'model' and 'variant' fields`);
	}
	if (typeof record.model !== "string" || !record.model) {
		throw new Error(
			`alias '${key}' must have a non-empty string 'model' field`,
		);
	}
	if (
		record.variant !== undefined &&
		(typeof record.variant !== "string" || !record.variant)
	) {
		throw new Error(
			`alias '${key}' must have a non-empty string 'variant' field`,
		);
	}
	return { model: record.model, variant: record.variant };
}

function ensureConfigDir(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
}

function readAliases(): AliasMap {
	let raw: string;
	try {
		raw = readFileSync(ALIAS_FILE, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`alias file unreadable: ${ALIAS_FILE}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`alias file unreadable or invalid JSON: ${ALIAS_FILE}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("alias file must be a JSON object of alias definitions");
	}
	const result: AliasMap = {};
	for (const [key, value] of Object.entries(parsed)) {
		// defineProperty avoids the __proto__ setter for hand-edited files.
		Object.defineProperty(result, key, {
			value: parseAliasTarget(value, key),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	// Object-form entries must target a direct provider/model identifier,
	// not another alias, and the identifier must be well-formed. Check the
	// RAW parsed values: parseAliasTarget normalizes strings to { model },
	// which would false-positive the alias check here. String entries are
	// exempt from the format check — they may point at other aliases.
	for (const [key, rawValue] of Object.entries(parsed)) {
		if (
			typeof rawValue === "object" &&
			rawValue !== null &&
			!Array.isArray(rawValue)
		) {
			const model = (rawValue as Record<string, unknown>).model;
			if (typeof model !== "string") continue;
			if (hasAlias(result, model)) {
				throw new Error(
					`alias '${key}' must target a direct provider/model identifier, not another alias`,
				);
			}
			if (!isModelIdentifier(model)) {
				throw new Error(
					`alias '${key}' must target a direct provider/model identifier (got '${model}')`,
				);
			}
		}
	}
	return result;
}

function writeAliases(aliases: AliasMap): void {
	ensureConfigDir();
	const tmp = `${ALIAS_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		// 0o600: the file may name internal models; keep it owner-only.
		writeFileSync(tmp, JSON.stringify(aliases, null, 2), { mode: 0o600 });
		renameSync(tmp, ALIAS_FILE);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

function hasAlias(aliases: AliasMap, value: string): boolean {
	return Object.hasOwn(aliases, value);
}

function targetModel(entry: AliasEntry): string {
	return typeof entry === "string" ? entry : entry.model;
}

function targetVariant(entry: AliasEntry): string | undefined {
	return typeof entry === "string" ? undefined : entry.variant;
}

function getAliasChain(
	model: string | undefined,
	aliases: AliasMap,
): AliasChain {
	if (!model) return { values: [] };

	let current = model;
	const values = [current];
	const visited = new Set<string>();

	for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
		if (!hasAlias(aliases, current)) {
			return { values };
		}
		if (visited.has(current)) {
			return { values, failure: "cycle" };
		}
		if (depth === MAX_ALIAS_DEPTH) {
			return { values, failure: "depth" };
		}

		visited.add(current);
		current = targetModel(aliases[current]);
		values.push(current);
	}

	// Unreachable: the loop returns at depth === MAX_ALIAS_DEPTH. Kept to
	// satisfy the compiler's exhaustive-return check.
	return { values, failure: "depth" };
}

function resolveAliasDetails(
	model: string | undefined,
	aliases: AliasMap,
): AliasResolution {
	const chain = getAliasChain(model, aliases);
	if (chain.failure) {
		return { value: model, failure: chain.failure };
	}
	const terminal = chain.values[chain.values.length - 1] ?? model;
	// Variant inheritance: any object-form entry along the chain contributes
	// its variant; the outermost (nearest the reference site) wins.
	let variant: string | undefined;
	for (const node of chain.values) {
		if (hasAlias(aliases, node)) {
			const nodeVariant = targetVariant(aliases[node]);
			if (nodeVariant) {
				variant = nodeVariant;
				break;
			}
		}
	}
	return { value: terminal, variant };
}

/**
 * Resolve a model reference through the alias map (test/back-compat export;
 * internal code uses resolveAliasDetails, which also carries the variant).
 */
function resolveAlias(
	model: string | undefined,
	aliases: AliasMap,
): string | undefined {
	return resolveAliasDetails(model, aliases).value;
}

function isModelIdentifier(value: string): boolean {
	return /^[^/\s]+\/\S+$/.test(value);
}

type ModelConfig = { model?: unknown } & Record<string, unknown>;

// Apply alias resolution to one agent/command entry: rewrite the model to
// its terminal target and let an alias-provided variant win over the
// configured variant.
function applyAliasToEntry(
	entryConfig: ModelConfig,
	aliases: AliasMap,
): void {
	if (typeof entryConfig.model !== "string") return;
	const resolved = resolveAliasDetails(entryConfig.model, aliases);
	if (resolved.value && resolved.value !== entryConfig.model) {
		entryConfig.model = resolved.value;
	}
	// Alias-provided variant wins over the configured variant.
	if (resolved.variant) {
		entryConfig.variant = resolved.variant;
	}
}

function applyAliasesToConfig(config: Config, aliases: AliasMap): void {
	for (const section of [config.agent, config.command]) {
		if (!section) continue;
		for (const entryConfig of Object.values(section)) {
			if (entryConfig && typeof entryConfig === "object") {
				applyAliasToEntry(entryConfig as ModelConfig, aliases);
			}
		}
	}
}

function resolveConfigAliases(config: Config): void {
	let aliases: AliasMap;
	try {
		aliases = readAliases();
	} catch {
		return;
	}
	applyAliasesToConfig(config, aliases);
}

type ModelAvailability = (model: string) => Promise<boolean>;

type VariantSupport = (model: string, variant: string) => Promise<boolean>;

type ProviderListEntry = {
	id?: unknown;
	models?: unknown;
};

function isModelInProviders(
	providers: ProviderListEntry[],
	model: string,
): boolean {
	return providers.some((provider) => {
		if (!provider || typeof provider.id !== "string") return false;
		return Object.values(provider.models ?? {}).some(
			(candidate) =>
				!!candidate &&
				typeof candidate.id === "string" &&
				`${provider.id}/${candidate.id}` === model,
		);
	});
}

function isVariantInModel(
	providers: ProviderListEntry[],
	model: string,
	variant: string,
): boolean {
	return getSupportedVariants(providers, model).has(variant);
}

// Returns the set of variant ids listed in the model's provider metadata.
// The v1 SDK types omit `variants`, but runtime metadata carries it.
function getSupportedVariants(
	providers: ProviderListEntry[],
	model: string,
): Set<string> {
	// Split on the first slash only: model ids may contain slashes.
	const slash = model.indexOf("/");
	if (slash < 0) return new Set();
	const providerID = model.slice(0, slash);
	const modelID = model.slice(slash + 1);
	const supported = new Set<string>();
	for (const provider of providers) {
		if (
			!provider ||
			typeof provider.id !== "string" ||
			provider.id !== providerID
		)
			continue;
		for (const candidate of Object.values(provider.models ?? {})) {
			if (
				!candidate ||
				typeof candidate.id !== "string" ||
				candidate.id !== modelID
			)
				continue;
			const variants = (candidate as { variants?: unknown }).variants;
			if (variants === null || variants === undefined) continue;
			if (typeof variants !== "object" || Array.isArray(variants)) continue;
			for (const name of Object.keys(variants)) {
				supported.add(name);
			}
		}
	}
	return supported;
}

export {
	ensureConfigDir,
	handleAliasCommand,
	readAliases,
	resolveAlias,
	resolveConfigAliases,
	resolveConfigDir,
	writeAliases,
};

type FetchProviders = () => Promise<unknown>;

// Sentinel returned by the compat fallback: a successful probe already
// proved availability, so the caller must skip the provider-list re-check.
const PROVIDERS_VERIFIED = Symbol("providers-verified");

type ProviderVerification = ProviderListEntry[] | typeof PROVIDERS_VERIFIED;

// Fallback for direct callers that don't supply fetchProviders: probes the
// model/variant through the injected availability callbacks. Returns the
// PROVIDERS_VERIFIED sentinel — the caller must treat it as "already
// verified" and skip the list re-check.
async function fetchProviderListCompat(
	isModelAvailable: ModelAvailability,
	isVariantSupported: VariantSupport,
	value: string,
	variant: string | undefined,
): Promise<ProviderVerification> {
	if (variant) {
		const supported = await isVariantSupported(value, variant);
		if (!supported) {
			throw new Error(
				`variant '${variant}' is not listed for model '${value}'`,
			);
		}
	}
	const available = await isModelAvailable(value);
	if (!available) {
		throw new Error(`model '${value}' is not available from a known provider`);
	}
	return PROVIDERS_VERIFIED;
}

function aliasHelp(): string {
	return `Usage: /alias <subcommand> [options]

Subcommands:
  list                                   List all model aliases
  set <key> <provider/model> [variant]   Set a model alias, optionally with a variant
  delete <key>                           Delete a model alias
  help                                   Show this help message

Examples:
  alias list
  alias set cheap openai/gpt-4o-mini
  alias set smart ollama-cloud/glm-5.3-flash max
  alias delete cheap

Notes:
  - The variant argument requires a direct provider/model target; it cannot
    be combined with an alias target.
  - Setting an alias without a variant removes any previous variant.
  - Object form in model-aliases.json:
      "smart": { "model": "ollama-cloud/glm-5.3-flash", "variant": "max" }
  - Variants must be listed in the model's provider metadata.
  - Alias keys shadow model references: an agent/command model matching an
    alias key is resolved through it, even if it looks like provider/model.

Tip: type '!opencode models' in the TUI to list available models in the correct format.

Restart OpenCode after adding, updating, or deleting aliases so the changes take effect.`;
}

function aliasList(): string {
	let aliases: AliasMap;
	try {
		aliases = readAliases();
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not read alias file"}`;
	}
	if (Object.keys(aliases).length === 0) {
		return "No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.";
	}
	const lines = Object.keys(aliases)
		.map((key) => {
			const chain = getAliasChain(key, aliases);
			const terminal = chain.values[chain.values.length - 1];
			const status =
				chain.failure === "cycle"
					? " [cycle]"
					: chain.failure === "depth"
						? ` [exceeds ${MAX_ALIAS_DEPTH} hops]`
						: !terminal || !isModelIdentifier(terminal)
							? " [unresolved]"
							: "";
			// Show the effective variant (own or inherited from the nearest
			// outer object-form entry), matching what resolution applies.
			// readAliases guarantees object-form entries target direct model
			// ids, so any chain containing an object-form node terminates
			// there — a failed chain can never carry a variant.
			const { variant } = resolveAliasDetails(key, aliases);
			const variantTag = variant ? ` [${variant}]` : "";
			return `  ${chain.values.join(RIGHT_ARROW)}${status}${variantTag}`;
		})
		.join("\n");
	return `Model aliases:\n${lines}`;
}

async function aliasSet(
	parts: string[],
	isModelAvailable: ModelAvailability,
	isVariantSupported: VariantSupport,
	fetchProviders: FetchProviders | undefined,
): Promise<string> {
	const key = parts[1];
	const value = parts[2];
	const variant = parts[3];
	if (!key) {
		return "Error: key is required for 'set' subcommand";
	}
	if (!value) {
		return "Error: value is required for 'set' subcommand";
	}
	if (parts.length > 4) {
		return "Error: too many arguments. Use 'alias set <key> <provider/model> [variant]'";
	}
	let aliases: AliasMap;
	try {
		aliases = readAliases();
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not read alias file"}`;
	}
	const candidateAliases: AliasMap = { ...aliases, [key]: { model: value } };
	const resolution = resolveAliasDetails(key, candidateAliases);
	if (resolution.failure === "cycle") {
		return `Error: alias '${key}' creates a cycle`;
	}
	if (resolution.failure === "depth") {
		return `Error: alias '${key}' exceeds the ${MAX_ALIAS_DEPTH}-hop resolution limit`;
	}

	const resolved = resolution.value;
	if (hasAlias(aliases, value)) {
		if (variant) {
			return `Error: variant '${variant}' cannot be applied to alias target '${value}'. Use a direct provider/model identifier.`;
		}
		if (!resolved || !isModelIdentifier(resolved)) {
			return `Error: alias '${key}' does not resolve to a provider/model identifier`;
		}
	} else {
		if (!isModelIdentifier(value)) {
			return `Error: '${value}' is not a valid provider/model identifier`;
		}
		// Single provider-list fetch shared by both checks. When only the
		// availability callbacks are available (no fetchProviders), a
		// successful probe means "available" — skip the list re-check.
		let verification: ProviderVerification;
		try {
			verification = fetchProviders
				? ((await fetchProviders()) as ProviderVerification)
				: await fetchProviderListCompat(
						isModelAvailable,
						isVariantSupported,
						value,
						variant,
					);
		} catch (error) {
			const message = error instanceof Error ? `: ${error.message}` : "";
			return `Error: could not verify model '${value}'${message}`;
		}
		// PROVIDERS_VERIFIED means the compat probe already proved availability.
		// A real provider list must be non-empty; an empty list means nothing
		// is authenticated/configured, so the model cannot be verified — fail
		// closed rather than silently skipping validation.
		if (verification !== PROVIDERS_VERIFIED) {
			const available = isModelInProviders(verification, value);
			if (!available) {
				return `Error: model '${value}' is not available from a known provider`;
			}
			if (variant) {
				const supported = getSupportedVariants(verification, value);
				if (!supported.has(variant)) {
					const hint =
						supported.size > 0
							? ` Supported variants: ${[...supported].sort().join(", ")}.`
							: " The model lists no variants.";
					return `Error: variant '${variant}' is not listed for model '${value}'.${hint}`;
				}
			}
		}
	}
	let current: AliasMap;
	try {
		current = readAliases();
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not read alias file"}`;
	}
	if (JSON.stringify(current) !== JSON.stringify(aliases)) {
		return "Error: alias file changed concurrently, please retry";
	}
	// defineProperty avoids the __proto__ setter for hostile keys.
	Object.defineProperty(aliases, key, {
		value: variant ? { model: value, variant } : value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	try {
		writeAliases(aliases);
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not write alias file"}`;
	}
	const suffix = variant ? ` (variant: ${variant})` : "";
	return `Alias '${key}' set to '${value}'${suffix}. Please restart OpenCode for the change to take effect.`;
}

function aliasDelete(parts: string[]): string {
	const key = parts[1];
	if (!key) {
		return "Error: key is required for 'delete' subcommand";
	}
	let aliases: AliasMap;
	try {
		aliases = readAliases();
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not read alias file"}`;
	}
	if (!hasAlias(aliases, key)) {
		return `Error: alias '${key}' does not exist`;
	}
	// Same concurrent-modification guard as 'set': re-read and compare so a
	// concurrent writer between our snapshot and the write is not clobbered.
	let current: AliasMap;
	try {
		current = readAliases();
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not read alias file"}`;
	}
	if (JSON.stringify(current) !== JSON.stringify(aliases)) {
		return "Error: alias file changed concurrently, please retry";
	}
	delete aliases[key];
	try {
		writeAliases(aliases);
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "could not write alias file"}`;
	}
	return `Alias '${key}' deleted. Please restart OpenCode for the change to take effect.`;
}

async function handleAliasCommand(
	args: string,
	isModelAvailable: ModelAvailability,
	isVariantSupported: VariantSupport,
	fetchProviders?: FetchProviders,
): Promise<string> {
	const parts = args.trim().split(/\s+/);
	const subcommand = parts[0] || "help";

	if (subcommand === "help") {
		return aliasHelp();
	}
	if (subcommand === "list") {
		return aliasList();
	}
	if (subcommand === "set") {
		return aliasSet(parts, isModelAvailable, isVariantSupported, fetchProviders);
	}
	if (subcommand === "delete") {
		return aliasDelete(parts);
	}
	return "Unknown subcommand. Use 'alias help' for usage information.";
}

export const aliasPlugin: Plugin = async ({ client, directory }) => {
	const fetchProviderList = async () => {
		const response = await client.provider.list({ query: { directory } });
		if (response.error) {
			throw new Error(
				`provider list failed: ${JSON.stringify(response.error)}`,
			);
		}
		const data = response.data;
		if (!data || !Array.isArray(data.all)) {
			throw new Error("provider list returned an unexpected shape");
		}
		return data.all;
	};

	// The availability callbacks are required by handleAliasCommand's
	// signature but unused in production: fetchProviderList is always
	// supplied, so verification runs against the fetched list directly.
	const isModelAvailable: ModelAvailability = async (model) => {
		const providers = await fetchProviderList();
		return isModelInProviders(providers, model);
	};

	const isVariantSupported: VariantSupport = async (model, variant) => {
		const providers = await fetchProviderList();
		return isVariantInModel(providers, model, variant);
	};

	return {
		config: async (opencodeConfig: Config) => {
			opencodeConfig.command ??= {};
			// Only register /alias if the user has not defined their own.
			if (!Object.hasOwn(opencodeConfig.command, "alias")) {
				opencodeConfig.command.alias = {
					template: "",
					description: "Manage model aliases (list, set, delete)",
				};
			}

			resolveConfigAliases(opencodeConfig);
		},
		"command.execute.before": async (input, output) => {
			if (input.command === "alias") {
				let result: string;
				try {
					result = await handleAliasCommand(
						input.arguments,
						isModelAvailable,
						isVariantSupported,
						fetchProviderList,
					);
				} catch (error) {
					result = `Error: ${error instanceof Error ? error.message : "alias command failed"}`;
				}
				const part = {
					type: "text",
					text: result,
					ignored: true,
				} as Part;
				output.parts.splice(0, output.parts.length, part);
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