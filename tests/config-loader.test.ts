// --- Config Loader Tests (#20) ---
//
// Creates temporary directory structures to verify hierarchical resolution,
// deep merge semantics, array replacement, null unsetting, and error resilience.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { trackSandbox } from "./lib/sandbox";

// We import from the TS source directly (test runner resolves via tsx).
// The loader uses process.cwd() — we must chdir into the temp tree for walk-up tests.
const originalCwd = process.cwd();

let testDir: string;
let pass = 0;
let fail = 0;

function ok(label: string, condition: boolean, detail?: string) {
	if (condition) {
		pass++;
		console.log(`  ✅ ${label}`);
	} else {
		fail++;
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

const originalXdg = process.env.XDG_CONFIG_HOME;

// EVERY test in this file is sandboxed here — setup() repoints XDG_CONFIG_HOME
// before each one, so no individual test needs to, and none may skip it. The
// write tests would otherwise land in the developer's real
// ~/.config/princess-pi-tools/, so the isolation keeps a test from mutating real
// config as a side effect.
function setup() {
	testDir = trackSandbox(mkdtempSync(join(tmpdir(), "config-loader-test-")));
	process.chdir(testDir);
	// Isolate from real user config.
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");
}

function teardown() {
	process.chdir(originalCwd);
	rmSync(testDir, { recursive: true, force: true });
	// Restore rather than leave it pointing at a directory just deleted, so a
	// later file sharing this process cannot inherit a dangling config root.
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
}

// --- Test 1: Defaults only (no config files exist) ---

setup();
{
	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 10 });
	ok("defaults only — preserves interval", config.interval === "1h");
	ok("defaults only — preserves limit", config.limit === 10);
	ok("defaults only — returns new object", config !== (loadConfig as any).defaultsRef);
}
teardown();

// --- Test 2: XDG global config ---

setup();
{
	const xdgDir = join(testDir, ".config", "princess-pi-tools");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({ interval: "2h", width: 120 }));

	// Override XDG_CONFIG_HOME to point to our temp tree
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 10 });

	ok("XDG global — overrides interval", config.interval === "2h");
	ok("XDG global — adds width", config.width === 120);
	ok("XDG global — keeps default limit", config.limit === 10);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 3: Project override (CWD) overrides XDG ---

setup();
{
	const xdgDir = join(testDir, ".config", "princess-pi-tools");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({ interval: "2h", limit: 10 }));

	const projectDir = join(testDir, ".princess-pi-tools");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "wtft.json"), JSON.stringify({ limit: 5 }));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100, width: 80 });

	ok("project override — CWD limit wins over XDG", config.limit === 5);
	ok("project override — XDG interval preserved", config.interval === "2h");
	ok("project override — default width preserved", config.width === 80);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 4: Walk-up — nearest project wins ---

setup();
{
	// Deep nested project structure
	const deep = join(testDir, "projects", "sub", "deep");
	mkdirSync(join(deep, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(deep, ".princess-pi-tools", "wtft.json"), JSON.stringify({ limit: 5 }));

	const mid = join(testDir, "projects");
	mkdirSync(join(mid, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(mid, ".princess-pi-tools", "wtft.json"), JSON.stringify({ limit: 20, width: 100 }));

	process.chdir(deep);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100, width: 80 });

	ok("walk-up — CWD limit wins (nearest)", config.limit === 5);
	ok("walk-up — mid width is merged", config.width === 100);
	ok("walk-up — default interval preserved", config.interval === "1h");
}
teardown();

// --- Test 5: null unsets ---

setup();
{
	const mid = join(testDir, "projects");
	mkdirSync(join(mid, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(mid, ".princess-pi-tools", "wtft.json"), JSON.stringify({ interval: "2h", width: 100 }));

	const deep = join(testDir, "projects", "sub");
	mkdirSync(join(deep, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(deep, ".princess-pi-tools", "wtft.json"), JSON.stringify({ interval: "1h", width: null }));

	process.chdir(deep);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "m", width: 80, limit: 50 });

	ok("null unsets — CWD interval wins over mid", config.interval === "1h");
	ok("null unsets — width null clears mid, unset in result", !("width" in config));
	ok("null unsets — limit from defaults preserved", config.limit === 50);
}
teardown();

