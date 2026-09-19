#!/usr/bin/env bash
# Ingest every English NCERT Exemplar chapter for Classes 6-12, then reprocess
# everything already stored so it uses the current parser.
# Resumable: unchanged PDFs (same SHA-256) are skipped on a re-run.
set -u
cd "$(dirname "$0")/.."
PAIRS=(
  "6 Mathematics" "6 science"
  "7 Mathematics" "7 Science"
  "8 mathematics" "8 science"
  "9 mathematics" "9 science"
  "10 mathematics" "10 science"
  "11 mathematics" "11 physics" "11 chemistry" "11 biology"
  "12 mathematics" "12 physics" "12 chemistry" "12 biology"
)
filter() { grep -E "^=== |^[A-Z].*— https|Stored|NUMBERING INCOMPLETE|Unchanged|Blocked|FAILED|Collector failed|No matching|Identical"; }
echo "## reprocess stored documents with the current parser — $(date)"
for pair in "${PAIRS[@]}"; do
  set -- $pair
  node scripts/library-collect.js --reprocess-all --class "$1" --subject "$2" 2>&1 | filter
done
echo "## ingest all English Exemplar chapters — $(date)"
for pair in "${PAIRS[@]}"; do
  set -- $pair
  echo "#### Class $1 $2"
  node scripts/library-collect.js --class "$1" --subject "$2" --all-units 2>&1 | filter
done
echo "## done — $(date)"
