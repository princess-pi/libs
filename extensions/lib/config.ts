// --- Config Loader: Universal hierarchical config resolution (#20) ---
//
// One file per tool. JSON with comments (stripJsonComments). Deep merge.
// Resolution order: CWD → walk-up → XDG global → hardcoded defaults.
//
// Backward compat with existing config.ts API: readConfig, writeConfig,
// hasConfig, getConfigPaths. The new loadConfig is the recommended API.
//
// Directory: .princess-pi-tools / princess-pi-tools (matching repo name).
// Legacy directory (princess-pi-packages) is checked as fallback for read
// operations during migration; oldest legacy (princess-pi) is also checked.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---
// CONSTANTS
// ---

const CONFIG_DIR = "princess-pi-tools";
const LEGACY_CONFIG_DIR = "princess-pi-packages";
const OLD_CONFIG_DIR = "princess-pi";

/**
 * Deduped per legacy FILE, not per process: one resolution can read several
 * legacy files — the XDG global one, plus a project-local `.princess-pi-packages/`
 * at any level of the walk-up — and each is a separate thing to move. A single
 * process-wide flag reported whichever fired first and silently used the rest,
 * so a user could migrate the named file and still be on legacy config.
 */
const _legacyDeprecationsEmitted = new Set<string>();

/**
 * Names the file actually read, so the notice never points at the wrong one.
 *
 * Exported because the two configs that resolve their own XDG path —
 * wtft-pricing.json and wtft-harnesses.json — need the same notice, and sharing
 * this dedupe Set is what keeps one legacy file to one notice across all of them.
 */
export function emitLegacyDeprecation(legacyPath: string, currentPath: string): void {
	if (_legacyDeprecationsEmitted.has(legacyPath)) return;
	_legacyDeprecationsEmitted.add(legacyPath);
	process.stderr.write(
		`[princess-pi-tools] config: reading from legacy ${legacyPath} — ` +
		`move it to ${currentPath} to silence this\n`,
	);
}

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
 * Also returns legacy paths (old directory) for migration read fallback.
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

function getLegacyConfigPaths(toolName: string): ConfigPaths {
	const globalDir = join(xdgConfigHome(), LEGACY_CONFIG_DIR);
	const localDir = join(process.cwd(), `.${LEGACY_CONFIG_DIR}`);
	return {
		global: join(globalDir, `${toolName}.json`),
		local: join(localDir, `${toolName}.json`),
	};
}