// --- Test 6: Deep merge on nested objects ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-tools", "wtft.json"), JSON.stringify({
		cost: { input: 3.00 },
		warning: { threshold: 0.30 },
	}));

	const xdgDir = join(testDir, ".config", "princess-pi-tools");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({
		cost: { input: 1.00, output: 15.00 },
		warning: { threshold: 0.20, absolute: 5.00 },
	}));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { cost: { input: 0, output: 0, cacheRead: 0 } }) as any;

	ok("deep merge — CWD cost.input wins", config.cost.input === 3.00);
	ok("deep merge — XDG cost.output preserved", config.cost.output === 15.00);
	ok("deep merge — default cost.cacheRead preserved", config.cost.cacheRead === 0);
	ok("deep merge — CWD warning.threshold wins", config.warning.threshold === 0.30);
	ok("deep merge — XDG warning.absolute preserved", config.warning.absolute === 5.00);

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 7: Array replacement ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-tools", "wtft.json"), JSON.stringify({
		ignore: ["dist", ".next"],
	}));

	const xdgDir = join(testDir, ".config", "princess-pi-tools");
	mkdirSync(xdgDir, { recursive: true });
	writeFileSync(join(xdgDir, "wtft.json"), JSON.stringify({
		ignore: ["node_modules", ".git"],
	}));

	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = join(testDir, ".config");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", {}) as any;

	ok("array replace — CWD array wins", Array.isArray(config.ignore) && config.ignore.length === 2);
	ok("array replace — contains CWD values", config.ignore?.[0] === "dist" && config.ignore?.[1] === ".next");

	process.env.XDG_CONFIG_HOME = prevXdg;
}
teardown();

