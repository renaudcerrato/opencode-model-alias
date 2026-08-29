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
	resolveConfigDir,
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
			resolveAlias("source", {
				source: "intermediate",
				intermediate: "target",
				target: "openai/gpt-4o-mini",
			}),
		).toBe("openai/gpt-4o-mini");
	});

	test("returns model on cycle", () => {
		expect(resolveAlias("first", { first: "second", second: "first" })).toBe(
			"first",
		);
	});

	test("resolves a chain of exactly 16 hops", () => {
		const aliases: Record<string, string> = {};
		for (let i = 1; i < 16; i++) aliases[`hop${i}`] = `hop${i + 1}`;
		aliases.hop16 = "openai/gpt-4o-mini";
		expect(resolveAlias("hop1", aliases)).toBe("openai/gpt-4o-mini");
	});

	test("fails closed on chains deeper than 16 hops", () => {
		const aliases: Record<string, string> = {};
		for (let i = 1; i <= 17; i++) {
			aliases[`hop${i}`] = i === 17 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		expect(resolveAlias("hop1", aliases)).toBe("hop1");
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
			'{"outer": {"model": "inner"}, "inner": "openai/gpt-4o-mini"}';
		expect(() => readAliases()).toThrow(/not another alias/);
	});

	test("rejects object alias with malformed model identifier", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"model": "garbage"}}';
		expect(() => readAliases()).toThrow(/direct provider\/model identifier/);
	});

	test("allows string alias chains", () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "openai/gpt-4o-mini"}';
		expect(readAliases()).toEqual({
			source: { model: "intermediate" },
			intermediate: { model: "openai/gpt-4o-mini" },
		});
	});

	test("throws on unreadable file (non-ENOENT, fail closed)", () => {
		const originalRead = fs.readFileSync;
		(fs as any).readFileSync = jest.fn(() => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		expect(() => readAliases()).toThrow(/alias file unreadable/);
		(fs as any).readFileSync = originalRead;
	});

	test("parses __proto__ key from hand-edited file as own property", () => {
		mockFs[ALIAS_FILE] = '{"__proto__": "openai/gpt-4o-mini"}';
		const aliases = readAliases();
		expect(Object.keys(aliases)).toContain("__proto__");
		expect((aliases as any)["__proto__"]).toEqual({
			model: "openai/gpt-4o-mini",
		});
		// Prototype pollution guard: the parse must not taint Object.prototype.
		expect(({} as any).polluted).toBeUndefined();
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

	test("list - shows inherited variant on string alias chain", async () => {
		mockFs[ALIAS_FILE] =
			'{"reviewer": "smart", "smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toContain(
			"reviewer → smart → ollama-cloud/glm-5.3-flash [max]",
		);
	});

	test("list - fail closed on invalid JSON", async () => {
		mockFs[ALIAS_FILE] = "not json{";
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("list - shows [cycle] status", async () => {
		mockFs[ALIAS_FILE] = '{"first": "second", "second": "first"}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toContain("first → second → first [cycle]");
	});

	test("list - shows [exceeds 16 hops] status", async () => {
		const entries: Record<string, string> = {};
		for (let i = 1; i <= 18; i++) {
			entries[`hop${i}`] = i === 18 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		mockFs[ALIAS_FILE] = JSON.stringify(entries);
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toContain("[exceeds 16 hops]");
	});

	test("list - shows [unresolved] for non model-id terminal", async () => {
		mockFs[ALIAS_FILE] = '{"broken": "not-a-model-id"}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toContain("broken → not-a-model-id [unresolved]");
	});

	test("list - shows multi-hop chain", async () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "target", "target": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("list", ok, variantOk);
		expect(result).toContain(
			"source → intermediate → target → openai/gpt-4o-mini",
		);
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
		mockFs[ALIAS_FILE] = '{"first": "second", "second": "first"}';
		const result = await handleAliasCommand(
			"set third first",
			ok,
			variantOk,
		);
		expect(result).toMatch(/creates a cycle/);
	});

	test("set - rejects chains exceeding 16 hops", async () => {
		const entries: Record<string, string> = {};
		for (let i = 1; i <= 17; i++) {
			entries[`hop${i}`] = i === 17 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		mockFs[ALIAS_FILE] = JSON.stringify(entries);
		const result = await handleAliasCommand("set entry hop1", ok, variantOk);
		expect(result).toMatch(/exceeds the 16-hop resolution limit/);
	});

	test("set - rejects invalid provider/model identifier", async () => {
		const result = await handleAliasCommand(
			"set cheap gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toBe(
			"Error: 'gpt-4o-mini' is not a valid provider/model identifier",
		);
	});

	test("set - alias target without variant succeeds", async () => {
		mockFs[ALIAS_FILE] = '{"smart": "ollama-cloud/glm-5.3-flash"}';
		const result = await handleAliasCommand(
			"set reviewer smart",
			ok,
			variantOk,
		);
		expect(result).toContain("Alias 'reviewer' set to 'smart'");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash" },
			reviewer: { model: "smart" },
		});
	});

	test("set - model id with slash in model part", async () => {
		const result = await handleAliasCommand(
			"set deep openai/org/gpt-4o-mini",
			ok,
			variantOk,
			async () => [
				{
					id: "openai",
					models: [{ id: "org/gpt-4o-mini", variants: { max: {} } }],
				},
			],
		);
		expect(result).toContain("Alias 'deep' set");
	});

	test("set - no-variants hint when model lists none", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			variantOk,
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash" }],
				},
			],
		);
		expect(result).toContain("The model lists no variants.");
	});

	test("set - concurrent modification detected", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const originalRead = fs.readFileSync;
		let reads = 0;
		(fs as any).readFileSync = jest.fn((path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads === 2) {
					return '{"cheap": "openai/gpt-4o", "other": "openai/gpt-4o"}';
				}
				return mockFs[path];
			}
			return originalRead(path);
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			ok,
			variantOk,
		);
		(fs as any).readFileSync = originalRead;
		expect(result).toMatch(/changed concurrently/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("delete - concurrent modification detected", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const originalRead = fs.readFileSync;
		let reads = 0;
		(fs as any).readFileSync = jest.fn((path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads === 2) {
					return '{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
				}
				return mockFs[path];
			}
			return originalRead(path);
		});
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		(fs as any).readFileSync = originalRead;
		expect(result).toMatch(/changed concurrently/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("set - fetchProviders positive path writes object form", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			variantOk,
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {}, low: {} } }],
				},
			],
		);
		expect(result).toContain("Alias 'smart' set");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("set - empty provider list fails closed", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
			async () => [],
		);
		expect(result).toBe(
			"Error: model 'openai/gpt-4o-mini' is not available from a known provider",
		);
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
		const result = await handleAliasCommand(
			"set key model variant extra",
			ok,
			variantOk,
		);
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
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("set - fail closed on non-ENOENT read error", async () => {
		const originalRead = fs.readFileSync;
		(fs as any).readFileSync = jest.fn(() => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		(fs as any).readFileSync = originalRead;
		expect(result).toMatch(/alias file unreadable/);
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

	test("leaves model unchanged when chain exceeds depth cap", () => {
		const entries: Record<string, string> = {};
		for (let i = 1; i <= 17; i++) {
			entries[`hop${i}`] = i === 17 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		mockFs[ALIAS_FILE] = JSON.stringify(entries);
		const config: any = {
			agent: {
				myagent: { model: "hop1" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("hop1");
		expect(config.agent.myagent.variant).toBeUndefined();
	});
});

describe("config dir resolution", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("OPENCODE_CONFIG_DIR takes precedence over XDG_CONFIG_HOME", () => {
		process.env.OPENCODE_CONFIG_DIR = "/custom/dir";
		process.env.XDG_CONFIG_HOME = "/xdg/home";
		expect(resolveConfigDir()).toBe("/custom/dir");
	});

	test("XDG_CONFIG_HOME used when OPENCODE_CONFIG_DIR unset", () => {
		delete process.env.OPENCODE_CONFIG_DIR;
		process.env.XDG_CONFIG_HOME = "/xdg/home";
		expect(resolveConfigDir()).toBe("/xdg/home/opencode");
	});

	test("falls back to homedir/.config when both unset", () => {
		delete process.env.OPENCODE_CONFIG_DIR;
		delete process.env.XDG_CONFIG_HOME;
		expect(resolveConfigDir()).toBe("/home/test/.config/opencode");
	});

	test("empty XDG_CONFIG_HOME falls back to homedir", () => {
		delete process.env.OPENCODE_CONFIG_DIR;
		process.env.XDG_CONFIG_HOME = "   ";
		expect(resolveConfigDir()).toBe("/home/test/.config/opencode");
	});
});

describe("plugin wiring", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	function makeClient(overrides: {
		providerList?: unknown;
		providerError?: unknown;
	}) {
		return {
			provider: {
				list: jest.fn(async () => {
					if (overrides.providerError) {
						return { error: overrides.providerError, data: undefined };
					}
					return { error: undefined, data: { all: overrides.providerList ?? [] } };
				}),
			},
		} as any;
	}

	test("config hook registers /alias command and resolves aliases", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const config: any = {
			agent: { myagent: { model: "cheap" } },
		};
		await plugin.config(config);
		expect(config.command.alias).toBeDefined();
		expect(config.command.alias.description).toContain("Manage model aliases");
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
	});

	test("command.execute.before intercepts alias command", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const output: any = {
			parts: [{ type: "text", text: "original" }],
		};
		await plugin["command.execute.before"]!(
			{ command: "alias", arguments: "list" } as any,
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect(output.parts[0].text).toBe(
			"No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.",
		);
		expect(output.parts[0].ignored).toBe(true);
	});

	test("command.execute.before ignores other commands", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const output: any = {
			parts: [{ type: "text", text: "keep me" }],
		};
		await plugin["command.execute.before"]!(
			{ command: "other", arguments: "" } as any,
			output,
		);
		expect(output.parts[0].text).toBe("keep me");
	});

	test("provider list error surfaces in set verification", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({ providerError: { code: 500 } }),
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		await plugin["command.execute.before"]!(
			{ command: "alias", arguments: "set cheap openai/gpt-4o-mini" } as any,
			output,
		);
		expect(output.parts[0].text).toMatch(/^Error: could not verify model/);
	});

	test("provider list unexpected shape surfaces in set verification", async () => {
		const plugin = await aliasPlugin({
			client: {
				provider: {
					list: jest.fn(async () => ({ error: undefined, data: null })),
				},
			} as any,
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		await plugin["command.execute.before"]!(
			{ command: "alias", arguments: "set cheap openai/gpt-4o-mini" } as any,
			output,
		);
		expect(output.parts[0].text).toMatch(/^Error: could not verify model/);
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