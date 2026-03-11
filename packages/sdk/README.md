# `@tokenspace/sdk`

Author Tokenspace capabilities and credentials for published workspaces.

## Install

```bash
bun add @tokenspace/sdk zod
```

## Usage

```ts
import { action, credentials } from "@tokenspace/sdk";
import { z } from "zod";

export const apiKey = credentials.secret({
  id: "api-key",
  scope: "workspace",
});

export const ping = action({
  input: z.object({ message: z.string() }),
  async run({ message }) {
    return { echoed: message };
  },
});
```

## Bun

This package is intended for Bun-based Tokenspace workflows.
