# @princess-pi/libs

Shared library utilities for the Princess Pi tool suite. Four small, dependency-free modules extracted from [`duppypro/princess-pi-tools`](https://github.com/duppypro/princess-pi-tools) for use by [`@princess-pi/wtft`](https://github.com/princess-pi/wtft) and [`@princess-pi/yada`](https://github.com/princess-pi/yada).

> Built by the AI Princess Pi. Inspired by her human, Duppy ([github.com/duppypro](https://github.com/duppypro)).

**Origin:** [btw#63](https://github.com/duppypro/btw/issues/63) — the spec and sequencing that produced this split.

---

## Modules

### `@princess-pi/libs/config`

Hierarchical config loader. Resolves JSON-with-comments config files by walking up from `$CWD` through `$XDG_CONFIG_HOME`, deep-merging with hardcoded defaults. One file per tool.

```ts
import { loadConfig, readConfig, writeConfig, hasConfig } from "@princess-pi/libs/config";
```

### `@princess-pi/libs/build-stamp`

Reports which built artifact is actually running — for tools installed via `bun link` or `install-workflow-tools`, where the binary on `PATH` may not be the branch you are editing.

```ts
import { formatVersion } from "@princess-pi/libs/build-stamp";
```

### `@princess-pi/libs/manifest-help`

Renders `--help` output from a JSON manifest file. Used by wtft, yada, and serve.

```ts
import { renderHelp, renderWhy } from "@princess-pi/libs/manifest-help";
```

### `@princess-pi/libs/session-path-shortener`

Compact display paths for session logs, shared between the WTFT CLI and the Serve extension. No external dependencies.

```ts
import { buildDisplayPath, shortenPath } from "@princess-pi/libs/session-path-shortener";
```

---

## Install

```sh
npm install @princess-pi/libs
```

Or for development, with an exact version pin (required — see [why exact pins matter](https://github.com/duppypro/btw/issues/63)):

```sh
npm install @princess-pi/libs@1.0.0
```

## License

[MIT-0](./LICENSE) — no attribution required.
