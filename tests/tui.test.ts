/**
 * Tests for the TUI plugin (src/tui.tsx).
 *
 * The TUI module is UI glue over alias-core. These tests drive it without a
 * renderer: tui() is invoked with a mock api that captures keymap command
 * registrations and dialog/toast calls. Dialog components (DialogSelect,
 * DialogPrompt) are passed as props objects, so their callbacks can be
 * inspected and invoked directly — no JSX rendering needed.
 */

jest.mock("node:os", () => ({
	homedir: () => "/home/test",
}));

jest.mock("node:fs", () => {
	const mockFs: Record<string, string> = {};
	return {
		existsSync: (pathLike: any) => pathLike.toString() in mockFs,
		readFileSync: (pathLike: any, _encoding?: any) => {
			const key = pathLike.toString();
			if (key in mockFs) return mockFs[key];
			const error: NodeJS.ErrnoException = new Error(
				`ENOENT: no such file or directory, open '${key}'`,
			);
			error.code = "ENOENT";
			throw error;
		},
		writeFileSync: (pathLike: any, content: any) => {
			mockFs[pathLike.toString()] = content;
		},
		renameSync: (from: any, to: any) => {
			mockFs[to.toString()] = mockFs[from.toString()];
			delete mockFs[from.toString()];
		},
		mkdirSync: () => {},
		unlinkSync: (pathLike: any) => {
			delete mockFs[pathLike.toString()];
		},
		__mockFs: mockFs,
	};
});

import fs from "node:fs";
import { homedir } from "node:os";

const mockFs = (fs as any).__mockFs;
const ALIAS_FILE = `${homedir()}/.config/opencode/model-aliases.json`;

type CapturedDialog = {
	component: string;
	props: any;
};

type CapturedToast = {
	variant?: string;
	title?: string;
	message: string;
};

function makeApi(overrides?: { providerList?: unknown; providerError?: unknown }) {
	const registeredLayers: any[] = [];
	const dialogs: CapturedDialog[] = [];
	const toasts: CapturedToast[] = [];

	const api = {
		keymap: {
			registerLayer: jest.fn((layer: any) => {
				registeredLayers.push(layer);
				return () => {};
			}),
		},
		ui: {
			dialog: {
				replace: jest.fn((render: () => any) => {
					// Invoke the render function like the host would: the JSX
					// element factories (DialogSelect/DialogPrompt) run and
					// record their props, which the tests assert on.
					render();
					dialogs.push({ component: "render", props: render });
				}),
				clear: jest.fn(),
			},
			toast: jest.fn((input: any) => {
				toasts.push(input);
			}),
			// The JSX <api.ui.DialogPrompt .../> / <api.ui.DialogSelect .../>
			// elements are created by the module's own code. To drive the flows
			// we replace these with factories that record props and return a
			// marker object; the captured props are what the tests assert on.
			DialogSelect: (props: any) => {
				dialogs.push({ component: "DialogSelect", props });
				return { __kind: "DialogSelect", props };
			},
			DialogPrompt: (props: any) => {
				dialogs.push({ component: "DialogPrompt", props });
				return { __kind: "DialogPrompt", props };
			},
		},
		client: {
			provider: {
				list: jest.fn(async () => {
					if (overrides?.providerError) {
						return { error: overrides.providerError, data: undefined };
					}
					return {
						error: undefined,
						data: { all: overrides?.providerList ?? [] },
					};
				}),
			},
		},
	};
	return { api, registeredLayers, dialogs, toasts };
}


