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
	// Keys registered here behave like directories: readFileSync throws
	// EISDIR, renameSync onto them throws EISDIR, existsSync returns true.
	const mockDirs = new Set<string>();
	return {
		existsSync: (pathLike: any) => {
			const key = pathLike.toString();
			return key in mockFs || mockDirs.has(key);
		},
		readFileSync: (pathLike: any, _encoding?: any) => {
			const key = pathLike.toString();
			if (mockDirs.has(key)) {
				const error: NodeJS.ErrnoException = new Error(
					`EISDIR: illegal operation on a directory, read '${key}'`,
				);
				error.code = "EISDIR";
				throw error;
			}
			if (key in mockFs) return mockFs[key];
			const error: NodeJS.ErrnoException = new Error(
				`ENOENT: no such file or directory, open '${key}'`,
			);
			error.code = "ENOENT";
			throw error;
		},
		writeFileSync: (pathLike: any, content: any) => {
			const key = pathLike.toString();
			if (mockDirs.has(key)) {
				const error: NodeJS.ErrnoException = new Error(
					`EISDIR: illegal operation on a directory, write '${key}'`,
				);
				error.code = "EISDIR";
				throw error;
			}
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
			if (mockDirs.has(dst)) {
				const error: NodeJS.ErrnoException = new Error(
					`EISDIR: illegal operation on a directory, rename '${src}' -> '${dst}'`,
				);
				error.code = "EISDIR";
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
		__mockDirs: mockDirs,
	};
});

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockFs = (fs as any).__mockFs;
const mockDirs: Set<string> = (fs as any).__mockDirs;
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

const SUPPORTED_VARIANT = "max";

// Default provider-list stub for handleAliasCommand: knows the models used
// across the suite, with SUPPORTED_VARIANT listed for glm-5.3-flash.
const fetchProvidersOk = async () =>
	[
		{
			id: "openai",
			models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
		},
		{
			id: "ollama-cloud",
			models: [{ id: "glm-5.3-flash", variants: { [SUPPORTED_VARIANT]: {} } }],
		},
	] as any;

// Minimal opencode client stub for plugin-level tests: only provider.list
// is exercised by the plugin.
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

// The README's example model-aliases.json, verbatim: object entries with and
// without variants plus string aliases chaining into an object entry — the
// mixed state a real user's file has after a few weeks.
const README_ALIAS_FILE = {
	cheap: { model: "openai/gpt-5.6-luna", variant: "max" },
	genius: { model: "openai/gpt-5.6-sol" },
	smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
	reviewer: "cheap",
	researcher: "cheap",
};

