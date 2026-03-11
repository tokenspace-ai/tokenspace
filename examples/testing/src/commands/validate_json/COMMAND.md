---
name: validate_json
description: Validate JSON from stdin (and optionally require approval)
usage: validate_json [--require-approval]
---

Reads JSON from stdin and validates it has:

- `ok` (boolean)
- `n` (optional number)

Examples:

```bash
echo '{"ok":true,"n":1}' | validate_json
echo '{"ok":true}' | validate_json --require-approval
```

