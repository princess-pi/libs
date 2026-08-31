#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package @princess-pi/libs
 * @test config-persistence
 * @description Covers the WRITE side of the config module.
 *
 *   `tests/config-loader.test.ts` covers resolution (defaults → XDG → CWD →
 *   walk-up). This file covers the one thing `writeConfig` promises that a
 *   caller cannot check for itself: it MERGES into the existing file rather
 *   than clobbering it. A clobber would silently drop every unrelated setting
 *   the user has, and the caller would see its own key written correctly.
 *
 *   `"wtft"` below is fixture data — an arbitrary tool namespace and a
 *   plausible set of keys to preserve. This repo does not depend on wtft.
 *
 *   **What used to be here, and where it went (#4).** This suite arrived as a
 *   byte-identical copy of the `princess-pi-tools` original, which pins three
 *   properties: `writeConfig` merges, the `wtft` CLI never writes config, and
 *   the Pi `/wtft` extension does. The second and third need a CLI and an
 *   extension to drive. `@princess-pi/libs` ships four dependency-free modules
 *   and no binary, so those sections tested nothing here — one died on an
 *   unresolvable import, the other four passed without running anything. They
 *   remain in `princess-pi-tools/tests/config-persistence.test.ts`, unmodified
 *   and still meaningful, because that is where both surfaces live.
 *
 *   Every check runs against a temp `XDG_CONFIG_HOME` set by this file, not by
 *   the runner — the suite must be safe to run standalone, and a test about
 *   config writes is the last place to rely on someone else's isolation.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n")[0]}`);
		failed++;
	}
}

// ---
// Isolation: our own XDG root, restored on the way out.
// ---

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "libs-config-persistence-")));
const configDir = path.join(xdgRoot, "princess-pi-tools");
const configPath = path.join(configDir, "wtft.json");
const prevXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = xdgRoot;

/** Seed a config that looks like a real user's — including keys nothing here touches. */
function seedConfig(overrides: Record<string, unknown> = {}): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({
		interval: "6m",
		limit: 10,
		showTicks: true,
		mode: "cumulative",
		timezone: "America/Los_Angeles",
		tokens: true,
		...overrides,
	}, null, 2) + "\n");
}

function readConfigFile(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

console.log("🏃 Running config persistence tests...\n");

// ---
// SAFETY GATE — do not run the write tests unless writes are actually isolated.
//
// `writeConfig` targets `getConfigPaths`, and these checks overwrite whatever
// it names. So the suite proves the target is inside our temp root BEFORE it
// writes anything, and fails every write check unrun if it is not.
//
// This is not paranoia about a hypothetical. `getConfigPaths` once resolved the
// global path as `homedir()/.config` while `loadConfig` honoured
// XDG_CONFIG_HOME, so on any machine with that variable set the two disagreed
// and this suite would have rewritten the developer's real settings
// (princess-pi-tools#158 RC-4a). Both read `xdgConfigHome()` today. The gate
// stays because it is the thing that would destroy data if they ever drift
// apart again, and it costs one comparison to keep.
// ---

const { writeConfig, getConfigPaths } = await import("../extensions/lib/config.ts");

const writeTarget = getConfigPaths("wtft").global;
const writesAreIsolated = writeTarget.startsWith(xdgRoot + path.sep);

function checkWrite(label: string, fn: () => void): void {
	if (!writesAreIsolated) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       write path is NOT isolated — refusing to run.`);
		failed++;
		return;
	}
	check(label, fn);
}

if (!writesAreIsolated) {
	console.log(`\n${RED}WRITE PATH NOT ISOLATED${RESET}`);
	console.log(`  XDG_CONFIG_HOME = ${xdgRoot}`);
	console.log(`  writeConfig would target = ${writeTarget}`);
	console.log(`  getConfigPaths() and loadConfig() have drifted apart again.`);
	console.log(`  Every write check below is failed unrun rather than mutating real config.`);
}

// ---
// writeConfig merges rather than clobbers
// ---

console.log("writeConfig merges into the existing file");

checkWrite("the written key changes", () => {
	seedConfig();
	writeConfig("wtft", { tokens: false });
	assert.strictEqual(readConfigFile().tokens, false);
});

checkWrite("unrelated keys survive a targeted write", () => {
	seedConfig();
	writeConfig("wtft", { tokens: false });
	const c = readConfigFile();
	assert.strictEqual(c.timezone, "America/Los_Angeles");
	assert.strictEqual(c.interval, "6m");
	assert.strictEqual(c.limit, 10);
	assert.strictEqual(c.mode, "cumulative");
	assert.strictEqual(c.showTicks, true);
});

checkWrite("writing to a fresh path creates the file and its directory", () => {
	fs.rmSync(configDir, { recursive: true, force: true });
	writeConfig("wtft", { tokens: true });
	assert.ok(fs.existsSync(configPath));
	assert.strictEqual(readConfigFile().tokens, true);
});

// ---
// Cleanup
// ---

if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = prevXdg;
try { fs.rmSync(xdgRoot, { recursive: true, force: true }); } catch {}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