function writeReadmeAliasFile(): void {
	mockFs[ALIAS_FILE] = JSON.stringify(README_ALIAS_FILE, null, 2);
}

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
	mockDirs.clear();
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

	test("rejects whitespace-only variant (aligns with set-time validation)", () => {
		// A whitespace variant is never in a supported-variants list; accepting
		// it here would let the config hook overwrite an agent's configured
		// variant with garbage.
		mockFs[ALIAS_FILE] =
			'{"bad": {"model": "openai/gpt-4o", "variant": "  "}}';
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

describe("alias file encoding and shape reality", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("tolerates a leading UTF-8 BOM and parses the aliases", () => {
		// Windows editors and PowerShell emit a BOM; the file is valid JSON
		// apart from it, so it must parse.
		mockFs[ALIAS_FILE] = "\uFEFF" + '{"cheap": "openai/gpt-4o-mini"}';
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o-mini" },
		});
	});

	test("BOM file resolves through the config hook and lists without error", async () => {
		mockFs[ALIAS_FILE] = "\uFEFF" + '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: { myagent: { model: "cheap" } },
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toBe("Model aliases:\n  cheap → openai/gpt-4o-mini");
	});

	test("treats a zero-byte file as no aliases", () => {
		// The plugin never creates the file, so users often touch it first.
		mockFs[ALIAS_FILE] = "";
		expect(readAliases()).toEqual({});
	});

	test("treats a whitespace-only file as no aliases", () => {
		mockFs[ALIAS_FILE] = "  \n\t";
		expect(readAliases()).toEqual({});
	});

	test("empty file lists as no aliases and does not write", async () => {
		mockFs[ALIAS_FILE] = "";
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toBe(
			"No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.",
		);
		expect(mockFs[ALIAS_FILE]).toBe("");
	});

	test("empty file is tolerated at startup (aliases simply not applied)", () => {
		mockFs[ALIAS_FILE] = "";
		const config: any = {
			agent: { myagent: { model: "cheap" } },
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.myagent.model).toBe("cheap");
	});

	test("fails closed when the alias file is a directory", async () => {
		mockDirs.add(ALIAS_FILE);
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toMatch(/^Error: alias file unreadable:/);
		// set fails closed too and writes nothing.
		const setResult = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(setResult).toMatch(/^Error: alias file unreadable:/);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
		// Startup tolerance: resolution is skipped, config untouched.
		const config: any = {
			agent: { myagent: { model: "cheap" } },
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.myagent.model).toBe("cheap");
	});

	test("surfaces an error when the config dir is a file (write path)", async () => {
		// OPENCODE_CONFIG_DIR pointing at a file: ensureConfigDir sees it
		// "exists", and the tmp write fails with ENOTDIR (the mock is flat,
		// so stub the write to reproduce the real filesystem's behavior).
		mockFs[CONFIG_DIR_PATH] = "not a directory";
		stubFs("writeFileSync", (path: string) => {
			if (path.startsWith(`${CONFIG_DIR_PATH}/`)) {
				const error: NodeJS.ErrnoException = new Error(
					`ENOTDIR: not a directory, open '${path}'`,
				);
				error.code = "ENOTDIR";
				throw error;
			}
			mockFs[path] = "written";
		});
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(result).toMatch(/^Error:/);
		// No tmp file leaks.
		const tmpKeys = Object.keys(mockFs).filter((k) => k.endsWith(".tmp"));
		expect(tmpKeys).toEqual([]);
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
		const result = await handleAliasCommand("help", fetchProvidersOk);
		expect(result).toContain("Usage: /alias <subcommand> [options]");
		// Assert on the subcommand section markers, not just the words.
		expect(result).toContain("list");
		expect(result).toContain("set <key> <provider/model> [variant]");
		expect(result).toContain("delete <key>");
		expect(result).toContain("[variant]");
	});

	test("help with empty args", async () => {
		const result = await handleAliasCommand("", fetchProvidersOk);
		expect(result).toContain("Usage: /alias <subcommand> [options]");
	});

	test("list - empty", async () => {
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toBe(
			"No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.",
		);
	});

	test("list - with aliases", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toBe("Model aliases:\n  cheap → openai/gpt-4o-mini");
	});

	test("list - shows variant from own entry", async () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toBe(
			"Model aliases:\n  smart → ollama-cloud/glm-5.3-flash [max]",
		);
	});

	test("list - shows inherited variant on string alias chain", async () => {
		mockFs[ALIAS_FILE] =
			'{"reviewer": "smart", "smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toContain(
			"reviewer → smart → ollama-cloud/glm-5.3-flash [max]",
		);
	});

	test("list - fail closed on invalid JSON", async () => {
		mockFs[ALIAS_FILE] = "not json{";
		const before = mockFs[ALIAS_FILE];
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("list - shows [cycle] status", async () => {
		mockFs[ALIAS_FILE] = '{"first": "second", "second": "first"}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
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
		const result = await handleAliasCommand("list", fetchProvidersOk);
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
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toContain("[exceeds 16 hops]");
	});

	test("list - shows [unresolved] for non model-id terminal", async () => {
		mockFs[ALIAS_FILE] = '{"broken": "not-a-model-id"}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toContain("broken → not-a-model-id [unresolved]");
	});

	test("list - shows multi-hop chain", async () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "target", "target": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("list", fetchProvidersOk);
		expect(result).toContain(
			"source → intermediate → target → openai/gpt-4o-mini",
		);
	});

	test("set - success", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
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
			fetchProvidersOk,
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
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {}, low: {} } }],
				},
			] as any,
		);
		expect(result).toBe(
			"Error: variant 'turbo' is not listed for model 'ollama-cloud/glm-5.3-flash'. Supported variants: low, max.",
		);
	});

	test("set - variant on alias target rejected", async () => {
		mockFs[ALIAS_FILE] = '{"smart": "ollama-cloud/glm-5.3-flash"}';
		const result = await handleAliasCommand(
			"set reviewer smart max",
			fetchProvidersOk,
		);
		expect(result).toMatch(/cannot be applied to alias target/);
	});

	test("set - without variant downgrades object alias to string", async () => {
		mockFs[ALIAS_FILE] =
			'{"smart": {"model": "ollama-cloud/glm-5.3-flash", "variant": "max"}}';
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash",
			fetchProvidersOk,
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
			fetchProvidersOk,
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
		const result = await handleAliasCommand("set entry hop1", fetchProvidersOk);
		expect(result).toMatch(/exceeds the 16-hop resolution limit/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("set - rejects invalid provider/model identifier", async () => {
		const result = await handleAliasCommand(
			"set cheap gpt-4o-mini",
			fetchProvidersOk,
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
			fetchProvidersOk,
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
			async () => [
				{
					id: "openai",
					models: [{ id: "org/gpt-4o-mini", variants: { max: {} } }],
				},
			] as any,
		);
		expect(result).toContain("Alias 'deep' set");
	});

	test("set - no-variants hint when model lists none", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash" }],
				},
			] as any,
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
			fetchProvidersOk,
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
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
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
			fetchProvidersOk,
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
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toMatch(/alias file unreadable/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("set - fetchProviders positive path writes object form", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			async () => [
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {}, low: {} } }],
				},
			] as any,
		);
		expect(result).toContain("Alias 'smart' set");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("set - empty provider list fails closed", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => [] as any,
		);
		expect(result).toBe(
			"Error: model 'openai/gpt-4o-mini' is not available from a known provider",
		);
	});

	test("set - provider list rejects unavailable model", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => [{ id: "other", models: [] }] as any,
		);
		expect(result).toBe(
			"Error: model 'openai/gpt-4o-mini' is not available from a known provider",
		);
	});

	test("set - alias target resolving to non-identifier rejected", async () => {
		mockFs[ALIAS_FILE] = '{"dead": "not-an-id"}';
		const result = await handleAliasCommand("set x dead", fetchProvidersOk);
		expect(result).toBe(
			"Error: alias 'x' does not resolve to a provider/model identifier",
		);
	});

	test("set - provider list accepts supported variant", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			fetchProvidersOk,
		);
		expect(result).toContain("Alias 'smart' set");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("set - provider list rejects unsupported variant", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: variant 'turbo' is not listed for model 'ollama-cloud/glm-5.3-flash'. Supported variants: max.",
		);
	});

	test("set - malformed provider entries are skipped, valid ones still work", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
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

	test("set - malformed model candidates skipped during variant lookup", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			async () => [
				{
					id: "ollama-cloud",
					models: [
						null,
						{ id: 42 },
						{ id: "other-model", variants: { decoy: {} } },
						{ id: "glm-5.3-flash", variants: { max: {} } },
					],
				},
			] as any,
		);
		// The malformed candidates are skipped; the real one supplies "max".
		expect(result).toContain("Alias 'smart' set");
	});

	test("set - provider without models field is skipped", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => [{ id: "empty" }] as any,
		);
		expect(result).toBe(
			"Error: model 'openai/gpt-4o-mini' is not available from a known provider",
		);
	});

	test("set - provider without models field skips variant lookup", async () => {
		// The model is available via one provider; a models-less provider must
		// not break the variant check (its models ?? {} yields an empty scan).
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			async () => [
				{ id: "empty" },
				{
					id: "ollama-cloud",
					models: [{ id: "glm-5.3-flash", variants: { max: {} } }],
				},
			] as any,
		);
		expect(result).toContain("Alias 'smart' set");
	});

	test("set - models-less provider during variant check yields no-variants hint", async () => {
		// The model matches via a provider entry with no models field, so the
		// variant scan finds nothing and the hint says the model lists none.
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			async () => [
				{ id: "ollama-cloud", models: [{ id: "glm-5.3-flash" }] },
				{ id: "ollama-cloud" },
			] as any,
		);
		expect(result).toBe(
			"Error: variant 'max' is not listed for model 'ollama-cloud/glm-5.3-flash'. The model lists no variants.",
		);
	});

	test("set - non-Error throw surfaces fallback message", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			// eslint-disable-next-line @typescript-eslint/require-await
			(async () => {
				throw "just a string"; // non-Error rejection
			}) as any,
		);
		expect(result).toBe(
			"Error: could not verify model 'openai/gpt-4o-mini'",
		);
	});

	test("readAliases - non-Error throw surfaces as unreadable", () => {
		stubFs("readFileSync", () => {
			throw "just a string"; // non-Error rejection
		});
		expect(() => readAliases()).toThrow(/alias file unreadable/);
	});

	test("writeAliases - non-Error throw propagates", () => {
		stubFs("writeFileSync", () => {
			throw "just a string"; // non-Error rejection
		});
		expect(() => writeAliases({ cheap: "openai/gpt-4o-mini" })).toThrow(
			"just a string",
		);
	});

	test("set - non-Error throw in concurrency check is wrapped as unreadable", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) throw 42; // non-Error rejection
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			fetchProvidersOk,
		);
		// readAliases wraps any read failure (Error or not) into a proper Error.
		expect(result).toMatch(/^Error: alias file unreadable:/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("delete - non-Error throw in concurrency check is wrapped as unreadable", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) throw 42; // non-Error rejection
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toMatch(/^Error: alias file unreadable:/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("set - non-Error write throw surfaces fallback message", async () => {
		stubFs("renameSync", () => {
			throw 42; // non-Error rejection
		});
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(result).toBe("Error: could not write alias file");
	});

	test("delete - non-Error write throw surfaces fallback message", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		stubFs("renameSync", () => {
			throw 42; // non-Error rejection
		});
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toBe("Error: could not write alias file");
	});

	test("set - missing key", async () => {
		const result = await handleAliasCommand("set", fetchProvidersOk);
		expect(result).toBe("Error: key is required for 'set' subcommand");
	});

	test("set - missing value", async () => {
		const result = await handleAliasCommand("set cheap", fetchProvidersOk);
		expect(result).toBe("Error: value is required for 'set' subcommand");
	});

	test("set - too many arguments", async () => {
		const result = await handleAliasCommand(
			"set key model variant extra",
			fetchProvidersOk,
		);
		expect(result).toMatch(/too many arguments/);
	});

	test("set - model unavailable", async () => {
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			async () => [{ id: "other", models: [] }] as any,
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
		);
		expect(result).toMatch(/^Error: could not verify model/);
		expect(result).toContain("offline");
	});

	test("set - unsupported variant rejected", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash turbo",
			fetchProvidersOk,
		);
		expect(result).toContain("variant 'turbo' is not listed");
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("set - variant check error surfaced", async () => {
		const result = await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
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
			fetchProvidersOk,
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
			fetchProvidersOk,
		);
		expect(result).toMatch(/alias file unreadable/);
	});

	test("set - __proto__ key persisted as own property", async () => {
		const result = await handleAliasCommand(
			"set __proto__ openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(result).toContain("Alias '__proto__' set");
		const stored = JSON.parse(mockFs[ALIAS_FILE]);
		expect(Object.keys(stored)).toContain("__proto__");
		expect(stored["__proto__"]).toBe("openai/gpt-4o-mini");
	});

	test("delete - success", async () => {
		mockFs[ALIAS_FILE] =
			'{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
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
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toMatch(/^Error:/);
		expect(mockFs[ALIAS_FILE]).toBe(before);
	});

	test("delete - fail closed on non-ENOENT read error", async () => {
		stubFs("readFileSync", () => {
			const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
			error.code = "EACCES";
			throw error;
		});
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toMatch(/alias file unreadable/);
	});

	test("delete - write failure returns error and leaves file untouched", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		stubFs("writeFileSync", (path: string, content: string) => {
			if (path.endsWith(".tmp")) throw new Error("disk full");
			mockFs[path] = content;
		});
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
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
			fetchProvidersOk,
		);
		expect(result).toMatch(/^Error: disk full$/);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("delete - missing key", async () => {
		const result = await handleAliasCommand("delete", fetchProvidersOk);
		expect(result).toBe("Error: key is required for 'delete' subcommand");
	});

	test("delete - non-existent alias", async () => {
		const result = await handleAliasCommand("delete nonexistent", fetchProvidersOk);
		expect(result).toBe("Error: alias 'nonexistent' does not exist");
	});

	test("unknown subcommand", async () => {
		const result = await handleAliasCommand("foobar", fetchProvidersOk);
		expect(result).toBe(
			"Unknown subcommand. Use 'alias help' for usage information.",
		);
	});

	test("argument parsing collapses extra whitespace", async () => {
		const result = await handleAliasCommand(
			"set   cheap    openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(result).toContain("Alias 'cheap' set to 'openai/gpt-4o-mini'");
	});

	test("argument parsing splits on first whitespace only (delete takes one word)", async () => {
		mockFs[ALIAS_FILE] = '{"my": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand(
			"delete my key",
			fetchProvidersOk,
		);
		// "my key" is split into ["my", "key"]; the extra word is now
		// rejected rather than silently ignored.
		expect(result).toBe(
			"Error: unexpected argument 'key'. Use 'alias delete <key> [force]'",
		);
	});

	test("quoted arguments are not unquoted (fail closed, nothing written)", async () => {
		// Shell-habit input: quotes stay part of the token. Pin the visible
		// outcome so a future unquoting feature is a deliberate change.
		const result = await handleAliasCommand(
			'set cheap "openai/gpt-4o-mini"',
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: model '\"openai/gpt-4o-mini\"' is not available from a known provider",
		);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("quoted variant is rejected with the quoted name in the error", async () => {
		const result = await handleAliasCommand(
			'set smart ollama-cloud/glm-5.3-flash "max"',
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: variant '\"max\"' is not listed for model 'ollama-cloud/glm-5.3-flash'. Supported variants: max.",
		);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("set after delete recreates the alias cleanly", async () => {
		await handleAliasCommand("set cheap openai/gpt-4o-mini", fetchProvidersOk);
		await handleAliasCommand("delete cheap", fetchProvidersOk);
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o",
			fetchProvidersOk,
		);
		expect(result).toContain("Alias 'cheap' set to 'openai/gpt-4o'");
		expect(readAliases()).toEqual({ cheap: { model: "openai/gpt-4o" } });
	});

	test("reports concurrent change when the file vanishes before the re-read", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					// TOCTOU: another process deleted the file between the
					// snapshot and the concurrency re-read.
					const error: NodeJS.ErrnoException = new Error(
						`ENOENT: no such file or directory, open '${path}'`,
					);
					error.code = "ENOENT";
					throw error;
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			fetchProvidersOk,
		);
		// ENOENT on the re-read yields an empty map, which mismatches the
		// snapshot — reported as a concurrent change, nothing written.
		expect(result).toMatch(/changed concurrently/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("fails closed when the file becomes a directory before the re-read", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		let reads = 0;
		stubFs("readFileSync", (path: string) => {
			if (path === ALIAS_FILE) {
				reads++;
				if (reads >= 2) {
					const error: NodeJS.ErrnoException = new Error(
						`EISDIR: illegal operation on a directory, read '${path}'`,
					);
					error.code = "EISDIR";
					throw error;
				}
				return mockFs[path];
			}
			return mockFs[path];
		});
		const result = await handleAliasCommand(
			"set expensive openai/gpt-4o",
			fetchProvidersOk,
		);
		expect(result).toMatch(/^Error: alias file unreadable:/);
		expect(mockFs[ALIAS_FILE]).toBe('{"cheap": "openai/gpt-4o-mini"}');
	});

	test("keys are case-sensitive: Cheap and cheap coexist", async () => {
		await handleAliasCommand("set Cheap openai/gpt-4o", fetchProvidersOk);
		await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(readAliases()).toEqual({
			Cheap: { model: "openai/gpt-4o" },
			cheap: { model: "openai/gpt-4o-mini" },
		});
	});

	test("flag-like and numeric keys are set and listed verbatim", async () => {
		await handleAliasCommand("set --foo openai/gpt-4o", fetchProvidersOk);
		await handleAliasCommand("set 1 openai/gpt-4o-mini", fetchProvidersOk);
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toContain("--foo → openai/gpt-4o");
		// Numeric-like keys are integer-index properties: JS hoists them to
		// the front of the object on every rewrite, so "1" lists first.
		const lines = listResult.split("\n");
		expect(lines[1]).toContain("1 → openai/gpt-4o-mini");
		expect(lines[2]).toContain("--foo → openai/gpt-4o");
	});

	test("mixed-form duplicate JSON keys resolve last-wins", () => {
		mockFs[ALIAS_FILE] =
			'{"cheap": "openai/gpt-4o", "cheap": {"model": "openai/gpt-4o-mini", "variant": "max"}}';
		const aliases = readAliases();
		expect(aliases).toEqual({
			cheap: { model: "openai/gpt-4o-mini", variant: "max" },
		});
		// The reverse ordering survives too (object then string).
		mockFs[ALIAS_FILE] =
			'{"cheap": {"model": "openai/gpt-4o-mini", "variant": "max"}, "cheap": "openai/gpt-4o"}';
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o" },
		});
	});

	test("provider id differing only in case is not the same provider", async () => {
		const result = await handleAliasCommand(
			"set x OpenAI/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: model 'OpenAI/gpt-4o-mini' is not available from a known provider",
		);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("model ids with regex-special characters match by exact string", async () => {
		const result = await handleAliasCommand(
			"set weird openai/gpt-4o(1)+v2.name",
			async () =>
				[
					{
						id: "openai",
						models: [{ id: "gpt-4o(1)+v2.name", variants: { max: {} } }],
					},
				] as any,
		);
		expect(result).toContain("Alias 'weird' set");
		expect(readAliases()).toEqual({
			weird: { model: "openai/gpt-4o(1)+v2.name" },
		});
	});

	test("set - repoints an existing alias to a different model and drops the old target", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand(
			"set cheap openai/gpt-4o",
			fetchProvidersOk,
		);
		expect(result).toContain("Alias 'cheap' set to 'openai/gpt-4o'");
		expect(readAliases()).toEqual({ cheap: { model: "openai/gpt-4o" } });
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toBe("Model aliases:\n  cheap → openai/gpt-4o");
	});

	test("set - rejects a variant that exists on another provider but not the named one", async () => {
		// Variant lookup must be scoped to the named provider: gpt-4o exists
		// on both openai (no variants) and azure (variants: max).
		const result = await handleAliasCommand(
			"set x openai/gpt-4o max",
			async () =>
				[
					{ id: "openai", models: [{ id: "gpt-4o" }] },
					{ id: "azure", models: [{ id: "gpt-4o", variants: { max: {} } }] },
				] as any,
		);
		expect(result).toBe(
			"Error: variant 'max' is not listed for model 'openai/gpt-4o'. The model lists no variants.",
		);
		expect(mockFs[ALIAS_FILE]).toBeUndefined();
	});

	test("set - accepts a variant listed for the named provider even when another provider lacks it", async () => {
		const result = await handleAliasCommand(
			"set x azure/gpt-4o max",
			async () =>
				[
					{ id: "openai", models: [{ id: "gpt-4o" }] },
					{ id: "azure", models: [{ id: "gpt-4o", variants: { max: {} } }] },
				] as any,
		);
		expect(result).toContain("Alias 'x' set");
		expect(readAliases()).toEqual({
			x: { model: "azure/gpt-4o", variant: "max" },
		});
	});

	test("delete - refuses to break a chain unless forced", async () => {
		// source → intermediate → model; deleting the middle link would leave
		// source dangling, so the delete is refused with the dependent named.
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "openai/gpt-4o-mini"}';
		const deleteResult = await handleAliasCommand(
			"delete intermediate",
			fetchProvidersOk,
		);
		expect(deleteResult).toBe(
			"Error: alias 'intermediate' is referenced by other aliases: source. Delete those first, or use 'alias delete intermediate force'.",
		);
		// The file is untouched.
		expect(readAliases()).toEqual({
			source: { model: "intermediate" },
			intermediate: { model: "openai/gpt-4o-mini" },
		});
		// list still shows the intact chain.
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toContain(
			"source → intermediate → openai/gpt-4o-mini",
		);
	});

	test("delete - force bypasses the dependent check and leaves the chain dangling", async () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "openai/gpt-4o-mini"}';
		const deleteResult = await handleAliasCommand(
			"delete intermediate force",
			fetchProvidersOk,
		);
		expect(deleteResult).toContain("Alias 'intermediate' deleted");
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toContain("source → intermediate [unresolved]");
	});

	test("delete - config hook rewrites a dependent agent model to the dangling name after force", async () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "openai/gpt-4o-mini"}';
		await handleAliasCommand("delete intermediate force", fetchProvidersOk);
		const config: any = {
			agent: { dependent: { model: "source" } },
		};
		resolveConfigAliases(config);
		// The chain terminates at the now-missing 'intermediate' key, which is
		// not a provider/model identifier — resolution rewrites the model to
		// that literal. Pin this documented fail-open-at-terminal behavior.
		expect(config.agent.dependent.model).toBe("intermediate");
	});

	test("delete - names all transitive dependents in the refusal", async () => {
		// head → mid → tail → model: deleting tail is refused naming both
		// transitive dependents, sorted.
		mockFs[ALIAS_FILE] =
			'{"head": "mid", "mid": "tail", "tail": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("delete tail", fetchProvidersOk);
		expect(result).toBe(
			"Error: alias 'tail' is referenced by other aliases: head, mid. Delete those first, or use 'alias delete tail force'.",
		);
	});

	test("delete - deleting a chain head is allowed (nothing depends on it)", async () => {
		mockFs[ALIAS_FILE] =
			'{"source": "intermediate", "intermediate": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand("delete source", fetchProvidersOk);
		expect(result).toContain("Alias 'source' deleted");
		expect(readAliases()).toEqual({
			intermediate: { model: "openai/gpt-4o-mini" },
		});
	});

	test("delete - leaf alias with no dependents deletes without force", async () => {
		mockFs[ALIAS_FILE] =
			'{"cheap": "openai/gpt-4o-mini", "other": "openai/gpt-4o"}';
		const result = await handleAliasCommand("delete cheap", fetchProvidersOk);
		expect(result).toContain("Alias 'cheap' deleted");
		expect(readAliases()).toEqual({
			other: { model: "openai/gpt-4o" },
		});
	});

	test("delete - unexpected second argument is rejected", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const result = await handleAliasCommand(
			"delete cheap oops",
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: unexpected argument 'oops'. Use 'alias delete <key> [force]'",
		);
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o-mini" },
		});
	});

	test("delete - too many arguments is rejected", async () => {
		const result = await handleAliasCommand(
			"delete cheap force extra",
			fetchProvidersOk,
		);
		expect(result).toBe(
			"Error: too many arguments. Use 'alias delete <key> [force]'",
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

	test("frozen agent entry is tolerated without corrupting sibling resolution", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const frozenEntry = Object.freeze({ model: "cheap" });
		const config: any = {
			agent: {
				frozen: frozenEntry,
				normal: { model: "cheap" },
			},
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		// The normal sibling is still resolved.
		expect(config.agent.normal.model).toBe("openai/gpt-4o-mini");
		// The frozen entry is left untouched rather than crashing the hook.
		expect(config.agent.frozen.model).toBe("cheap");
	});

	test("fully frozen config is tolerated (command registration skipped)", async () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = Object.freeze({
			agent: { myagent: { model: "cheap" } },
		});
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		await expect(plugin.config(config)).resolves.toBeUndefined();
		// The frozen top level blocks command registration, but the nested
		// agent entry is still writable, so alias resolution still applies.
		expect(config.command).toBeUndefined();
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
	});

	test("getter-only model field is tolerated (entry left untouched)", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const entry: any = {};
		Object.defineProperty(entry, "model", {
			get: () => "cheap",
			enumerable: true,
		});
		const config: any = {
			agent: { guarded: entry },
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.guarded.model).toBe("cheap");
	});

	test("array and number section entries and variant-without-model are tolerated", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: {
				arrayEntry: ["a"],
				numberEntry: 42,
				variantOnly: { variant: "max" },
			},
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		expect(config.agent.variantOnly.variant).toBe("max");
		expect(config.agent.variantOnly.model).toBeUndefined();
	});

	test("agent section as an array is tolerated", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: [{ model: "cheap" }],
		};
		expect(() => resolveConfigAliases(config)).not.toThrow();
		// Array entries are iterated by Object.values and each is an object,
		// so the entry is resolved like any other.
		expect(config.agent[0].model).toBe("openai/gpt-4o-mini");
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

