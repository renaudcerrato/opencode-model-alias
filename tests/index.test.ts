/**
 * Tests for the opencode-model-alias plugin.
 *
 * Uses jest fs/os mocks (upstream style) adapted to the hardened plugin:
 * - `readFileSync` throws an ENOENT-coded error for missing files so the
 *   plugin's missing-vs-broken distinction can be exercised.
 * - `renameSync` moves mock entries so atomic writes are observable.
 * - `handleAliasCommand` is async and takes availability callbacks.
 */

jest.mock("node:os", () => ({
	homedir: () => "/home/test",
}));

jest.mock("node:fs", () => {
	const mockFs: Record<string, string> = {};
	return {
		existsSync: (pathLike: any) => {
			const key = pathLike.toString();
			return key in mockFs;
		},
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
			const key = pathLike.toString();
			mockFs[key] = content;
		},
		renameSync: (from: any, to: any) => {
			const src = from.toString();
			const dst = to.toString();
			if (!(src in mockFs)) {
				const error: NodeJS.ErrnoException = new Error(
					`ENOENT: no such file or directory, rename '${src}'`,
				);
				error.code = "ENOENT";
				throw error;
			}
			mockFs[dst] = mockFs[src];
			delete mockFs[src];
		},
		mkdirSync: () => {},
		unlinkSync: (pathLike: any) => {
			const key = pathLike.toString();
			delete mockFs[key];
		},
		__mockFs: mockFs,
	};
});

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockFs = (fs as any).__mockFs;
const ALIAS_FILE = `${homedir()}/.config/opencode/model-aliases.json`;

import pluginModule, {
	readAliases,
	writeAliases,
	resolveAlias,
	resolveConfigAliases,
	handleAliasCommand,
	aliasPlugin,
	server,
} from "../src/index";

const ok = async () => true;
const variantOk = async (_model: string, variant: string) => variant === "max";

describe("resolveAlias", () => {
	test("returns undefined when model is undefined", () => {
		expect(resolveAlias(undefined, {})).toBeUndefined();
	});

	test("returns model when alias not found", () => {
		expect(resolveAlias("some/model", {})).toBe("some/model");
		expect(resolveAlias("some/model", { other: "openai/gpt-4o" })).toBe(
			"some/model",
		);
	});

	test("resolves known alias", () => {
		expect(resolveAlias("cheap", { cheap: "openai/gpt-4o-mini" })).toBe(
			"openai/gpt-4o-mini",
		);
	});

	test("resolves chained aliases", () => {
		expect(
			resolveAlias("a", { a: "b", b: "c", c: "openai/gpt-4o-mini" }),
		).toBe("openai/gpt-4o-mini");
	});

	test("returns model on cycle", () => {
		expect(resolveAlias("a", { a: "b", b: "a" })).toBe("a");
	});
});

describe("readAliases", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("returns empty object when file does not exist", () => {
		expect(readAliases()).toEqual({});
	});

	test("reads existing file", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		expect(readAliases()).toEqual({ cheap: { model: "openai/gpt-4o-mini" } });
	});

	test("throws on invalid JSON (fail closed)", () => {
		mockFs[ALIAS_FILE] = "not valid json";
		expect(() => readAliases()).toThrow(/invalid JSON/);
	});

	test("throws on non-object root (array)", () => {
		mockFs[ALIAS_FILE] = "[1,2,3]";
		expect(() => readAliases()).toThrow(/JSON object/);
	});

	test("throws on null root", () => {
		mockFs[ALIAS_FILE] = "null";
		expect(() => readAliases()).toThrow(/JSON object/);
	});

	test("parses object-form entries", () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("rejects object alias without model field", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"variant": "max"}}';
		expect(() => readAliases()).toThrow(/'model' field/);
	});

	test("rejects object alias with unknown fields", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"model": "openai/gpt-4o", "extra": 1}}';
		expect(() => readAliases()).toThrow(/only 'model' and 'variant'/);
	});

	test("rejects object alias pointing at another alias", () => {
		mockFs[ALIAS_FILE] =
			'{"a": {"model": "b"}, "b": "openai/gpt-4o-mini"}';
		expect(() => readAliases()).toThrow(/not another alias/);
	});

	test("allows string alias chains", () => {
		mockFs[ALIAS_FILE] = '{"a": "b", "b": "openai/gpt-4o-mini"}';
		expect(readAliases()).toEqual({
			a: { model: "b" },
			b: { model: "openai/gpt-4o-mini" },
		});
	});
});

