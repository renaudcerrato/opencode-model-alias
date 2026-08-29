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
const CONFIG_DIR_PATH = `${homedir()}/.config/opencode`;

import pluginModule, {
	ensureConfigDir,
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
const SUPPORTED_VARIANT = "max";
const variantOk = async (_model: string, variant: string) =>
	variant === SUPPORTED_VARIANT;

// Exception-safe fs stubbing: stubs are queued and restored in afterEach,
// so a failing test cannot leak a broken mock into later tests.
const fsRestorers: Array<() => void> = [];

function stubFs(method: "readFileSync" | "writeFileSync" | "renameSync", impl: (...args: any[]) => any): void {
	const original = (fs as any)[method];
	(fs as any)[method] = jest.fn(impl);
	fsRestorers.push(() => {
		(fs as any)[method] = original;
	});
}

afterEach(() => {
	while (fsRestorers.length > 0) {
		fsRestorers.pop()!();
	}
});

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

	test("returns model on self-referencing cycle", () => {
		expect(resolveAlias("self", { self: "self" })).toBe("self");
	});

	test("nearest outer object-form entry wins variant tie-break", () => {
		// Chain: outer(string) -> inner(object, v2) -> model. The string alias
		// inherits the variant of the nearest outer object-form entry — here
		// the only object-form in the chain, proving inheritance across hops.
		// (A chain with two object-forms is unreachable: object-form entries
		// must target a direct model id, so at most one object-form exists
		// per valid chain and the tie-break degenerates to this case.)
		mockFs[ALIAS_FILE] =
			'{"outer": "inner", "inner": {"model": "openai/gpt-4o-mini", "variant": "v2"}}';
		const config: any = {
			agent: { myagent: { model: "outer" } },
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
		expect(config.agent.myagent.variant).toBe("v2");
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

	test.each([42, true, null, ["x"]])(
		"rejects non-object alias value: %p",
		(value) => {
			mockFs[ALIAS_FILE] = `{"bad": ${JSON.stringify(value)}}`;
			expect(() => readAliases()).toThrow(
				/must be a string or an object with a 'model' field/,
			);
		},
	);

	test("rejects object alias with empty model", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"model": ""}}';
		expect(() => readAliases()).toThrow(/non-empty string 'model' field/);
	});

	test("rejects object alias with non-string variant", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"model": "openai/gpt-4o", "variant": 42}}';
		expect(() => readAliases()).toThrow(/non-empty string 'variant' field/);
	});

	test("rejects object alias with empty variant", () => {
		mockFs[ALIAS_FILE] = '{"bad": {"model": "openai/gpt-4o", "variant": ""}}';
		expect(() => readAliases()).toThrow(/non-empty string 'variant' field/);
	});

	test("rejects primitive JSON root (number)", () => {
		mockFs[ALIAS_FILE] = "42";
		expect(() => readAliases()).toThrow(/JSON object/);
	});

	test("rejects primitive JSON root (string)", () => {
		mockFs[ALIAS_FILE] = '"just a string"';
		expect(() => readAliases()).toThrow(/JSON object/);
	});

	test("accepts empty-string alias key from hand-edited file", () => {
		mockFs[ALIAS_FILE] = '{"": "openai/gpt-4o-mini"}';
		const aliases = readAliases();
		expect(Object.keys(aliases)).toContain("");
	});

	test("duplicate JSON keys resolve last-wins", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o", "cheap": "openai/gpt-4o-mini"}';
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o-mini" },
		});
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
		stubFs("readFileSync", () => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		expect(() => readAliases()).toThrow(/alias file unreadable/);
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
		stubFs("writeFileSync", (path: string, content: string) => {
			if (path.endsWith(".tmp")) throw new Error("disk full");
			mockFs[path] = content;
		});
		expect(() => writeAliases({ cheap: "openai/gpt-4o-mini" })).toThrow(
			"disk full",
		);
		const tmpKeys = Object.keys(mockFs).filter((k) => k.endsWith(".tmp"));
		expect(tmpKeys).toEqual([]);
	});

	test("cleans up tmp file when rename fails", () => {
		stubFs("renameSync", () => {
			throw new Error("EXDEV: cross-device link not permitted");
		});
		expect(() => writeAliases({ cheap: "openai/gpt-4o-mini" })).toThrow(
			"EXDEV",
		);
		const tmpKeys = Object.keys(mockFs).filter((k) => k.endsWith(".tmp"));
		expect(tmpKeys).toEqual([]);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("writes with owner-only mode (0600)", () => {
		const writeSpy = jest.fn((path: string, content: string) => {
			mockFs[path] = content;
		});
		stubFs("writeFileSync", writeSpy);
		writeAliases({ cheap: "openai/gpt-4o-mini" });
		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining(".tmp"),
			expect.any(String),
			{ mode: 0o600 },
		);
	});
});