// --- Test 8: JSON with comments ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-tools", "wtft.json"), `{
		// User preference — faster updates
		"interval": "30m",
		/*
		 * Compact display for small screens
		 */
		"width": 60,
		"limit": /* inline comment */ 5
	}`);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 100 });

	ok("comments — interval from commented JSON", config.interval === "30m");
	ok("comments — width from commented JSON", config.width === 60);
	ok("comments — limit from commented JSON", config.limit === 5);
}
teardown();

// --- Test 9: Missing config file — no error ---

setup();
{
	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("nonexistent", { flag: true });
	ok("missing file — returns defaults", config.flag === true);
}
teardown();

// --- Test 10: Malformed JSON — graceful fallback ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-tools", "wtft.json"), "{ not valid json at all }");

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("malformed JSON — returns defaults without crashing", config.interval === "1h");
}
teardown();

// --- Test 11: Top-level non-object — graceful fallback ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(join(testDir, ".princess-pi-tools", "wtft.json"), `[1, 2, 3]`);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("array top-level — returns defaults without crashing", config.interval === "1h");
}
teardown();

// --- Test 12: the legacy XDG dir is NOT read (rename migration is complete) ---

setup();
{
	const legacyDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "wtft.json"), JSON.stringify({ interval: "9h", limit: 42 }));

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h", limit: 10 });
	ok("legacy XDG dir — ignored, default interval kept", config.interval === "1h", `got ${config.interval}`);
	ok("legacy XDG dir — ignored, default limit kept", config.limit === 10, `got ${config.limit}`);
}
teardown();

// --- Test 13: the oldest legacy dir (princess-pi) is NOT read either ---

setup();
{
	const oldDir = join(testDir, ".config", "princess-pi");
	mkdirSync(oldDir, { recursive: true });
	writeFileSync(join(oldDir, "wtft.json"), JSON.stringify({ interval: "7h" }));

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("oldest legacy dir — ignored, default kept", config.interval === "1h", `got ${config.interval}`);
}
teardown();

// --- Test 14: a project-local legacy dir is NOT read while walking up ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-packages"), { recursive: true });
	writeFileSync(
		join(testDir, ".princess-pi-packages", "wtft.json"),
		JSON.stringify({ interval: "local-legacy" }),
	);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("wtft", { interval: "1h" });
	ok("project-local legacy dir — ignored, default kept", config.interval === "1h", `got ${config.interval}`);
}
teardown();

// --- Test 15: writeConfig does NOT seed from a legacy file ---

setup();
{
	const legacyDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(
		join(legacyDir, "tpm.json"),
		JSON.stringify({ widget: true, footer: false, interval: "4h" }),
	);

	const { writeConfig, loadConfig } = await import("../extensions/lib/config.ts");
	writeConfig("tpm", { disabledEmoji: true });

	const after = loadConfig("tpm", {});
	ok("no legacy seed — the written key lands", after.disabledEmoji === true);
	ok("no legacy seed — legacy keys are not resurrected", after.widget === undefined, `widget=${after.widget}`);
	ok("no legacy seed — legacy scalar not resurrected", after.interval === undefined, `interval=${after.interval}`);
}
teardown();

// --- Test 16: a legacy project-local override does NOT steer the write scope ---

setup();
{
	const legacyLocal = join(testDir, ".princess-pi-packages");
	mkdirSync(legacyLocal, { recursive: true });
	writeFileSync(join(legacyLocal, "tpm.json"), JSON.stringify({ widget: true, interval: "7h" }));

	const { writeConfig } = await import("../extensions/lib/config.ts");
	writeConfig("tpm", { footer: true });

	const newLocal = join(testDir, ".princess-pi-tools", "tpm.json");
	const newGlobal = join(testDir, ".config", "princess-pi-tools", "tpm.json");
	ok("legacy local override — ignored, write goes global", !existsSync(newLocal) && existsSync(newGlobal));
}
teardown();

// --- Test 17: an existing new-dir config is not re-seeded from a legacy file ---

setup();
{
	const newDir = join(testDir, ".config", "princess-pi-tools");
	const legacyDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(newDir, { recursive: true });
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(newDir, "tpm.json"), JSON.stringify({ widget: false }));
	writeFileSync(join(legacyDir, "tpm.json"), JSON.stringify({ widget: true, stale: "yes" }));

	const { writeConfig, loadConfig } = await import("../extensions/lib/config.ts");
	writeConfig("tpm", { footer: true });

	const after = loadConfig("tpm", {});
	ok("no re-seed — new-dir value is kept", after.widget === false, `widget=${after.widget}`);
	ok("no re-seed — legacy-only key is not resurrected", after.stale === undefined, `stale=${after.stale}`);
}
teardown();

// --- Test 18: an intentionally-emptied new config is not re-seeded from a legacy file ---

setup();
{
	const newDir = join(testDir, ".config", "princess-pi-tools");
	const legacyDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(newDir, { recursive: true });
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(newDir, "tpm.json"), "{}");
	writeFileSync(join(legacyDir, "tpm.json"), JSON.stringify({ widget: true, interval: "4h" }));

	const { writeConfig, loadConfig } = await import("../extensions/lib/config.ts");
	writeConfig("tpm", { footer: true });

	const after = loadConfig("tpm", {});
	ok("emptied config — written key lands", after.footer === true);
	ok("emptied config — legacy keys stay cleared", after.widget === undefined, `widget=${after.widget}`);
	ok("emptied config — legacy scalar stays cleared", after.interval === undefined, `interval=${after.interval}`);
}
teardown();

// --- Test 19: hasConfig ignores legacy dirs ---

setup();
{
	const legacyDir = join(testDir, ".config", "princess-pi-packages");
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "tpm.json"), JSON.stringify({ widget: true }));

	const { hasConfig } = await import("../extensions/lib/config.ts");
	ok("hasConfig — legacy-only config is reported absent", hasConfig("tpm") === false);
}
teardown();

// --- Test 20: custom dirName — reads its own dir, default dir unaffected (#158, libs#12) ---

setup();
{
	const customDir = join(testDir, ".config", "wtft");
	mkdirSync(customDir, { recursive: true });
	writeFileSync(join(customDir, "config.json"), JSON.stringify({ interval: "9h", limit: 42 }));

	const defaultDir = join(testDir, ".config", "princess-pi-tools");
	mkdirSync(defaultDir, { recursive: true });
	writeFileSync(join(defaultDir, "config.json"), JSON.stringify({ interval: "1h", limit: 1 }));

	const { loadConfig } = await import("../extensions/lib/config.ts");

	const custom = loadConfig("config", { interval: "default", limit: 0 }, "wtft");
	ok("custom dirName — reads its own dir", custom.interval === "9h", `got ${custom.interval}`);
	ok("custom dirName — reads its own dir (limit)", custom.limit === 42, `got ${custom.limit}`);

	const unqualified = loadConfig("config", { interval: "default", limit: 0 });
	ok(
		"custom dirName — default caller is unaffected by a custom-dir file beside it",
		unqualified.interval === "1h" && unqualified.limit === 1,
		`got ${JSON.stringify(unqualified)}`,
	);
}
teardown();

// --- Test 21: custom dirName — getConfigPaths, writeConfig, hasConfig all honour it ---

setup();
{
	const { getConfigPaths, writeConfig, hasConfig, loadConfig } = await import("../extensions/lib/config.ts");

	const paths = getConfigPaths("config", "wtft");
	ok(
		"custom dirName — getConfigPaths global path names the custom dir",
		paths.global === join(testDir, ".config", "wtft", "config.json"),
		paths.global,
	);

	ok("custom dirName — hasConfig false before write", hasConfig("config", "wtft") === false);
	writeConfig("config", { limit: 7 }, undefined, "wtft");
	ok("custom dirName — hasConfig true after write", hasConfig("config", "wtft") === true);
	ok(
		"custom dirName — hasConfig for the default dir is unaffected",
		hasConfig("config") === false,
	);

	const after = loadConfig("config", { limit: 0 }, "wtft");
	ok("custom dirName — writeConfig wrote to the custom dir", after.limit === 7, `got ${after.limit}`);
}
teardown();

// --- Test 22: writeConfig preserves existing keys when the file has JSON comments (PR #13 finding) ---

setup();
{
	mkdirSync(join(testDir, ".princess-pi-tools"), { recursive: true });
	writeFileSync(
		join(testDir, ".princess-pi-tools", "wtft.json"),
		`{\n\t// kept across the write\n\t"interval": "2h"\n}`,
	);

	const { writeConfig, loadConfig } = await import("../extensions/lib/config.ts");
	writeConfig("wtft", { limit: 9 }, "local");

	const after = loadConfig("wtft", {});
	ok("writeConfig + comments — new key lands", after.limit === 9, `got ${JSON.stringify(after)}`);
	ok(
		"writeConfig + comments — existing key survives a write, not discarded by a failed JSON.parse",
		after.interval === "2h",
		`got ${JSON.stringify(after)}`,
	);
}
teardown();

