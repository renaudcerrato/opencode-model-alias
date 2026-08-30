/**
 * OpenCode model aliases — TUI plugin.
 *
 * Dialog-driven `/alias` command: manages the alias file without touching
 * the session, so no agent turn is ever triggered. Registered as a palette
 * command with slashName "alias"; selecting it from the autocomplete opens
 * the menu.
 *
 * See alias-core.ts for the alias file format and resolution rules.
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { ProviderListEntry } from "./alias-core.js";
import { handleAliasCommand, readAliases, resolveConfigDir } from "./alias-core.js";

type TuiApi = Parameters<TuiPlugin>[0];

// Provider list via the TUI client (v2 SDK): { all: Provider[] } with
// models as a record keyed by model id. alias-core tolerates both record
// and array shapes.
function makeFetchProviders(api: TuiApi) {
	return async (): Promise<ProviderListEntry[]> => {
		const response = await api.client.provider.list();
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
}

async function runAliasCommand(
	api: TuiApi,
	args: string,
): Promise<string> {
	const fetchProviders = makeFetchProviders(api);
	try {
		return await handleAliasCommand(args, fetchProviders);
	} catch (error) {
		return `Error: ${error instanceof Error ? error.message : "alias command failed"}`;
	}
}

function toastResult(
	api: TuiApi,
	result: string,
): void {
	const isError = result.startsWith("Error:");
	api.ui.toast({
		title: "Model aliases",
		message: result,
		variant: isError ? "error" : "success",
	});
}

function openListDialog(api: TuiApi): void {
	let text: string;
	try {
		const aliases = readAliases();
		const keys = Object.keys(aliases);
		if (keys.length === 0) {
			api.ui.toast({
				title: "Model aliases",
				message: "No aliases defined.",
			});
			return;
		}
		text = keys
			.map((key) => {
				const entry = aliases[key];
				const model =
					typeof entry === "string" ? entry : entry.model;
				const variant =
					typeof entry === "string" ? undefined : entry.variant;
				return `${key} → ${model}${variant ? ` [${variant}]` : ""}`;
			})
			.join("\n");
	} catch (error) {
		api.ui.toast({
			title: "Model aliases",
			message: `Error: ${error instanceof Error ? error.message : "could not read aliases"}`,
			variant: "error",
		});
		return;
	}
	api.ui.dialog.replace(() => (
		<box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
			<text>{text}</text>
		</box>
	));
}

function openSetDialog(api: TuiApi): void {
	api.ui.dialog.replace(() => (
		<api.ui.DialogPrompt
			title="Set alias — name"
			placeholder="e.g. cheap"
			onConfirm={(name) => {
				if (!name.trim()) return;
				openSetModelDialog(api, name.trim());
			}}
			onCancel={() => api.ui.dialog.clear()}
		/>
	));
}

function openSetModelDialog(api: TuiApi, name: string): void {
	api.ui.dialog.replace(() => (
		<api.ui.DialogPrompt
			title={`Set alias '${name}' — provider/model`}
			placeholder="e.g. openai/gpt-4o-mini"
			onConfirm={(model) => {
				if (!model.trim()) return;
				openSetVariantDialog(api, name, model.trim());
			}}
			onCancel={() => api.ui.dialog.clear()}
		/>
	));
}

function openSetVariantDialog(
	api: TuiApi,
	name: string,
	model: string,
): void {
	api.ui.dialog.replace(() => (
		<api.ui.DialogPrompt
			title={`Set alias '${name}' — variant (optional)`}
			description={() => (
				<text fg="#888888">
					{`Target: ${model}. Leave empty for no variant.`}
				</text>
			)}
			placeholder="e.g. max"
			onConfirm={(variant) => {
				const args = variant?.trim()
					? `set ${name} ${model} ${variant.trim()}`
					: `set ${name} ${model}`;
				void runAliasCommand(api, args).then((result) => {
					api.ui.dialog.clear();
					toastResult(api, result);
				});
			}}
			onCancel={() => api.ui.dialog.clear()}
		/>
	));
}

function openDeleteDialog(api: TuiApi): void {
	let aliases: Record<string, unknown>;
	try {
		aliases = readAliases() as Record<string, unknown>;
	} catch (error) {
		api.ui.toast({
			title: "Model aliases",
			message: `Error: ${error instanceof Error ? error.message : "could not read aliases"}`,
			variant: "error",
		});
		return;
	}
	const keys = Object.keys(aliases);
	if (keys.length === 0) {
		api.ui.toast({
			title: "Model aliases",
			message: "No aliases defined.",
		});
		return;
	}
	api.ui.dialog.replace(() => (
		<api.ui.DialogSelect
			title="Delete alias"
			placeholder="Search aliases..."
			options={keys.map((key) => ({
				title: key,
				value: key,
				onSelect: () => {
					void runAliasCommand(api, `delete ${key}`).then(
						(result) => {
							api.ui.dialog.clear();
							toastResult(api, result);
						},
					);
				},
			}))}
		/>
	));
}

function openHelpDialog(api: TuiApi): void {
	void runAliasCommand(api, "help").then((result) => {
		api.ui.dialog.replace(() => (
			<box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
				<text>{result}</text>
			</box>
		));
	});
}

const tui: TuiPlugin = async (api) => {
	api.keymap.registerLayer({
		commands: [
			{
				name: "alias.manage",
				title: "Model aliases",
				desc: "Manage model aliases (list, set, delete)",
				category: "Plugin",
				namespace: "palette",
				slashName: "alias",
				run() {
					api.ui.dialog.replace(() => (
						<api.ui.DialogSelect
							title="Model aliases"
							placeholder="Choose an action..."
							options={[
								{
									title: "List aliases",
									description: "Show all defined aliases",
									value: "list",
									onSelect: () => {
										api.ui.dialog.clear();
										openListDialog(api);
									},
								},
								{
									title: "Set alias",
									description: "Create or update an alias",
									value: "set",
									onSelect: () => {
										api.ui.dialog.clear();
										openSetDialog(api);
									},
								},
								{
									title: "Delete alias",
									description: "Remove an alias",
									value: "delete",
									onSelect: () => {
										api.ui.dialog.clear();
										openDeleteDialog(api);
									},
								},
								{
									title: "Help",
									description: "Show alias help",
									value: "help",
									onSelect: () => {
										api.ui.dialog.clear();
										openHelpDialog(api);
									},
								},
							]}
						/>
					));
				},
			},
		],
	});
};

export default {
	id: "opencode-model-alias",
	tui,
};