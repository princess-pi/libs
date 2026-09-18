// --- Config Loader: Universal hierarchical config resolution (#20) ---
//
// One file per tool. JSON with comments (stripJsonComments). Deep merge.
// Resolution order: CWD → walk-up → XDG global → hardcoded defaults.
//
// Backward compat with existing config.ts API: readConfig, writeConfig,
// hasConfig, getConfigPaths. The new loadConfig is the recommended API.
//
// Directory: .princess-pi-tools / princess-pi-tools (matching repo name) by
// default — every function below takes the directory name as a trailing
// optional parameter (libs#12, princess-pi/wtft#156), so a tool that is not
// princess-pi-tools (e.g. wtft, standalone) can read and write under its own
// name. Every existing caller that omits it keeps today's behaviour exactly.
//
// The pre-rename princess-pi-packages/ and princess-pi/ read tiers, and
// emitLegacyDeprecation, were deleted with the one-time migration
// (duppypro/princess-pi-tools#560, princess-pi/wtft#51).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---
// CONSTANTS
// ---

const CONFIG_DIR = "princess-pi-tools";

// ---
// TYPES
// ---

export interface ConfigPaths {
	/** ~/.config/<dirName>/<tool>.json (dirName defaults to princess-pi-tools) */
	global: string;
	/** ./.<dirName>/<tool>.json (relative to cwd) */
	local: string;
}

export interface WtftConfig {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	showTicks?: boolean;
	timezone?: string;
	disabledEmoji?: boolean;
}

// ---
// INTERNAL: comment stripping & deep merge
// ---

/**
 * Strip // single-line and /* block comments from JSON.
 */