// --- Test 23: walk-up does not cross the home directory boundary (PR #13 finding) ---

setup();
{
	const home = join(testDir, "home", "duppy");
	const project = join(home, "projects", "wtft");
	mkdirSync(project, { recursive: true });

	// A shared ancestor OUTSIDE the home boundary — siblings, or the ancestor
	// of home itself, could belong to an unrelated project or user.
	const outsideAncestor = join(testDir, "home");
	mkdirSync(join(outsideAncestor, ".wtft"), { recursive: true });
	writeFileSync(join(outsideAncestor, ".wtft", "config.json"), JSON.stringify({ leaked: true }));

	// A config AT the home boundary itself is still honoured — only crossing
	// past it is out of bounds.
	mkdirSync(join(home, ".wtft"), { recursive: true });
	writeFileSync(join(home, ".wtft", "config.json"), JSON.stringify({ atHome: true }));

	const prevHome = process.env.HOME;
	process.env.HOME = home;
	process.chdir(project);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("config", { leaked: false, atHome: false }, "wtft");

	ok("walk-up boundary — config AT home is read", config.atHome === true, `got ${JSON.stringify(config)}`);
	ok(
		"walk-up boundary — a shared ancestor OUTSIDE home is not read",
		config.leaked === false,
		`got ${JSON.stringify(config)}`,
	);

	if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
}
teardown();

// --- Test 24: walk-up boundary survives a trailing slash on $HOME (PR #13 round-2 finding) ---

setup();
{
	const home = join(testDir, "home", "duppy");
	const project = join(home, "projects", "wtft");
	mkdirSync(project, { recursive: true });

	const outsideAncestor = join(testDir, "home");
	mkdirSync(join(outsideAncestor, ".wtft"), { recursive: true });
	writeFileSync(join(outsideAncestor, ".wtft", "config.json"), JSON.stringify({ leaked: true }));

	mkdirSync(join(home, ".wtft"), { recursive: true });
	writeFileSync(join(home, ".wtft", "config.json"), JSON.stringify({ atHome: true }));

	const prevHome = process.env.HOME;
	// The one difference from Test 23: a trailing slash, the way a shell
	// completion or an inherited env sometimes writes $HOME.
	process.env.HOME = home + "/";
	process.chdir(project);

	const { loadConfig } = await import("../extensions/lib/config.ts");
	const config = loadConfig("config", { leaked: false, atHome: false }, "wtft");

	ok("trailing-slash HOME — config AT home is still read", config.atHome === true, `got ${JSON.stringify(config)}`);
	ok(
		"trailing-slash HOME — the boundary still holds, ancestor outside home is not read",
		config.leaked === false,
		`got ${JSON.stringify(config)}`,
	);

	if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
}
teardown();

// --- Summary ---

console.log(`\n──────────────────────────────`);
console.log(`Results: ${pass} passed, ${fail} failed`);

if (fail > 0) process.exit(1);