function getOldConfigPaths(toolName: string): ConfigPaths {
	const globalDir = join(xdgConfigHome(), OLD_CONFIG_DIR);
	const localDir = join(process.cwd(), `.${OLD_CONFIG_DIR}`);
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
		// Check new path, then legacy (princess-pi-packages), then oldest (princess-pi)
		const currentPath = join(dir, `.${CONFIG_DIR}`, `${toolName}.json`);
		let config = tryReadConfig(currentPath);
		if (!config) {
			const legacyPath = join(dir, `.${LEGACY_CONFIG_DIR}`, `${toolName}.json`);
			const legacy = tryReadConfig(legacyPath);
			if (legacy) { emitLegacyDeprecation(legacyPath, currentPath); config = legacy; }
		}
		if (!config) {
			config = tryReadConfig(join(dir, `.${OLD_CONFIG_DIR}`, `${toolName}.json`));
		}
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
 * Legacy directories (princess-pi-packages, princess-pi) are checked as read
 * fallbacks during migration; princess-pi-packages emits a deprecation notice.
 *
 * Returns a NEW object (defaults are not mutated).
 */
export function loadConfig(toolName: string, defaults: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...defaults };

	// XDG global config (lowest user priority)
	const xdgHome = xdgConfigHome();
	const currentGlobalPath = join(xdgHome, CONFIG_DIR, `${toolName}.json`);
	let globalConfig = tryReadConfig(currentGlobalPath);
	if (!globalConfig) {
		// Migration fallback: legacy directory (princess-pi-packages)
		const legacyGlobalPath = join(xdgHome, LEGACY_CONFIG_DIR, `${toolName}.json`);
		const legacyGlobal = tryReadConfig(legacyGlobalPath);
		if (legacyGlobal) { emitLegacyDeprecation(legacyGlobalPath, currentGlobalPath); globalConfig = legacyGlobal; }
	}
	if (!globalConfig) {
		// Oldest migration fallback: princess-pi
		globalConfig = tryReadConfig(join(xdgHome, OLD_CONFIG_DIR, `${toolName}.json`));
	}
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
// WRITE (always targets new directory path)
// ---

/**
 * Persist settings for a tool. Merges into existing config at the target
 * file (reads first, overlays new keys, writes back).
 *
 * Scope resolution (when scope is omitted):
 *   - If a project-local config already exists → write local. That counts a
 *     legacy-named override too: ./.princess-pi-tools/, ./.princess-pi-packages/
 *     or ./.princess-pi/<tool>.json. Checking only the new name sent a user with
 *     a pre-rename local override to the GLOBAL file, where the read path
 *     (walkUpConfigs, which does find the legacy local file) would then disagree
 *     with the write path about where the setting lived.
 *   - Otherwise → write global (~/.config/princess-pi-tools/<tool>.json)
 *
 * Always writes to the new directory path (princess-pi-tools), and when the
 * target does not exist yet it SEEDS from the legacy file the read path would
 * have resolved — see migrateOnWrite below for why that is not optional.
 */
export function writeConfig(
	toolName: string,
	settings: Record<string, unknown>,
	scope?: "local" | "global",
): void {
	const paths = getConfigPaths(toolName);
	const legacyPaths = getLegacyConfigPaths(toolName);
	const oldPaths = getOldConfigPaths(toolName);

	// A local override counts for scope detection whichever directory name it
	// carries. Checking only the NEW local path sent a user with a pre-rename
	// ./.princess-pi-packages/ override to the GLOBAL file instead: their local
	// override stayed put and unread by the write, a global file appeared that
	// had never existed, and the read path — walkUpConfigs, which does find the
	// legacy local file — then disagreed with the write path about where the
	// setting lived.
	const hasLocal =
		existsSync(paths.local) || existsSync(legacyPaths.local) || existsSync(oldPaths.local);

	let targetPath: string;
	let legacyFallbacks: string[];
	if (scope === "local" || (scope === undefined && hasLocal)) {
		targetPath = paths.local;
		legacyFallbacks = [legacyPaths.local, oldPaths.local];
	} else {
		targetPath = paths.global;
		legacyFallbacks = [legacyPaths.global, oldPaths.global];
	}

	let existing: Record<string, unknown> = {};
	try {
		const raw = readFileSync(targetPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed;
		}
	} catch {
		// No file or corrupt — fall through to the legacy seed below.
	}

	// --- migrateOnWrite ---
	// Reads resolve new-dir OR legacy-dir, first hit wins; writes only ever
	// target the new dir. Without this seed a user whose config lives only in
	// the legacy dir loses it on their FIRST write: the new file is created
	// holding just the written keys, and because it now exists the legacy file
	// is never consulted again. Every other setting is orphaned silently, with
	// nothing to notice it by. Seeding makes the first write the migration.
	//
	// The trigger is "the target does not exist", NOT "it parsed to no keys":
	// a user who deliberately empties their new-format config to `{}` to stop
	// inheriting old settings has expressed a state, and re-seeding would undo
	// it on their next write. An existing file — empty, or corrupt — is the
	// user's, and is left to speak for itself.
	if (!existsSync(targetPath)) {
		for (const legacyPath of legacyFallbacks) {
			const seed = tryReadConfig(legacyPath);
			if (seed) {
				existing = seed;
				emitLegacyDeprecation(legacyPath, targetPath);
				break;
			}
		}
	}

	const merged = { ...existing, ...settings };

	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Check whether any config file exists for a tool (global or local).
 * Checks both new and old directories.
 */
export function hasConfig(toolName: string): boolean {
	const newPaths = getConfigPaths(toolName);
	const legacyPaths = getLegacyConfigPaths(toolName);
	const oldPaths = getOldConfigPaths(toolName);
	return (
		existsSync(newPaths.global) || existsSync(newPaths.local) ||
		existsSync(legacyPaths.global) || existsSync(legacyPaths.local) ||
		existsSync(oldPaths.global) || existsSync(oldPaths.local)
	);
}
