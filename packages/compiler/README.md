# `@tokenspace/compiler`

Compile a Tokenspace workspace into revision filesystem, bundle, and metadata artifacts.

## Install

```bash
bun add -d @tokenspace/compiler
```

## CLI

```bash
tokenspace-compiler build --workspace . --out-dir build/tokenspace
```

## API

```ts
import { buildWorkspace } from "@tokenspace/compiler";

const result = await buildWorkspace({
  workspaceDir: ".",
  outDir: "build/tokenspace",
});
```

## Bun

The compiler and CLI are intended for Bun-based workflows.
