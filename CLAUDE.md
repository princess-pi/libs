# libs

`@princess-pi/libs`: small shared modules for wtft, yada and princess-pi-tools. Public, not on
npm yet. Origin: btw#63.

## Hard gates

- **No runtime dependencies.** Every module is dependency-free; keep it that way.
- **A module exists only through `package.json`.** Adding one means a source in `extensions/lib/`,
  an entry in `exports`, and the source path in `files`. A module missing from `exports` can't be
  imported.
- **Consumers pin an exact version** (btw#63). A breaking change needs a version bump and an issue
  in each consumer.
- **`dist/` is build output**, gitignored. Edit `extensions/lib/*.ts`, then `bun run build`.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` → `dist/` |
| Test | `bun run test` — each suite in its own process |

## Modules

`config`, `build-stamp`, `manifest-help`, `session-path-shortener` — the README has one line and
one import per module. Known gap: `manifest-help` renderers accept only a file path, so a bundled
consumer can't use them (#3).

## Read first

- `docs/spec-config-loader.md` — the config resolution order every tool shares.
