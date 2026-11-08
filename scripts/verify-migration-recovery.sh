#!/usr/bin/env bash
set -euo pipefail

# Phase 2.2 migration recovery verification.
#
# This script is intentionally limited to a disposable database whose name
# contains "test". It verifies the recovery strategy documented in
# docs/migration-recovery.md:
#
#   1. Apply the committed Prisma migrations and confirm there is no drift.
#   2. Insert sentinel rows, take a pg_dump backup, delete the rows, restore
#      the backup and confirm the data is back.
#   3. Simulate a failed migration in a temporary copy of the migration
#      directory, confirm Prisma records the failure, mark it rolled back with
#      `prisma migrate resolve --rolled-back`, then restore the known-good
#      backup.
#   4. Apply a forward corrective migration in a temporary copy of the
#      migration directory, verify existing data survives, then apply the
#      corrective removal and verify the original shape is restored.
#   5. Restore the known-good backup and confirm the committed migration
#      history is intact.
#
# The repository migration files are never modified.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRISMA="$ROOT/node_modules/.bin/prisma"
EXPECTED_MIGRATION_COUNT="$(find "$ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"

: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database whose name contains \"test\"}"
: "${SHADOW_DATABASE_URL:?Set SHADOW_DATABASE_URL to a disposable PostgreSQL shadow database}"

for command in psql pg_dump; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [[ ! -x "$PRISMA" ]]; then
  echo "Missing Prisma CLI at $PRISMA. Run npm install first." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROBE_USER_ID="phase22-probe-user"
PROBE_WORKSPACE_ID="phase22-probe-workspace"
PROBE_MEMBERSHIP_ID="phase22-probe-membership"
FAILED_MIGRATION="99999999999999_phase22_failure_probe"
ADD_COLUMN_MIGRATION="99999999999998_phase22_add_probe_column"
DROP_COLUMN_MIGRATION="99999999999997_phase22_drop_probe_column"

psql_exec() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
}

psql_scalar() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "$1"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $message (expected '$expected', got '$actual')" >&2
    exit 1
  fi
}

run_prisma() {
  DATABASE_URL="$DATABASE_URL" "$PRISMA" "$@"
}

copy_migrations() {
  local destination="$1"
  mkdir -p "$destination"
  cp "$ROOT/prisma/schema.prisma" "$destination/schema.prisma"
  cp -R "$ROOT/prisma/migrations" "$destination/migrations"
}

restore_backup() {
  psql_exec -f "$TMP_DIR/backup.sql" >/dev/null
}

db_name="$(psql_scalar 'SELECT current_database();')"
if [[ ! "$db_name" =~ test ]]; then
  echo "Refusing to run: database '$db_name' does not contain \"test\"." >&2
  exit 1
fi

echo "1/6 Applying committed migrations"
run_prisma migrate deploy
run_prisma migrate status
run_prisma migrate diff \
  --from-migrations "$ROOT/prisma/migrations" \
  --to-schema-datamodel "$ROOT/prisma/schema.prisma" \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code

echo "2/6 Creating sentinel data and backup"
psql_exec <<'SQL'
DELETE FROM "WorkspaceMembership" WHERE id = 'phase22-probe-membership';
DELETE FROM "Workspace" WHERE id = 'phase22-probe-workspace';
DELETE FROM "User" WHERE id = 'phase22-probe-user';
INSERT INTO "User" (id, email, "passwordHash", name, status, "emailVerifiedAt", "updatedAt")
VALUES ('phase22-probe-user', 'phase22-probe@test.example', 'probe-hash', 'Phase 22 Probe', 'ACTIVE', now(), now());
INSERT INTO "Workspace" (id, name, slug, status, "ownerId", "updatedAt")
VALUES ('phase22-probe-workspace', 'Phase 22 Probe', 'phase22-probe', 'ACTIVE', 'phase22-probe-user', now());
INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", role, "updatedAt")
VALUES ('phase22-probe-membership', 'phase22-probe-workspace', 'phase22-probe-user', 'OWNER', now());
SQL