describe("env-driven alias file location (module-load wiring)", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("reads and writes the alias file under OPENCODE_CONFIG_DIR when set before module load", async () => {
		// CONFIG_DIR/ALIAS_FILE are computed at module load; this proves the
		// env-resolved directory is the one actually used for I/O — the
		// missing link between the pure resolveConfigDir tests above and the
		// hardcoded-path fs tests everywhere else.
		process.env.OPENCODE_CONFIG_DIR = "/custom config dir";
		const envPath = "/custom config dir/model-aliases.json";

		let isolated: typeof import("../src/index");
		jest.isolateModules(() => {
			isolated = require("../src/index");
		});

		// Write through the isolated module and observe where the file lands.
		const setResult = await isolated.handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(setResult).toContain("Alias 'cheap' set");
		expect(mockFs[envPath]).toContain('"cheap"');
		expect(mockFs[ALIAS_FILE]).toBeUndefined();

		// Read back through the isolated module's config hook.
		const config: any = {
			agent: { myagent: { model: "cheap" } },
		};
		isolated.resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");

		// list sees the same file.
		const listResult = await isolated.handleAliasCommand(
			"list",
			fetchProvidersOk,
		);
		expect(listResult).toBe("Model aliases:\n  cheap → openai/gpt-4o-mini");
	});

	test("paths with spaces and trailing slashes resolve via join normalization", () => {
		process.env.OPENCODE_CONFIG_DIR = "/custom dir/";
		let isolated: typeof import("../src/index");
		jest.isolateModules(() => {
			isolated = require("../src/index");
		});
		// resolveConfigDir returns the dir as given (join only normalizes the
		// final file path); the trailing slash is harmless for I/O.
		expect(isolated.resolveConfigDir()).toBe("/custom dir/");
	});
});

