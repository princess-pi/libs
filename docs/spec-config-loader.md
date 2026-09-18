# Universal Configuration Loading Standard (Spec)

## Problem

Tools in princess-pi-tools (`wtft`, `serve`, `merge`, etc.) have no persistent shared configuration. They rely on hardcoded defaults + CLI arguments passed per invocation. No way to set preferences once and have them apply everywhere.

## Design

### Format

JSON with comments — same pattern as Pi's `models.json`. Parsed with `stripJsonComments` for zero-dependency comment support and standard `JSON.parse`.

### File Layout

One file per tool — the tool name IS the filename, under a directory named for the
consuming project:

```
~/.config/princess-pi-tools/wtft.json
~/.config/princess-pi-tools/serve.json
```

Per-project overrides at `$CWD/.princess-pi-tools/<tool>.json`.

**The directory name is a parameter, not a constant (libs#12, princess-pi/wtft#156).**
Every function takes it as a trailing optional argument, defaulting to
`"princess-pi-tools"` — every caller in this repo keeps today's paths unchanged. A tool
that is not part of princess-pi-tools (wtft, once extracted) passes its own name and gets
`~/.config/<its-name>/<file>.json` instead.

### Resolution Order (Cascading)

1. **Local override:** `$CWD/.<dirName>/<tool>.json`
2. **Directory walk:** Walk up from `$CWD` to `~/` looking for `.<dirName>/<tool>.json` at each level, stop at home or root
3. **XDG global:** `$XDG_CONFIG_HOME/<dirName>/<tool>.json` (fallback `~/.config/<dirName>/<tool>.json`)
4. **Hardcoded defaults:** Fall back to the defaults passed by the tool

`dirName` defaults to `"princess-pi-tools"` everywhere above.

### Merge Strategy

**Deep merge** (field-level), applied from lowest priority to highest:

- **Scalars:** Higher-priority value overwrites
- **Objects:** Recursive deep merge
- **Arrays:** Higher-priority array replaces entirely (no concatenation)
- **`null`:** Explicitly unsets a key — clears the value, falls back to hardcoded default

### Responsibilities

| Concern | Owner |
|---|---|
| File discovery, parsing, merging | `config-loader.ts` |
| Schema validation, type coercion | Each tool (at use-time) |
| Debug/trace config resolution | dotfiles-doctor |

### API

```ts
export function loadConfig(toolName: string, defaults: Record<string, unknown>, dirName?: string): Record<string, unknown>
```

Synchronous, pure filesystem. Zero dependencies. No validation. `getConfigPaths`,
`readConfig`, `writeConfig`, and `hasConfig` take the same trailing optional `dirName`.

### Scope

- This spec: `config-loader.ts` module + WTFT as first consumer
- Follow-up issues: wire `serve`, `merge`, etc. per tool

### Cross-repo compatibility

Watu (Rust) — specs should be compatible. Same file hierarchy, same merge semantics. Code not shared (Rust vs TypeScript), but a watu developer should recognize the format and resolution strategy.

## Roads Not Taken

- **YAML/TOML:** Rejected for zero-dependency requirement. JSON with `stripJsonComments` is universal and instant.
- **Single-file with tool namespaces:** Rejected for per-package modularity. One file per tool means watu and node packages each own their files with no namespace collisions.
- **Deep merge on arrays:** Rejected — concatenation is surprising when you want to replace an ignore list. Explicit replace is clearer.
- **Validation in loader:** Rejected — couples the loader to every tool's schema. Each tool validates its own keys at use-time.
