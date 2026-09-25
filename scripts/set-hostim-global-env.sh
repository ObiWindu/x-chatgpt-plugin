#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   cp hostim/global.env.example hostim/global.env
#   edit hostim/global.env
#   ./scripts/set-hostim-global-env.sh hostim/global.env
#
# One KEY=VALUE per line. Blank lines and # comments are ignored.

FILE="${1:-hostim/global.env}"
[[ -f "$FILE" ]] || { echo "Missing $FILE" >&2; exit 1; }

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"

  if [[ "$key" == "$line" || -z "$key" ]]; then
    echo "Skipping malformed line: $line" >&2
    continue
  fi

  hostim env set --global "$key=$value"
done < "$FILE"