describe("writeAliases", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("writes correct JSON format", () => {
		writeAliases({
			cheap: "openai/gpt-4o-mini",
			expensive: "openai/gpt-4o",
		});
		expect(mockFs[ALIAS_FILE]).toBe(
			'{\n  "cheap": "openai/gpt-4o-mini",\n  "expensive": "openai/gpt-4o"\n}',
		);
	});

	test("writes via temp file then rename (atomic)", () => {
		writeAliases({ cheap: "openai/gpt-4o-mini" });
		// After a successful write the tmp file must be gone (renamed).
		const tmpKeys = Object.keys(mockFs).filter((k) => k.endsWith(".tmp"));
		expect(tmpKeys).toEqual([]);
		expect(mockFs[ALIAS_FILE]).toContain('"cheap"');
	});

	test("cleans up tmp file when write fails", () => {
		const originalWrite = fs.writeFileSync;
		(fs as any).writeFileSync = jest.fn((path: string, content: string) => {
			if (path.endsWith(".tmp")) throw new Error("disk full");
			mockFs[path] = content;
		});
		expect(() => writeAliases({ cheap: "openai/gpt-4o-mini" })).toThrow(
			"disk full",
		);
		(fs as any).writeFileSync = originalWrite;
		const tmpKeys = Object.keys(mockFs).filter((k) => k.endsWith(".tmp"));
		expect(tmpKeys).toEqual([]);
	});
});

describe("handleAliasCommand", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("help output", async () => {
		const result = await handleAliasCommand("help", ok, variantOk);
		expect(result).toContain("Usage: /alias <subcommand> [options]");
		expect(result).toContain("list");
		expect(result).toContain("set");
		expect(result).toContain("delete");
		expect(result).toContain("[variant]");
	});

	test("help with empty args", async () => {
		const result = await handleAliasCommand("", ok, variantOk);
		expect(result).toContain("Usage: /alias <subcommand> [options]");
	});

	test("list - empty", async () => {
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toBe(
			"No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.",
		);
	});

	test("list - with aliases", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toBe("Model aliases:\n  cheap → openai/gpt-4o-mini");
	});

	test("list - shows variant from own entry", async () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toBe(
			"Model aliases:\n  smart → ollama-cloud/glm-5.3-flash [max]",
		);
	});

	test("list - fail closed on invalid JSON", async () => {
		mockFs[ALIAS_FILE] = "not json{";
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("set - success", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toBe(
			"Alias 'cheap' set to 'openai/gpt-4o-mini'. Please restart OpenCode for the change to take effect.",
		);
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o-mini" },
		});
	});

	test("set - with variant writes object form", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			variantOk,
		);
		expect(result).toBe(
			"Alias 'smart' set to 'ollama-cloud/glm-5.3-flash' (variant: max). Please restart OpenCode for the change to take effect.",
		);
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("set - unsupported variant rejected with supported list", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			ok,
			variantOk,
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {}, low: {} } }],
				},
			],
		);
		expect(result).toContain("variant 'turbo' is not listed");
		expect(result).toContain("Supported variants: low, max");
	});

	test("set - variant on alias target rejected", async () => {
		mockFs[ALIAS_FILE] = '{"smart": "ollama-cloud/glm-5.3-flash"}';
		const result = await handleAliasCommand(
			"set reviewer smart max",
			ok,
			variantOk,
		);
		expect(result).toMatch(/cannot be applied to alias target/);
	});

	test("set - without variant downgrades object alias to string", async () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash",
			ok,
			variantOk,
		);
		expect(result).not.toContain("variant");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash" },
		});
	});

	test("set - rejects cycle", async () => {
		mockFs[ALIAS_FILE] = '{"a": "b", "b": "a"}';
		const result = await handleAliasCommand(
			"set c a",
			ok,
			variantOk,
		);
		expect(result).toMatch(/creates a cycle/);
	});

	test("set - missing key", async () => {
		const result = await handleAliasCommand("set", ok, variantOk);
		expect(result).toBe("Error: key is required for 'set' subcommand");
	});

	test("set - missing value", async () => {
		const result = await handleAliasCommand("set cheap", ok, variantOk);
		expect(result).toBe("Error: value is required for 'set' subcommand");
	});

	test("set - too many arguments", async () => {
		const result = await handleAliasCommand("set a b c d", ok, variantOk);
		expect(result).toMatch(/too many arguments/);
	});

	test("set - model unavailable", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
			async () => [{ id: "other", models: [] }],
		);
		expect(result).toBe(
			"Error: model 'openai/gpt-4o-mini' is not available from a known provider",
		);
	});

	test("set - provider check throws", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => {
				throw new Error("offline");
			},
			variantOk,
		);
		expect(result).toMatch(/^Error: could not verify model/);
		expect(result).toContain("offline");
	});

	test("set - unsupported variant rejected", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			ok,
			variantOk,
		);
		expect(result).toContain("variant 'turbo' is not listed");
	});

	test("set - variant check error surfaced", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			async () => {
				throw new Error("metadata missing");
			},
		);
		expect(result).toMatch(/^Error:/);
		expect(result).toContain("metadata missing");
	});

	test("set - fail closed on unreadable file", async () => {
		mockFs[ALIAS_FILE] = "broken{";
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand(
			"set a openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("set - __proto__ key persisted as own property", async () => {
		const result = await handleAliasCommand(
			"set __proto__ openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toContain("Alias '__proto__' set");
		const stored = JSON.parse(mockFs[ALIAS_FILE]);
		expect(Object.keys(stored)).toContain("__proto__");
		expect(stored["__proto__"]).toBe("openai/gpt-4o-mini");
	});

	test("delete - success", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toBe(
			"Alias 'cheap' deleted. Please restart OpenCode for the change to take effect.",
		);
		expect(readAliases()).toEqual({});
	});

	test("delete - missing key", async () => {
		const result = await handleAliasCommand("delete", ok, variantOk);
		expect(result).toBe("Error: key is required for 'delete' subcommand");
	});

	test("delete - non-existent alias", async () => {
		const result = await handleAliasCommand("delete nonexistent", ok, variantOk);
		expect(result).toBe("Error: alias 'nonexistent' does not exist");
	});

	test("unknown subcommand", async () => {
		const result = await handleAliasCommand("foobar", ok, variantOk);
		expect(result).toBe(
			"Unknown subcommand. Use 'alias help' for usage information.",
		);
	});
});

