#!/usr/bin/env bash
set -euo pipefail

tracked_files="$(git ls-files --cached --others --exclude-standard)"

for forbidden in \
  '.env' \
  '.env.production' \
  '.env.staging' \
  'id_rsa' \
  'id_ed25519'; do
  if printf '%s\n' "$tracked_files" | awk -F/ -v name="$forbidden" '$NF == name { found=1 } END { exit !found }'; then
    echo "Forbidden sensitive file is tracked: $forbidden" >&2
    exit 1
  fi
done

if printf '%s\n' "$tracked_files" | rg -q '\.(pem|key|p12|pfx|jks|keystore)$'; then
  echo "A private key or certificate container is tracked." >&2
  exit 1
fi

if printf '%s\n' "$tracked_files" | rg -q '(^|/)(backups|data/private|imports/private|uploads)/'; then
  echo "A private data or backup directory is tracked." >&2
  exit 1
fi

if printf '%s\n' "$tracked_files" | rg -qi '(^|/)норма_новая_.*\.xlsx$'; then
  echo "The private source workbook must not be tracked." >&2
  exit 1
fi

echo "Sensitive file check passed."
