#!/bin/bash
# Auto-tracks every file Claude writes/edits into changelog.md
# Fired automatically by Claude Code after every Write/Edit/MultiEdit tool use

TOOL=$1
FILE=$2
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
CHANGELOG=".claude/rules/changelog.md"

# Only track actual file writes
if [[ "$TOOL" != "Write" && "$TOOL" != "Edit" && "$TOOL" != "MultiEdit" ]]; then
  exit 0
fi

# Skip tracking the memory files themselves
if [[ "$FILE" == *".claude/rules"* || "$FILE" == *"CLAUDE.md"* ]]; then
  exit 0
fi

# Create today's section header if it doesn't exist
DATE=$(date '+%Y-%m-%d')
if ! grep -q "## $DATE" "$CHANGELOG" 2>/dev/null; then
  echo "" >> "$CHANGELOG"
  echo "## $DATE" >> "$CHANGELOG"
fi

# Append the file change
echo "- \`$FILE\` — modified at $TIMESTAMP" >> "$CHANGELOG"
