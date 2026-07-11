#!/bin/bash
# Fires when Claude Code session ends
# Appends git summary to changelog for full traceability

CHANGELOG=".claude/rules/changelog.md"
DATE=$(date '+%Y-%m-%d')
TIME=$(date '+%H:%M')

echo "" >> "$CHANGELOG"
echo "### Session ended at $TIME" >> "$CHANGELOG"

# Append git diff summary if git is available
if git rev-parse --git-dir > /dev/null 2>&1; then
  DIFF=$(git diff --stat HEAD 2>/dev/null)
  COMMITS=$(git log --oneline -5 2>/dev/null)

  if [ -n "$DIFF" ]; then
    echo "" >> "$CHANGELOG"
    echo "**Git diff:**" >> "$CHANGELOG"
    echo '```' >> "$CHANGELOG"
    echo "$DIFF" >> "$CHANGELOG"
    echo '```' >> "$CHANGELOG"
  fi

  if [ -n "$COMMITS" ]; then
    echo "" >> "$CHANGELOG"
    echo "**Recent commits:**" >> "$CHANGELOG"
    echo '```' >> "$CHANGELOG"
    echo "$COMMITS" >> "$CHANGELOG"
    echo '```' >> "$CHANGELOG"
  fi
fi
