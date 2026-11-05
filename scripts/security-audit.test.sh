#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$ROOT_DIR/scripts/security-audit.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-security-audit.XXXXXX")"
HARDENED_ENV="$TMP_DIR/hardened.env"
INSECURE_ENV="$TMP_DIR/insecure.env"

cleanup() {
  rm -f "$HARDENED_ENV" "$INSECURE_ENV"
  rmdir "$TMP_DIR"
}
trap cleanup EXIT

cat > "$HARDENED_ENV" <<'EOF'
PATH=/definitely/not/a/real/path
BASH_ENV=/tmp/should-not-be-loaded
AUTH_PASS="a secure # password"
API_KEY=test-api-key
MC_ALLOWED_HOSTS=127.0.0.1,localhost
MC_ALLOW_ANY_HOST=0
MC_COOKIE_SECURE=1
MC_COOKIE_SAMESITE=strict
MC_ENABLE_HSTS=1
MC_DISABLE_RATE_LIMIT=0
EOF
chmod 600 "$HARDENED_ENV"

output="$(bash "$AUDIT" --env-file "$HARDENED_ENV" --strict --skip-docker)"
grep -Fq '[PASS] AUTH_PASS is set to a non-default value (19 chars)' <<< "$output"
# The score depends on whether the host filesystem can represent POSIX
# permission bits: 8 checks when chmod works (Linux CI), 7 when the
# permission check is skipped (e.g. NTFS via MSYS/Git Bash).
probe="$(mktemp -d "${TMPDIR:-/tmp}/mc-perm-probe.XXXXXX")"
chmod 600 "$probe" 2>/dev/null || true
probe_perms="$(stat -c '%a' -- "$probe" 2>/dev/null || stat -f '%Lp' "$probe" 2>/dev/null || echo unknown)"
rm -rf "$probe"
if [[ "$probe_perms" == "600" ]]; then
  EXPECTED_SCORE='8 / 8'
else
  EXPECTED_SCORE='7 / 7'
fi
grep -Fq "=== Security Score: $EXPECTED_SCORE ===" <<< "$output"
grep -Fq 'All checks passed!' <<< "$output"

cat > "$INSECURE_ENV" <<'EOF'
AUTH_PASS=password
API_KEY=generate-a-random-key
MC_ALLOW_ANY_HOST=1
MC_DISABLE_RATE_LIMIT=1
EOF
chmod 600 "$INSECURE_ENV"

if bash "$AUDIT" --env-file "$INSECURE_ENV" --strict --skip-docker >/dev/null 2>&1; then
  echo 'Expected --strict to fail when the audit reports security findings' >&2
  exit 1
fi

if bash "$AUDIT" --unknown >/dev/null 2>&1; then
  echo 'Expected an unknown option to fail' >&2
  exit 1
fi

echo 'security-audit tests passed'