describe("plugin wiring", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

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

	test("command.execute.before catches non-Error throws", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		// arguments: undefined makes args.trim() throw a TypeError (an Error),
		// so stub the command handler input to throw a non-Error instead.
		await plugin["command.execute.before"]!(
			{ command: "alias", get arguments() { throw "boom"; } } as any,
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect(output.parts[0].text).toBe("Error: alias command failed");
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

	test("set through the plugin fetches the provider list and succeeds", async () => {
		const plugin = await aliasPlugin({
			client: makeClient({
				providerList: [
					{
						id: "openai",
						models: [{ id: "gpt-4o-mini" }],
					},
				],
			}),
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		await plugin["command.execute.before"]!(
			{ command: "alias", arguments: "set cheap openai/gpt-4o-mini" } as any,
			output,
		);
		expect(output.parts[0].text).toContain("Alias 'cheap' set");
		expect(readAliases()).toEqual({
			cheap: { model: "openai/gpt-4o-mini" },
		});
	});

	test("set verifies against a realistic provider payload with extra fields and record-keyed models", async () => {
		// Real SDK payloads carry provider-level extras (name, config, ...) and
		// model entries with extras; depending on SDK version, models may be a
		// record keyed by model id rather than an array.
		const plugin = await aliasPlugin({
			client: makeClient({
				providerList: [
					{
						id: "ollama-cloud",
						name: "Ollama Cloud",
						config: { baseURL: "https://ollama.com" },
						models: {
							"glm-5.3-flash": {
								id: "glm-5.3-flash",
								name: "GLM 5.3 Flash",
								options: { temperature: 0.7 },
								variants: { max: { context: 200000 } },
							},
						},
					},
				],
			}),
			directory: "/tmp/proj",
		} as any);
		const output: any = { parts: [] };
		await plugin["command.execute.before"]!(
			{
				command: "alias",
				arguments: "set smart ollama-cloud/glm-5.3-flash max",
			} as any,
			output,
		);
		expect(output.parts[0].text).toContain("Alias 'smart' set");
		expect(readAliases()).toEqual({
			smart: { model: "ollama-cloud/glm-5.3-flash", variant: "max" },
		});
	});

	test("config hook rewrites aliased models while preserving sibling fields and untouched sections", async () => {
		writeReadmeAliasFile();
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const config: any = {
			agent: {
				budget: {
					model: "cheap",
					description: "Budget agent",
					temperature: 0.2,
					tools: { write: false },
				},
				direct: {
					model: "openai/gpt-4o",
					prompt: "You are direct.",
				},
			},
			command: {
				smartcmd: {
					template: "do things",
					model: "smart",
					variant: "low",
					description: "Smart command",
				},
			},
			provider: {
				"ollama-cloud": { options: { baseURL: "https://ollama.com" } },
			},
			mcp: { myserver: { type: "remote", url: "https://example.com" } },
		};
		await plugin.config(config);
		// Aliased models rewritten, variants applied (alias wins over configured).
		expect(config.agent.budget.model).toBe("openai/gpt-5.6-luna");
		expect(config.agent.budget.variant).toBe("max");
		// Direct provider/model reference untouched.
		expect(config.agent.direct.model).toBe("openai/gpt-4o");
		expect(config.agent.direct.variant).toBeUndefined();
		// Command entry: alias variant overrides the configured one.
		expect(config.command.smartcmd.model).toBe("ollama-cloud/glm-5.3-flash");
		expect(config.command.smartcmd.variant).toBe("max");
		// Sibling fields survive on every touched entry.
		expect(config.agent.budget.description).toBe("Budget agent");
		expect(config.agent.budget.temperature).toBe(0.2);
		expect(config.agent.budget.tools).toEqual({ write: false });
		expect(config.agent.direct.prompt).toBe("You are direct.");
		expect(config.command.smartcmd.template).toBe("do things");
		expect(config.command.smartcmd.description).toBe("Smart command");
		// Sections the plugin must not touch are deep-equal to their inputs.
		expect(config.provider).toEqual({
			"ollama-cloud": { options: { baseURL: "https://ollama.com" } },
		});
		expect(config.mcp).toEqual({
			myserver: { type: "remote", url: "https://example.com" },
		});
	});
});

describe("end-to-end alias lifecycle", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("set → list shows the new alias", async () => {
		const setResult = await handleAliasCommand(
			"set cheap openai/gpt-4o-mini",
			fetchProvidersOk,
		);
		expect(setResult).toContain("Alias 'cheap' set");
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toBe("Model aliases:\n  cheap → openai/gpt-4o-mini");
	});

	test("set → delete → list shows the alias gone", async () => {
		await handleAliasCommand("set cheap openai/gpt-4o-mini", fetchProvidersOk);
		const deleteResult = await handleAliasCommand(
			"delete cheap",
			fetchProvidersOk,
		);
		expect(deleteResult).toContain("Alias 'cheap' deleted");
		const listResult = await handleAliasCommand("list", fetchProvidersOk);
		expect(listResult).toBe(
			"No aliases defined. Use 'alias set <key> <provider/model> [variant]' to add one.",
		);
	});

	test("alias set in one session resolves agent models in the next session (restart simulation)", async () => {
		// Session 1: the user runs /alias set (string form and variant form).
		await handleAliasCommand("set cheap openai/gpt-4o-mini", fetchProvidersOk);
		await handleAliasCommand(
			"set smart ollama-cloud/glm-5.3-flash max",
			fetchProvidersOk,
		);
		// Session 2: a fresh plugin instance boots (restart simulation) and
		// resolves agent models through the file the previous session wrote.
		const plugin = await aliasPlugin({
			client: makeClient({}),
			directory: "/tmp/proj",
		} as any);
		const config: any = {
			agent: {
				budget: { model: "cheap" },
				flagship: { model: "smart" },
			},
		};
		await plugin.config(config);
		expect(config.agent.budget.model).toBe("openai/gpt-4o-mini");
		expect(config.agent.flagship.model).toBe("ollama-cloud/glm-5.3-flash");
		expect(config.agent.flagship.variant).toBe("max");
	});
});

describe("alias key shadowing", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("resolves an agent model that exactly matches a provider/model-shaped alias key", () => {
		// Documented behavior: alias keys shadow model references, even when
		// the key looks like a provider/model identifier.
		mockFs[ALIAS_FILE] =
			'{"openai/gpt-4o": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: { myagent: { model: "openai/gpt-4o" } },
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o-mini");
	});

	test("leaves a provider/model model untouched when no alias key shadows it", () => {
		mockFs[ALIAS_FILE] = '{"cheap": "openai/gpt-4o-mini"}';
		const config: any = {
			agent: { myagent: { model: "openai/gpt-4o" } },
		};
		resolveConfigAliases(config);
		expect(config.agent.myagent.model).toBe("openai/gpt-4o");
	});
});

describe("realistic alias file", () => {
	beforeEach(() => {
		Object.keys(mockFs).forEach((key) => delete mockFs[key]);
	});

	test("lists every entry with correct chain, variant tag, and no false status markers", async () => {
		writeReadmeAliasFile();
		const result = await handleAliasCommand("list", fetchProvidersOk);
		const lines = result.split("\n");
		expect(lines[0]).toBe("Model aliases:");
		// Object entry with variant.
		expect(lines).toContain("  cheap → openai/gpt-5.6-luna [max]");
		// Object entry without variant: no tag at all.
		expect(lines).toContain("  genius → openai/gpt-5.6-sol");
		// Second object entry with variant.
		expect(lines).toContain("  smart → ollama-cloud/glm-5.3-flash [max]");
		// String aliases chaining into an object entry inherit its variant.
		expect(lines).toContain("  reviewer → cheap → openai/gpt-5.6-luna [max]");
		expect(lines).toContain("  researcher → cheap → openai/gpt-5.6-luna [max]");
		// No false status markers anywhere.
		expect(result).not.toContain("[unresolved]");
		expect(result).not.toContain("[cycle]");
		expect(result).not.toContain("[exceeds");
	});

	test("resolves every alias in a mixed file through the config hook", () => {
		writeReadmeAliasFile();
		const config: any = {
			agent: {
				budget: { model: "cheap" },
				geniusAgent: { model: "genius" },
				reviewAgent: { model: "reviewer" },
			},
			command: {
				research: { model: "researcher" },
			},
		};
		resolveConfigAliases(config);
		expect(config.agent.budget.model).toBe("openai/gpt-5.6-luna");
		expect(config.agent.budget.variant).toBe("max");
		expect(config.agent.geniusAgent.model).toBe("openai/gpt-5.6-sol");
		expect(config.agent.geniusAgent.variant).toBeUndefined();
		expect(config.agent.reviewAgent.model).toBe("openai/gpt-5.6-luna");
		expect(config.agent.reviewAgent.variant).toBe("max");
		expect(config.command.research.model).toBe("openai/gpt-5.6-luna");
		expect(config.command.research.variant).toBe("max");
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