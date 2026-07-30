#!/usr/bin/env bash
set -euo pipefail

required_files=(
  "README.md"
  "CONTRIBUTING.md"
  "docs/ROADMAP.md"
  "docs/ARCHITECTURE_DECISIONS.md"
  "docs/DATA_MODEL.md"
  "docs/ENVIRONMENTS.md"
  "docs/OPERATIONS.md"
  "docs/SECRETS.md"
  "docs/B05_AUTHORIZATION_DESIGN.md"
  "docs/B05_ACCEPTANCE_SCENARIOS.md"
  "docs/B06_ATTENDANCE_DESIGN.md"
  "docs/B06_ACCEPTANCE_SCENARIOS.md"
  "docs/B07_SOURCE_WORKBOOK_PROFILE.md"
  "docs/B07_IMPORT_DESIGN.md"
  "docs/B07_ACCEPTANCE_SCENARIOS.md"
  "templates/import/README.md"
  "templates/import/Шаблон_массового_импорта.xlsx"
)

for path in "${required_files[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
done

if rg -n '[[:blank:]]+$' \
  --glob '*.html' \
  --glob '*.css' \
  --glob '*.js' \
  --glob '*.mjs' \
  --glob '*.yml' \
  --glob '*.yaml' \
  --glob '*.sh' \
  .; then
  echo "Trailing whitespace found." >&2
  exit 1
fi

bash scripts/check-sensitive-files.sh
node --check prototypes/ux/app.js
node scripts/check-links.mjs

if [[ -f package.json ]]; then
  npm run check
fi

echo "Repository checks passed."
