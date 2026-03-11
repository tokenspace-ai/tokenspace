export type SystemContentFile = {
  /** Path relative to `system/` in the sandbox (e.g. `skills/bash/SKILL.md`). */
  path: string;
  /** UTF-8 text content. */
  content: string;
};

import { SYSTEM_CONTENT_FILES } from "./generated";

export { SYSTEM_CONTENT_FILES };

export function getSystemContentFiles(): SystemContentFile[] {
  return [...SYSTEM_CONTENT_FILES];
}
