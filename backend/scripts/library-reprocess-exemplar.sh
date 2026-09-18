#!/usr/bin/env bash
# Re-run extraction on every stored English Exemplar chapter with the current
# parser. Uses the PDFs already on disk: no requests to ncert.nic.in.
set -u
cd "$(dirname "$0")/.."
PAIRS=(
  "6 Mathematics" "6 Science" "7 Mathematics" "7 Science" "8 Mathematics" "8 Science"
  "9 Mathematics" "9 Science" "10 Mathematics" "10 Science"
  "11 Mathematics" "11 Physics" "11 Chemistry" "11 Biology"
  "12 Mathematics" "12 Physics" "12 Chemistry" "12 Biology"
)
echo "## reprocess — $(date)"
for pair in "${PAIRS[@]}"; do
  set -- $pair
  echo "#### Class $1 $2"
  node scripts/library-collect.js --reprocess-all --class "$1" --subject "$2" 2>&1 \
    | grep -E "^=== |Stored|NUMBERING INCOMPLETE|FAILED|Excluded|disagree|Collector failed"
done
echo "## done — $(date)"
