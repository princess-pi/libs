// --- Config Loader: Universal hierarchical config resolution (#20) ---
//
// One file per tool. JSON with comments (stripJsonComments). Deep merge.
// Resolution order: CWD → walk-up → XDG global → hardcoded defaults.
//
// Backward compat with existing config.ts API: readConfig, writeConfig,
// hasConfig, getConfigPaths. The new loadConfig is the recommended API.
//
// Directory: .princess-pi-tools / princess-pi-tools (matching repo name).
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
	/** ~/.config/princess-pi-tools/<tool>.json */
	global: string;
	/** ./.princess-pi-tools/<tool>.json (relative to cwd) */
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
 * Resolve config file paths for a tool.
 *
 * Must resolve the global path the same way `loadConfig` does. It did not
 * before (#158): `loadConfig` honoured $XDG_CONFIG_HOME while this hardcoded
 * `~/.config`, so on any machine with XDG_CONFIG_HOME set, a tool READ one
 * file and WROTE another — a persisted setting would appear not to stick, and
 * anything driving the write path (a test, say) would land in the user's real
 * `~/.config` no matter how carefully it had isolated itself.
 */
export function getConfigPaths(toolName: string): ConfigPaths {
	const globalDir = join(xdgConfigHome(), CONFIG_DIR);
	const localDir = join(process.cwd(), `.${CONFIG_DIR}`);
	return {
		global: join(globalDir, `${toolName}.json`),
		local: join(localDir, `${toolName}.json`),
	};
}

/**
 * Walk up from startDir toward root, collecting config files.
 * Returns [closest, ..., farthest] — reversed for merge order.
 */
function walkUpConfigs(toolName: string, startDir: string): Record<string, unknown>[] {
	const results: Record<string, unknown>[] = [];
	let dir = startDir;

	while (true) {
		const currentPath = join(dir, `.${CONFIG_DIR}`, `${toolName}.json`);
		const config = tryReadConfig(currentPath);
		if (config) results.push(config);

		const parent = dirname(dir);
		if (parent === dir || parent === "/") break;
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
 *   1. $CWD/.princess-pi-tools/<tool>.json (with walk-up to ~/)
 *   2. $XDG_CONFIG_HOME/princess-pi-tools/<tool>.json
 *   3. Hardcoded defaults (passed by caller)
 *
 * Returns a NEW object (defaults are not mutated).
 */
export function loadConfig(toolName: string, defaults: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...defaults };

	// XDG global config (lowest user priority)
	const xdgHome = xdgConfigHome();
	const globalConfig = tryReadConfig(join(xdgHome, CONFIG_DIR, `${toolName}.json`));
	if (globalConfig) deepMerge(merged, globalConfig);

	// Walk-up configs from CWD (farthest first, closest last)
	const walkConfigs = walkUpConfigs(toolName, process.cwd());
	for (let i = walkConfigs.length - 1; i >= 0; i--) {
		deepMerge(merged, walkConfigs[i]);
	}

	return merged;
}

// ---
// LEGACY API: readConfig (backward compat)
// ---

/**
 * Read merged config for a tool. Legacy wrapper around loadConfig.
 * Returns flat merge (no walk-up, shallow merge) for backward compat.
 */
export function readConfig(toolName: string): Record<string, unknown> {
	return loadConfig(toolName, {}) as Record<string, unknown>;
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
 *   - Otherwise → write global (~/.config/princess-pi-tools/<tool>.json)
 */
export function writeConfig(
	toolName: string,
	settings: Record<string, unknown>,
	scope?: "local" | "global",
): void {
	const paths = getConfigPaths(toolName);

	const hasLocal = existsSync(paths.local);

	let targetPath: string;
	if (scope === "local" || (scope === undefined && hasLocal)) {
		targetPath = paths.local;
	} else {
		targetPath = paths.global;
	}

	let existing: Record<string, unknown> = {};
	try {
		const raw = readFileSync(targetPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed;
		}
	} catch {
		// No file or corrupt — start from empty.
	}

	const merged = { ...existing, ...settings };

	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Check whether any config file exists for a tool (global or local).
 */
export function hasConfig(toolName: string): boolean {
	const paths = getConfigPaths(toolName);
	return existsSync(paths.global) || existsSync(paths.local);
}
