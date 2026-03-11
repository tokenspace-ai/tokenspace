# `@tokenspace/runtime-core`

Run compiled Tokenspace bundles inside the Tokenspace runtime.

## Install

```bash
bun add @tokenspace/runtime-core @tokenspace/sdk
```

## Usage

```ts
import { executeCode } from "@tokenspace/runtime-core";

const result = await executeCode("console.log('hello')");
console.log(result.output);
```

## Bun

This package requires Bun at runtime.