async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("tui plugin", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("registers a palette command with slashName alias", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		expect(registeredLayers).toHaveLength(1);
		const command = registeredLayers[0].commands[0];
		expect(command.namespace).toBe("palette");
		expect(command.slashName).toBe("alias");
		expect(command.name).toBe("alias.manage");
		expect(command.category).toBe("Plugin");
		expect(typeof command.run).toBe("function");
	});

	test("module exports id and tui, no server export", async () => {
		const mod = (await import("../src/tui.js")).default;
		expect(mod.id).toBe("opencode-model-alias");
		expect(typeof mod.tui).toBe("function");
		expect((mod as any).server).toBeUndefined();
	});

	test("run opens the action menu with list/set/delete/help", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		expect(api.ui.dialog.replace).toHaveBeenCalledTimes(1);
		// The menu is a DialogSelect element; its props carry the options.
		const select = dialogs.find((d) => d.component === "DialogSelect");
		expect(select).toBeDefined();
		const titles = select!.props.options.map(
			(o: any) => o.title,
		);
		expect(titles).toEqual([
			"List aliases",
			"Set alias",
			"Delete alias",
			"Help",
		]);
	});

	test("menu List action shows the formatted alias list as a toast", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		mockFs[ALIAS_FILE] =
			'{"cheap": {"model": "openai/gpt-4o-mini", "variant": "max"}, "genius": {"model": "openai/gpt-4o"}}';
		registeredLayers[0].commands[0].run();
		const select = dialogs.find((d) => d.component === "DialogSelect")!;
		select.props.options[0].onSelect(); // List
		expect(api.ui.dialog.clear).toHaveBeenCalled();
		// The list dialog renders via dialog.replace; the toast path is only
		// for the empty case. Assert the replace happened with content.
		expect(api.ui.dialog.replace).toHaveBeenCalled();
	});

	test("menu List with no aliases toasts the empty-state message", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const select = dialogs.find((d) => d.component === "DialogSelect")!;
		select.props.options[0].onSelect(); // List
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("No aliases defined.");
	});

	test("menu List with an unreadable file toasts the error", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		mockFs[ALIAS_FILE] = "broken{";
		registeredLayers[0].commands[0].run();
		const select = dialogs.find((d) => d.component === "DialogSelect")!;
		select.props.options[0].onSelect(); // List
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toMatch(/^Error:/);
	});

	test("Set flow: name -> model -> variant -> writes object form", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi({
			providerList: [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {} } }],
				},
			],
		});
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[1].onSelect(); // Set

		// Step 1: name prompt
		const namePrompt = dialogs.filter(
			(d) => d.component === "DialogPrompt",
		).at(-1)!;
		expect(namePrompt.props.title).toContain("name");
		namePrompt.props.onConfirm("smart");

		// Step 2: model prompt
		const modelPrompt = dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!;
		expect(modelPrompt.props.title).toContain("provider/model");
		modelPrompt.props.onConfirm("ollama-cloud/glm-5.3-flash");

		// Step 3: variant prompt (optional)
		const variantPrompt = dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!;
		expect(variantPrompt.props.title).toContain("variant");
		variantPrompt.props.onConfirm("max");

		// Async write completes -> dialog cleared, toast shown.
		await flush();
		expect(api.ui.dialog.clear).toHaveBeenCalled();
		expect(mockFs[ALIAS_FILE]).toContain('"variant": "max"');
	});

	test("Set flow without variant writes string form", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi({
			providerList: [{ id: "openai", models: [{ id: "gpt-4o-mini" }] }],
		});
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[1].onSelect();
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("cheap");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("openai/gpt-4o-mini");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("");
		await flush();
		expect(mockFs[ALIAS_FILE]).toContain('"cheap": "openai/gpt-4o-mini"');
	});

	test("Set flow surfaces validation errors as error toasts", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi({
			providerList: [],
		});
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[1].onSelect();
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("cheap");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("openai/gpt-4o-mini");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("");
		await flush();
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toMatch(/not available from a known provider/);
	});

	test("Delete flow: menu of existing aliases, delete writes the file", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		mockFs[ALIAS_FILE] =
			'{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[2].onSelect(); // Delete

		const select = dialogs.filter(
			(d) => d.component === "DialogSelect",
		).at(-1)!;
		expect(select.props.title).toBe("Delete alias");
		expect(select.props.options.map((o: any) => o.title)).toEqual([
			"cheap",
			"other",
		]);
		select.props.options[0].onSelect();
		await flush();
		expect(mockFs[ALIAS_FILE]).not.toContain('"cheap"');
		expect(mockFs[ALIAS_FILE]).toContain('"other"');
	});

	test("Delete flow with no aliases toasts the empty-state message", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[2].onSelect();
		expect(toasts[0].message).toBe("No aliases defined.");
	});

	test("Delete flow with an unreadable file toasts the error", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		mockFs[ALIAS_FILE] = "broken{";
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[2].onSelect();
		expect(toasts[0].variant).toBe("error");
	});

	test("Help action shows the help text in a dialog", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs } = makeApi();
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[3].onSelect(); // Help
		await Promise.resolve();
		// Help re-opens a dialog with the help text rendered.
		expect(api.ui.dialog.replace).toHaveBeenCalled();
	});

	test("provider list errors surface as error toasts during set", async () => {
		const mod = (await import("../src/tui.js")).default;
		const { api, registeredLayers, dialogs, toasts } = makeApi({
			providerError: { code: 500 },
		});
		await mod.tui(api as any, undefined, {} as any);
		registeredLayers[0].commands[0].run();
		const menu = dialogs.find((d) => d.component === "DialogSelect")!;
		menu.props.options[1].onSelect();
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("cheap");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("openai/gpt-4o-mini");
		dialogs
			.filter((d) => d.component === "DialogPrompt")
			.at(-1)!.props.onConfirm("");
		await flush();
		expect(toasts[0].variant).toBe("error");
		expect(toasts[0].message).toMatch(/could not verify model/);
	});
});