describe("resolveConfigAliases", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("resolves alias in agent config", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: {
				myagent: { model: "cheap" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
	});

	test("resolves alias in command config", () => {
		mockFs[ALIAS_FILE] = '{"expensive": "openai/gpt-4o"}';
		const config: any = {
			command: {
				mycommand: { model: "expensive" },
			},
		};
		resolveConfigAliases(config);
		expect(config.command.mycommand.model).toBe("openai/gpt-4o");
	});

	test("does not modify non-alias models", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: {
				myagent: { model: "openai/gpt-4o" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o");
	});

	test("alias variant overrides configured variant", () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const config: any = {
			agent: {
				myagent: { model: "smart", variant: "low" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("ollama-cloud/glm-5.3-flash");
		expect(config.agent.myagent.variant).toBe("max");
	});

	test("string alias inherits terminal variant", () => {
		mockFs[ALIAS_FILE] =
			'{"reviewer": "smart", "smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const config: any = {
			agent: {
				myagent: { model: "reviewer" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("ollama-cloud/glm-5.3-flash");
		expect(config.agent.myagent.variant).toBe("max");
	});

	test("string alias preserves configured variant", () => {
		mockFs[ALIAS_FILE] = '{"plain": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: {
				myagent: { model: "plain", variant: "keep" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
		expect(config.agent.myagent.variant).toBe("keep");
	});

	test("applies variants to command configs", () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const config: any = {
			command: {
				mycommand: { template: "", model: "smart" },
			},
		};
		resolveConfigAliases(config);
		expect(config.command.mycommand.model).toBe("ollama-cloud/glm-5.3-flash");
		expect(config.command.mycommand.variant).toBe("max");
	});

	test("tolerates unreadable alias file at startup", () => {
		mockFs[ALIAS_FILE] = "broken{";
		const config: any = {
			agent: {
				myagent: { model: "cheap" },
			},
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.myagent.model).toBe("cheap");
	});
});

describe("plugin module export", () => {
	test("default export exposes server hook", () => {
		expect(pluginModule).toBeDefined();
		expect(typeof pluginModule.server).toBe("function");
		expect(pluginModule.id).toBe("opencode-model-alias");
	});

	test("server export matches aliasPlugin", () => {
		expect(server).toBe(aliasPlugin);
	});
});