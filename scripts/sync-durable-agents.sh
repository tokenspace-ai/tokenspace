#!/bin/bash
# Sync durable-agents component back to original codebase
#
# This script copies changes made to the @tokenspace/convex-durable-agents package
# back to the original convex-durable-agents repository.
#
# Usage: ./scripts/sync-durable-agents.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKENSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_ROOT="/Users/sp/dev/convex/durable-agents"

# Source directories (from the new package location)
COMPONENT_SRC="$TOKENSPACE_ROOT/packages/durable-agents/src/component"
CLIENT_SRC="$TOKENSPACE_ROOT/packages/durable-agents/src/client"
REACT_SRC="$TOKENSPACE_ROOT/packages/durable-agents/src/react"

# Target directories
TARGET_COMPONENT="$TARGET_ROOT/src/component"
TARGET_CLIENT="$TARGET_ROOT/src/client"
TARGET_REACT="$TARGET_ROOT/src/react"

# Check if target exists
if [ ! -d "$TARGET_ROOT" ]; then
  echo "Error: Target directory not found: $TARGET_ROOT"
  exit 1
fi

echo "Syncing durable-agents component files..."
echo "  From: $TOKENSPACE_ROOT/packages/durable-agents"
echo "  To:   $TARGET_ROOT"
echo ""

# sync_dir copies all .ts/.tsx files from a source dir to a target dir,
# excluding _generated, __fixtures__, __snapshots__, and test files.
sync_dir() {
  local src_dir="$1"
  local dst_dir="$2"
  local label="$3"

  echo "Syncing $label..."
  find "$src_dir" -type f \( -name '*.ts' -o -name '*.tsx' \) \
    ! -path '*/_generated/*' \
    ! -path '*/__fixtures__/*' \
    ! -path '*/__snapshots__/*' \
    ! -path '*/test/*' \
    ! -name '*.test.ts' \
    ! -name '*.test.tsx' \
    | while read -r src; do
      rel="${src#"$src_dir/"}"
      dst="$dst_dir/$rel"
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      echo "  ✓ $rel"
    done
}

sync_dir "$COMPONENT_SRC" "$TARGET_COMPONENT" "component files"
echo ""
sync_dir "$CLIENT_SRC" "$TARGET_CLIENT" "client library"
echo ""
sync_dir "$REACT_SRC" "$TARGET_REACT" "react hooks"

# Sync shared utilities (create target dir if needed)
SHARED_SRC="$TOKENSPACE_ROOT/packages/durable-agents/src/shared"
TARGET_SHARED="$TARGET_ROOT/src/shared"
if [ -d "$SHARED_SRC" ]; then
  echo ""
  sync_dir "$SHARED_SRC" "$TARGET_SHARED" "shared utilities"
fi

echo ""
echo "Done! Files synced to $TARGET_ROOT"
echo ""
echo "Next steps:"
echo "  1. cd $TARGET_ROOT"
echo "  2. Review changes with 'git diff'"
echo "  3. Run tests to verify changes"
echo "  4. Commit and publish if everything looks good"