describe("ensureConfigDir", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("creates the config directory when missing", () => {
		const mkdirSpy = jest.fn();
		stubFs("renameSync", (from: string, to: string) => {
			mockFs[to] = mockFs[from];
			delete mockFs[from];
		});
		// Replace mkdirSync via the module mock: stub through writeFileSync
		// is not enough — assert on mkdirSync directly.
		const originalMkdir = (fs as any).mkdirSync;
		(fs as any).mkdirSync = mkdirSpy;
		fsRestorers.push(() => {
			(fs as any).mkdirSync = originalMkdir;
		});
		ensureConfigDir();
		expect(mkdirSpy).toHaveBeenCalledWith(expect.any(String), {
			recursive: true,
		});
	});

	test("does not create the directory when it exists", () => {
		mockFs[CONFIG_DIR_PATH] = "";
		const mkdirSpy = jest.fn();
		const originalMkdir = (fs as any).mkdirSync;
		(fs as any).mkdirSync = mkdirSpy;
		fsRestorers.push(() => {
			(fs as any).mkdirSync = originalMkdir;
		});
		ensureConfigDir();
		expect(mkdirSpy).not.toHaveBeenCalled();
	});
});

describe("handleAliasCommand", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("help output", async () => {
		const result = await handleAliasCommand("help", ok, variantOk);
		expect(result).toContain("Usage: /alias <subcommand> [options]");
		// Assert on the subcommand section markers, not just the words.
		expect(result).toContain("list");
		expect(result).toContain("set <key> <provider/model> [variant]");
		expect(result).toContain("delete <key>");
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

	test("list - failed chains never carry a variant tag", async () => {
		// Invariant: object-form entries must target direct model ids, so any
		// chain containing an object-form node terminates there. A cycle or
		// depth-failure chain therefore consists of string aliases only and
		// can never display a variant tag. Pin that invariant.
		const entries: Record<string, string> = {};
		for (let i = 1; i <= 17; i++) {
			entries[`hop${i}`] = i === 17 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		mockFs[ALIAS_FILE] = JSON.stringify(entries);
		const result = await handleAliasCommand("list", ok, variantOk);
		const failedLine = result
			.split("\n")
			.find((line) => line.includes("[exceeds 16 hops]"));
		expect(failedLine).toBeDefined();
		// The failed line carries exactly one bracket tag: the failure status.
		expect(failedLine!.match(/\[/g)).toHaveLength(1);
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
		// Pin the serialized form: no variant means string form, not object.
		expect(mockFs[ALIAS_FILE]).toBe(
			'{\n  "cheap": "openai/gpt-4o-mini"\n}',
		);
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
		expect(result).toBe(
			"Error: variant 'turbo' is not listed for model 'ollama-cloud/glm-5.3-flash'. Supported variants: low, max.",
		);
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
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand(
			"set third first",
			ok,
			variantOk,
		);
		expect(result).toMatch(/creates a cycle/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("set - rejects chains exceeding 16 hops", async () => {
		const entries: Record<string, string> = {};
		for (let i = 1; i <= 17; i++) {
			entries[`hop${i}`] = i === 17 ? "openai/gpt-4o-mini" : `hop${i + 1}`;
		}
		mockFs[ALIAS_FILE] = JSON.stringify(entries);
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand("set entry hop1", ok, variantOk);
		expect(result).toMatch(/exceeds the 16-hop resolution limit/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
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
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
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
		// Serve mutated content for every read after the first: the intent is
		// "snapshot, then the file diverges", regardless of exact read count.
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					return '{"cheap": "openai/gpt-4o", "other": "openai/gpt-4o"}';
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			ok,
			variantOk,
		);
		expect(result).toMatch(/changed concurrently/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("delete - concurrent modification detected", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					return '{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toMatch(/changed concurrently/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("set - concurrent check fails closed when second read throws", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
					error.code = "EACCES";
					throw error;
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			ok,
			variantOk,
		);
		expect(result).toMatch(/alias file unreadable/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("delete - concurrent check fails closed when second read throws", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
					error.code = "EACCES";
					throw error;
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toMatch(/alias file unreadable/);
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

	test("set - compat probe rejects unavailable model", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => false,
			variantOk,
		);
		// The compat probe throws; the caller wraps it as "could not verify".
		expect(result).toBe(
			"Error: could not verify model 'openai/gpt-4o-mini': model 'openai/gpt-4o-mini' is not available from a known provider",
		);
	});

	test("set - alias target resolving to non-identifier rejected", async () => {
		mockFs[ALIAS_FILE] = '{"dead": "not-an-id"}';
		const result = await handleAliasCommand("set x dead", ok, variantOk);
		expect(result).toBe(
			"Error: alias 'x' does not resolve to a provider/model identifier",
		);
	});

	test("set - compat probe accepts supported variant", async () => {
		// No fetchProviders: the compat path probes variant support through
		// the injected callback (which consults provider metadata), covering
		// isVariantInModel end-to-end.
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			variantOk,
		);
		expect(result).toContain("Alias 'smart' set");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("set - compat probe rejects unsupported variant", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			ok,
			variantOk,
		);
		expect(result).toBe(
			"Error: could not verify model 'ollama-cloud/glm-5.3-flash': variant 'turbo' is not listed for model 'ollama-cloud/glm-5.3-flash'",
		);
	});

	test("set - malformed provider entries are skipped, valid ones still work", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
			async () => [
				null,
				{ id: 42 },
				{ id: "openai", models: [null, { id: 42 }, { id: "gpt-4o-mini" }] },
			] as any,
		);
		expect(result).toContain("Alias 'cheap' set");
	});

	test("set - variant union across duplicate provider ids", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			ok,
			variantOk,
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {} } }],
				},
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { low: {} } }],
				},
			] as any,
		);
		// Variants from both same-id providers are unioned in the hint.
		expect(result).toMatch(
			/^Error: variant 'turbo' is not listed for model 'ollama-cloud\/glm-5\.3-flash'\. Supported variants: low, max\.$/,
		);
	});

	test("set - malformed variants metadata skipped", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			ok,
			variantOk,
			async () => [
				{
					id: "ollama-cloud",
					models: [
						{ id: "glm-5.3-flash", variants: [] },
						{ id: "glm-5.3-flash", variants: "max" },
						{ id: "glm-5.3-flash", variants: null },
						{ id: "glm-5.3-flash", variants: { max: {} } },
					],
				},
			] as any,
		);
		// Only the object-form variants entry counts; the malformed ones are skipped.
		expect(result).toContain("Alias 'smart' set");
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
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
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
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
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
		stubFs("readFileSync", () => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
		);
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
		mockFs[ALIAS_FILE] =
			'{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toBe(
			"Alias 'cheap' deleted. Please restart OpenCode for the change to take effect.",
		);
		// Only the targeted alias is removed; unrelated aliases survive.
		expect(readAliases()).toEqual({
			other: { model: "openai/gpt-4o" },
		});
	});

	test("delete - fail closed on invalid JSON", async () => {
		mockFs[ALIAS_FILE] = "broken{";
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("delete - fail closed on non-ENOENT read error", async () => {
		stubFs("readFileSync", () => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		expect(result).toMatch(/alias file unreadable/);
	});

	test("delete - write failure returns error and leaves file untouched", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		stubFs("writeFileSync", (path: string, content: string) => {
			if (path.endsWith(".tmp")) throw new Error("disk full");
			mockFs[path] = content;
		});
		const result = await handleAliasCommand("delete cheap", ok, variantOk);
		// The write error is surfaced (not swallowed) and nothing is written.
		expect(result).toMatch(/^Error: disk full$/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("set - write failure returns error and leaves file untouched", async () => {
		stubFs("writeFileSync", (path: string, content: string) => {
			if (path.endsWith(".tmp")) throw new Error("disk full");
			mockFs[path] = content;
		});
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toMatch(/^Error: disk full$/);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
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

	test("argument parsing collapses extra whitespace", async () => {
		const result = await handleAliasCommand(
			"set   cheap    openai/gpt-4o-mini",
			ok,
			variantOk,
		);
		expect(result).toContain("Alias 'cheap' set to 'openai/gpt-4o-mini'");
	});

	test("argument parsing splits on first whitespace only (delete takes one word)", async () => {
		mockFs[ALIAS_FILE] = '{"my": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand(
			"delete my key",
			ok,
			variantOk,
		);
		// "my key" is split into ["my", "key"]; only "my" is considered.
		expect(result).toContain("Alias 'my' deleted");
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

	test("leaves model unchanged on cycle", () => {
		mockFs[ALIAS_FILE] = '{"first": "second", "second": "first"}';
		const config: any = {
			agent: {
				myagent: { model: "first" },
			},
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.myagent.model).toBe("first");
		expect(config.agent.myagent.variant).toBeUndefined();
	});

	test("agent entry without model field is left untouched", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: {
				bare: {},
			},
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.bare.model).toBeUndefined();
		expect(config.agent.bare.variant).toBeUndefined();
	});

	test("null section entries and missing sections are tolerated", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: { broken: null },
			command: { broken: "not-an-object" },
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(() => resolveConfigAliases({} as any)).not.toThrow();
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

	test("ignores whitespace-only OPENCODE_CONFIG_DIR", () => {
		process.env.OPENCODE_CONFIG_DIR = "   ";
		process.env.XDG_CONFIG_HOME = "/xdg/home";
		expect(resolveConfigDir()).toBe("/xdg/home/opencode");
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
		expect(config.command.alias).toEqual({
			template: "",
			description: expect.any(String),
		});
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
	});

	test("config hook preserves a user-defined alias command", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const config: any = {
			command: {
				alias: { template: "custom template", description: "mine" },
			},
		};
		await plugin.config(config);
		// The user's own /alias command must not be clobbered.
		expect(config.command.alias).toEqual({
			template: "custom template",
			description: "mine",
		});
	});

	test("command.execute.before catches handler errors and reports them", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		// arguments: undefined makes args.trim() throw inside the handler.
		await plugin["command.execute.before"]!(
			{ command: "alias", arguments: undefined } as any,
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect(output.parts[0].text).toMatch(/^Error:/);
		expect(output.parts[0].ignored).toBe(true);
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

	test("provider list with non-array data.all surfaces in set verification", async () => {
		const plugin = await aliasPlugin({
			client: {
				provider: {
					list: jest.fn(async () => ({ error: undefined, data: {} })),
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