pg_dump "$DATABASE_URL" \
  --clean --if-exists --no-owner --no-privileges --format=plain \
  >"$TMP_DIR/backup.sql"

psql_exec <<'SQL'
DELETE FROM "WorkspaceMembership" WHERE id = 'phase22-probe-membership';
DELETE FROM "Workspace" WHERE id = 'phase22-probe-workspace';
DELETE FROM "User" WHERE id = 'phase22-probe-user';
SQL

assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "0" "sentinel rows were not removed"

echo "3/6 Restoring backup and verifying data integrity"
restore_backup
assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "1" "restored User sentinel is missing"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"Workspace\" WHERE id = '$PROBE_WORKSPACE_ID';")" "1" "restored Workspace sentinel is missing"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"WorkspaceMembership\" WHERE id = '$PROBE_MEMBERSHIP_ID';")" "1" "restored WorkspaceMembership sentinel is missing"
assert_eq "$(psql_scalar 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')" "$EXPECTED_MIGRATION_COUNT" "restored migration history is incomplete"

echo "4/6 Simulating a failed migration and Prisma recovery"
copy_migrations "$TMP_DIR/failure"
mkdir -p "$TMP_DIR/failure/migrations/$FAILED_MIGRATION"
printf 'SELECT 1 / 0;\n' >"$TMP_DIR/failure/migrations/$FAILED_MIGRATION/migration.sql"

if run_prisma migrate deploy --schema "$TMP_DIR/failure/schema.prisma"; then
  echo "FAIL: the intentionally failing migration unexpectedly succeeded" >&2
  exit 1
fi

assert_eq "$(psql_scalar "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$FAILED_MIGRATION' AND finished_at IS NULL AND rolled_back_at IS NULL;")" "1" "Prisma did not record the failed migration"

run_prisma migrate resolve --rolled-back "$FAILED_MIGRATION" --schema "$TMP_DIR/failure/schema.prisma"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$FAILED_MIGRATION' AND rolled_back_at IS NOT NULL;")" "1" "failed migration was not marked rolled back"

restore_backup
assert_eq "$(psql_scalar "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$FAILED_MIGRATION';")" "0" "failed migration remains after restore"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "1" "sentinel data was lost after failed-migration recovery"

echo "5/6 Applying forward corrective migrations with data preservation"
copy_migrations "$TMP_DIR/corrective"
mkdir -p "$TMP_DIR/corrective/migrations/$ADD_COLUMN_MIGRATION"
printf 'ALTER TABLE "User" ADD COLUMN "phase22Probe" TEXT;\n' >"$TMP_DIR/corrective/migrations/$ADD_COLUMN_MIGRATION/migration.sql"

run_prisma migrate deploy --schema "$TMP_DIR/corrective/schema.prisma"
assert_eq "$(psql_scalar "SELECT count(*) FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'phase22Probe';")" "1" "forward migration did not add the probe column"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "1" "sentinel data was lost after forward migration"

mkdir -p "$TMP_DIR/corrective/migrations/$DROP_COLUMN_MIGRATION"
printf 'ALTER TABLE "User" DROP COLUMN "phase22Probe";\n' >"$TMP_DIR/corrective/migrations/$DROP_COLUMN_MIGRATION/migration.sql"

run_prisma migrate deploy --schema "$TMP_DIR/corrective/schema.prisma"
assert_eq "$(psql_scalar "SELECT count(*) FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'phase22Probe';")" "0" "corrective migration did not remove the probe column"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "1" "sentinel data was lost after corrective migration"

echo "6/6 Restoring the known-good state"
restore_backup
assert_eq "$(psql_scalar 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')" "$EXPECTED_MIGRATION_COUNT" "known-good migration history was not restored"
assert_eq "$(psql_scalar "SELECT count(*) FROM \"User\" WHERE id = '$PROBE_USER_ID';")" "1" "sentinel data is missing after final restore"
run_prisma migrate status
run_prisma migrate diff \
  --from-migrations "$ROOT/prisma/migrations" \
  --to-schema-datamodel "$ROOT/prisma/schema.prisma" \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code

echo "Migration recovery verification passed."