function stripJsonComments(json: string): string {
	return json
		.replace(/\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Try to read and parse a JSON-with-comments file.
 * Returns parsed object, or null if not found / unparseable / non-object.
 */
function tryReadConfig(filePath: string): Record<string, unknown> | null {
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf8");
		const stripped = stripJsonComments(raw);
		const parsed = JSON.parse(stripped);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Deep merge `source` into `target`.
 * Scalars overwrite, objects recurse, arrays replace entirely, null unsets.
 * Returns target (mutated).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	for (const key of Object.keys(source)) {
		const srcVal = source[key];

		if (srcVal === null) {
			delete target[key];
			continue;
		}

		if (Array.isArray(srcVal)) {
			target[key] = [...srcVal];
			continue;
		}

		if (typeof srcVal === "object" && !Array.isArray(srcVal)) {
			const existing = target[key];
			if (typeof existing === "object" && !Array.isArray(existing) && existing !== null) {
				target[key] = deepMerge(
					{ ...(existing as Record<string, unknown>) },
					srcVal as Record<string, unknown>,
				);
			} else {
				target[key] = { ...(srcVal as Record<string, unknown>) };
			}
			continue;
		}

		target[key] = srcVal;
	}
	return target;
}

// ---
// PATH RESOLUTION
// ---

/**
 * The XDG config root, honouring $XDG_CONFIG_HOME with the spec's default.
 *
 * Read at call time, never cached: tests (and any process that re-points its
 * config root) must be able to change it after this module is imported.
 */
function xdgConfigHome(): string {
	return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * The user's home directory, honouring $HOME with `os.homedir()` as the
 * fallback — the same env-first pattern as `xdgConfigHome`. Not merely
 * stylistic: bun caches `os.homedir()` at process start (unlike
 * `process.env`), so a test cannot repoint it after import; reading `$HOME`
 * directly is what makes the walk-up boundary below testable at all.
 */
function homeDir(): string {
	const raw = process.env.HOME || homedir();
	// Strip a trailing separator (bar the root itself, "/") — $HOME with a
	// trailing slash is legal and some shells/tools write it that way, and the
	// walk-up boundary below compares this against `dirname()` output, which
	// never carries one (PR #13 review, libs#12). Without normalizing here,
	// "/home/duppy/" !== "/home/duppy" forever, and the walk never stops.
	return raw === "/" ? raw : raw.replace(/\/+$/, "");
}

/**
 * Resolve config file paths for a tool.
 *
 * Must resolve the global path the same way `loadConfig` does. It did not
 * before (#158): `loadConfig` honoured $XDG_CONFIG_HOME while this hardcoded
 * `~/.config`, so on any machine with XDG_CONFIG_HOME set, a tool READ one
 * file and WROTE another — a persisted setting would appear not to stick, and
 * anything driving the write path (a test, say) would land in the user's real
 * `~/.config` no matter how carefully it had isolated itself.
 *
 * `dirName` defaults to `"princess-pi-tools"` — every existing caller that
 * omits it resolves exactly the paths it always has.
 */
export function getConfigPaths(toolName: string, dirName: string = CONFIG_DIR): ConfigPaths {
	const globalDir = join(xdgConfigHome(), dirName);
	const localDir = join(process.cwd(), `.${dirName}`);
	return {
		global: join(globalDir, `${toolName}.json`),
		local: join(localDir, `${toolName}.json`),
	};
}

/**
 * Walk up from startDir toward root, collecting config files.
 * Returns [closest, ..., farthest] — reversed for merge order.
 *
 * Stops AT the home directory, inclusive: a config file that sits exactly at
 * `homedir()` is still read, but the walk does not continue past it into a
 * shared ancestor (`/home`, `/`) that could belong to an unrelated user or
 * project (PR #13 review, libs#12). A startDir outside `homedir()` (a CI
 * sandbox under `/tmp`, say) never reaches that check and walks to `/` as
 * before.
 */
function walkUpConfigs(toolName: string, startDir: string, dirName: string): Record<string, unknown>[] {
	const results: Record<string, unknown>[] = [];
	const home = homeDir();
	let dir = startDir;

	while (true) {
		const currentPath = join(dir, `.${dirName}`, `${toolName}.json`);
		const config = tryReadConfig(currentPath);
		if (config) results.push(config);

		if (dir === home) break;

		const parent = dirname(dir);
		// `parent === dir` alone terminates: `dirname("/") === "/"`, so this
		// still stops at the real filesystem root. The old extra
		// `parent === "/"` arm broke ONE step too early — as soon as the
		// NEXT dir would be root, never checking root itself, which is also
		// why a $HOME of "/" could never satisfy the `dir === home` check
		// above (PR #13 review, libs#12).
		if (parent === dir) break;
		dir = parent;
	}

	return results;
}

// ---
// NEW API: loadConfig
// ---

/**
 * Load config for a tool, merging across the full resolution hierarchy.
 *
 * Resolution order (most specific wins):
 *   1. $CWD/.<dirName>/<tool>.json (with walk-up to ~/)
 *   2. $XDG_CONFIG_HOME/<dirName>/<tool>.json
 *   3. Hardcoded defaults (passed by caller)
 *
 * `dirName` defaults to `"princess-pi-tools"` — every existing caller that
 * omits it resolves exactly the paths it always has.
 *
 * Returns a NEW object (defaults are not mutated).
 */
export function loadConfig(
	toolName: string,
	defaults: Record<string, unknown>,
	dirName: string = CONFIG_DIR,
): Record<string, unknown> {
	const merged = { ...defaults };

	// XDG global config (lowest user priority)
	const xdgHome = xdgConfigHome();
	const globalConfig = tryReadConfig(join(xdgHome, dirName, `${toolName}.json`));
	if (globalConfig) deepMerge(merged, globalConfig);

	// Walk-up configs from CWD (farthest first, closest last)
	const walkConfigs = walkUpConfigs(toolName, process.cwd(), dirName);
	for (let i = walkConfigs.length - 1; i >= 0; i--) {
		deepMerge(merged, walkConfigs[i]);
	}

	return merged;
}

// ---
// LEGACY API: readConfig (backward compat)
// ---

/**
 * Read merged config for a tool. Thin wrapper around `loadConfig` with no
 * defaults, kept for callers that predate that API — it runs the SAME full
 * resolution (XDG global, walk-up, deep merge), not a flat/shallow one (PR
 * #13 review; the older claim here was already stale before this diff).
 */
export function readConfig(toolName: string, dirName: string = CONFIG_DIR): Record<string, unknown> {
	return loadConfig(toolName, {}, dirName) as Record<string, unknown>;
}

// ---
// WRITE
// ---

/**
 * Persist settings for a tool. Merges into existing config at the target
 * file (reads first, overlays new keys, writes back).
 *
 * Scope resolution (when scope is omitted):
 *   - If a project-local config already exists → write local.
 *   - Otherwise → write global (~/.config/<dirName>/<tool>.json)
 *
 * `dirName` defaults to `"princess-pi-tools"` — every existing caller that
 * omits it resolves exactly the paths it always has.
 */
export function writeConfig(
	toolName: string,
	settings: Record<string, unknown>,
	scope?: "local" | "global",
	dirName: string = CONFIG_DIR,
): void {
	const paths = getConfigPaths(toolName, dirName);

	const hasLocal = existsSync(paths.local);

	let targetPath: string;
	if (scope === "local" || (scope === undefined && hasLocal)) {
		targetPath = paths.local;
	} else {
		targetPath = paths.global;
	}

	// `tryReadConfig`, not a raw `JSON.parse` — the target file legally carries
	// the same `//`/`/* */` comments `loadConfig` accepts, and a bare
	// `JSON.parse` on one THROWS, so the catch below silently treated a
	// commented-but-valid file as empty and a write discarded every existing
	// key (PR #13 review, libs#12).
	const existing = tryReadConfig(targetPath) ?? {};

	const merged = { ...existing, ...settings };

	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Check whether any config file exists for a tool (global or local).
 * `dirName` defaults to `"princess-pi-tools"`.
 */
export function hasConfig(toolName: string, dirName: string = CONFIG_DIR): boolean {
	const paths = getConfigPaths(toolName, dirName);
	return existsSync(paths.global) || existsSync(paths.local);
}
