#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package @princess-pi/libs
 * @test repo-scope
 * @description Every suite in this repo must test THIS repo (#4).
 *
 *   The four modules here were extracted from `princess-pi-tools`, and their
 *   suites came over as byte-identical copies. The copies kept the sections
 *   that reach for a CLI (`bin/wtft.mjs`) and a Pi extension
 *   (`extensions/wtft.ts`) that live in that repo and will never live in this
 *   one — `@princess-pi/libs` ships four dependency-free modules and no binary.
 *
 *   Both halves of that failure were worth a guard, because only one of them
 *   was loud:
 *
 *   1. An unresolvable import kills the suite outright. Loud, and already
 *      fixed by the trim — but nothing stopped it being introduced, and the
 *      next extraction will copy files the same way.
 *   2. A path built from `REPO_ROOT` toward a directory that does not exist
 *      is SILENT. `config-persistence.test.ts` spawned `<root>/bin/wtft.mjs`
 *      inside a `try` whose `catch` discarded the exit status on purpose, so
 *      `ENOENT` looked exactly like "the CLI ran and wrote nothing" and four
 *      checks reported PASS without executing anything.
 *
 *   So this suite reads the other suites as text and asserts they only reach
 *   for things that are here. It is the executable form of #4's closer.
 *
 *   Why text and not resolution-at-runtime: importing every suite to see which
 *   ones throw would run them, and several spawn processes and write temp
 *   trees. Reading the source costs nothing and cannot have side effects.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

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
		console.log(`       ${(err as Error).message.split("\n").join("\n       ")}`);
		failed++;
	}
}

// ---
// Layout
// ---

const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

/** Every `.ts` under `tests/`, suites and helpers alike — a helper can reach out too. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...sourceFiles(p));
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out.sort();
}

const files = sourceFiles(TESTS_DIR).filter(f => f !== import.meta.filename);

// ---
// Extraction
//
// Regexes over source text, not a parser: the shapes below are the only two
// ways a suite here reaches outside itself, and both are unambiguous enough
// that a parser would buy nothing. A new shape should fail loudly by being
// missed here rather than be guessed at.
// ---

/** `from "./x"` and `from "../x"` — static imports and re-exports. */
const STATIC_IMPORT = /\bfrom\s+["'](\.\.?\/[^"']+)["']/g;

/** `import("./x")` — dynamic imports, which is how the wtft extension got in. */
const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;

/** `path.join(REPO_ROOT, "bin", ...)` — the silent half. First segment only. */
const REPO_ROOT_JOIN = /\bpath\.join\(\s*REPO_ROOT\s*,\s*["']([^"'/]+)["']/g;

function matches(src: string, re: RegExp): string[] {
	return [...src.matchAll(re)].map(m => m[1]);
}

/** Node/bun resolution, narrowed to what these suites actually use. */
function resolves(from: string, spec: string): boolean {
	const base = path.resolve(path.dirname(from), spec);
	const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts")];
	return candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile());
}

console.log("🏃 Running repo-scope tests (#4)...\n");

// ---
// 1. Imports resolve
// ---

console.log("1. every relative import in tests/ resolves to a file that exists");

for (const file of files) {
	const rel = path.relative(REPO_ROOT, file);
	const src = fs.readFileSync(file, "utf8");
	const specs = [...matches(src, STATIC_IMPORT), ...matches(src, DYNAMIC_IMPORT)];

	check(`${rel} (${specs.length} relative import${specs.length === 1 ? "" : "s"})`, () => {
		const missing = specs.filter(s => !resolves(file, s));
		assert.deepStrictEqual(missing, [],
			`unresolvable from ${rel}: ${missing.join(", ")}\n` +
			`this repo ships four modules and no binary — a suite reaching outside it was copied, not written`);
	});
}

// ---
// 2. Paths built from REPO_ROOT name something that is here
// ---

console.log("\n2. every path built from REPO_ROOT names a directory this repo has");

for (const file of files) {
	const rel = path.relative(REPO_ROOT, file);
	const src = fs.readFileSync(file, "utf8");
	const segments = [...new Set(matches(src, REPO_ROOT_JOIN))];

	check(`${rel} (${segments.length} REPO_ROOT join${segments.length === 1 ? "" : "s"})`, () => {
		const absent = segments.filter(s => !fs.existsSync(path.join(REPO_ROOT, s)));
		assert.deepStrictEqual(absent, [],
			`${rel} builds paths under ${absent.map(s => `${s}/`).join(", ")}, which does not exist here\n` +
			`a spawn against a missing path fails with ENOENT, and a suite that swallows exit status reads that as success`);
	});
}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);
