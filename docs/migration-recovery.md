# Database migration recovery

This document defines the recovery strategy for Nexus database changes. It applies to the PostgreSQL schema managed by Prisma Migrate in `prisma/`.

Prisma Migrate does **not** generate or execute automatic down migrations. Nexus therefore does not claim that every migration has a tested reverse. Recovery is chosen per change, and destructive changes require a verified backup or a forward corrective migration.

## Recovery scenarios

| Scenario | What happened | Correct recovery |
|---|---|---|
| Application deployment rollback | The application release is unhealthy, but the database change is backward compatible. | Redeploy the previous application version. Do not reverse the schema. Confirm that the old code can read and write the current schema. |
| Schema change must be reversed | A non-destructive schema change needs to be undone while preserving data. | Apply a reviewed forward corrective migration. Test it in an isolated database first. |
| Destructive schema change | A migration drops or rewrites data, or a safe corrective migration is not possible. | Restore a verified backup to a new database, validate it, then switch traffic. Do not run destructive down SQL against production. |
| Migration fails during deployment | `prisma migrate deploy` reports `P3018` and records a failed row in `_prisma_migrations`. | Inspect the database state and migration logs. Fix forward if possible. Otherwise undo only the failed migration's effects in a controlled transaction and mark it rolled back with `prisma migrate resolve --rolled-back <name>`. If the migration actually completed, mark it applied with `--applied`. If the state is uncertain, restore a backup. |
| Data is corrupted or lost | A change or operational incident damaged existing rows. | Restore the affected data from a verified backup or use a targeted, reviewed repair. Restoring the schema alone does not restore deleted or transformed data. |
| Database unavailable or failed | PostgreSQL is down or a restore is required. | Use the provider's recovery mechanism, or restore a logical backup to a replacement database, validate it, and repoint the application. |

## Prisma rules

- Do not edit an already-applied migration file to add a rollback path.
- Do not delete migration history or use `prisma migrate reset` as evidence that a production migration can be reversed.
- Do not create a generic down script that blindly drops tables or columns.
- Use `prisma migrate deploy` for controlled environments.
- Use `prisma migrate resolve` only after inspecting the database and understanding whether the failed migration had partial effects.
- Prefer expand-and-contract changes: add compatible structures, backfill, switch reads and writes, then remove old structures in a later release.
- A backup must be taken before a migration that can lose data or fail after partial changes.
- Restoring a backup restores the data that existed when the backup was taken. It does not preserve writes made after that point.

## Migration inventory

All committed migrations are forward-only. None has a Prisma down path.

| Migration | Operations | Reversal risk | Recovery choice |
|---|---|---|---|
| `20261021023018_phase2_nexus_core_schema` | Creates 14 enums, 18 tables, indexes and foreign keys. | Dropping the objects destroys all data in them. | Restore a backup. Dropping is acceptable only in an empty disposable database. |
| `20261021105314_phase3_auth_lifecycle` | Makes `AuditLog.workspaceId` nullable, adds nullable `AuthToken.targetEmail`, adds an index. | Restoring `NOT NULL` can fail if null audit rows exist. Dropping `targetEmail` loses data. The index is reversible. | Backfill first and use a forward corrective migration; otherwise restore a backup. |
| `20261021105500_phase3_session_rotation` | Adds nullable `Session.previousRefreshTokenHash` and a unique index. | Dropping the column loses rotation-detection data. The index is reversible. | Forward corrective migration only if the data is no longer needed; otherwise restore a backup. |
| `20261021120000_phase4_transactional_email` | Creates 2 enums, 3 tables and indexes. | Dropping the objects destroys delivery, suppression and webhook history. | Restore a backup. Dropping is acceptable only in an empty disposable database. |
| `20261021130000_email_webhook_event_provider_scope` | Replaces the unique `providerEventId` index with a unique `(provider, providerEventId)` index. | Recreating the old index can fail if the same provider event id exists for multiple providers. | Forward corrective migration after deduplication, or restore a backup. |
| `20261021140000_phase5_workspace_invitations` | Drops the unique `(workspaceId, email)` index, adds nullable `pendingKey`, adds its unique index and the `acceptedById` foreign key. | Dropping `pendingKey` loses pending-invitation data. Recreating the old unique index can fail when an address has settled invitations. | Forward corrective migration after resolving duplicates, or restore a backup. |

The migrations contain no table or column renames, no column type changes, no data transformations and no table or column drops. They do contain data-dependent constraint changes and one `NOT NULL` relaxation, so schema restoration alone is not sufficient evidence of data recovery.

## Standard procedure

### Before applying a migration

1. Review the SQL and identify data loss, locking, backfill and compatibility risks.
2. Confirm the target database and that the application version is compatible with the resulting schema.
3. Take a backup for any high-risk change. Use the provider's managed backup or point-in-time recovery where available.
4. Run the migration against a disposable database with representative data.
5. Run `prisma migrate status` and `prisma migrate diff` before and after the change.
6. Record the backup identifier and the recovery decision.

### Applying a migration

```bash
npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status
```

Verify application health, critical queries and data integrity after deployment.

### Recovering a failed migration

1. Read the `P3018` error and the failed row in `_prisma_migrations`.
2. Inspect the database for partial changes. Do not assume the migration failed atomically.
3. Prefer a forward corrective migration when it is safe.
4. If the failed migration's effects must be undone, do so in a controlled transaction, then run:

```bash
npx prisma migrate resolve --rolled-back <migration_name>
```

5. If the migration actually completed successfully, record that state with:

```bash
npx prisma migrate resolve --applied <migration_name>
```

6. If the state cannot be established safely, restore the pre-migration backup.

### Restoring a backup

1. Restore to a new database, not over the live database, whenever possible.
2. Validate migration history, schema shape, row counts and critical records.
3. Run `prisma migrate status` and `prisma migrate diff` against the restored database.
4. Switch the application only after validation.
5. Record the restore time, backup identifier and any data loss window.

## Verification procedure

Use `scripts/verify-migration-recovery.sh` against a disposable PostgreSQL database. The script refuses to run unless the connected database name contains `test`.

Prerequisites:

- PostgreSQL 16 or a compatible disposable test database.
- `psql` and `pg_dump` on `PATH`.
- `node_modules` installed.
- A disposable shadow database for `prisma migrate diff`.

Run:

```bash
DATABASE_URL="postgresql://<test-user>:<test-password>@<host>:<port>/<test-database>" \
SHADOW_DATABASE_URL="postgresql://<test-user>:<test-password>@<host>:<port>/<shadow-database>" \
./scripts/verify-migration-recovery.sh
```

The script:

1. Applies the six committed migrations, checks `prisma migrate status`, and verifies there is no schema drift.
2. Inserts sentinel user, workspace and membership rows, takes a `pg_dump` backup, deletes the rows, restores the backup and verifies the rows return.
3. Adds a temporary failing migration to a copy of the migration directory, confirms Prisma records the failure, marks it rolled back, restores the backup and verifies the failed migration is gone.
4. Adds a temporary column through a forward migration, verifies existing data survives, then removes it through a second corrective migration and verifies the data still survives.
5. Restores the known-good backup, verifies the six-migration history, and rechecks schema drift.

The repository's committed migration files are never modified by the script.

## Verification evidence

Verified on 2026-11-01 against a disposable PostgreSQL 16.15 container:

- Database names used: `nexus_test`, `nexus_shadow`, `nexus_probe`, `nexus_probe_corrective` and `nexus_restore`. Credentials are not recorded here.
- All six committed migrations applied successfully.
- `prisma migrate diff` reported `No difference detected`.
- A logical backup restored the sentinel user, workspace and membership rows.
- The backup was also restored into a separate `nexus_restore` database and `prisma migrate status` reported it up to date.
- A temporary migration containing `SELECT 1 / 0;` failed with PostgreSQL error `22012` and was recorded by Prisma as an unfinished migration.
- `prisma migrate resolve --rolled-back` marked the failed migration as rolled back.
- A temporary forward migration added `User.phase22Probe`; a second corrective migration removed it. The sentinel user survived both changes.
- The final restore returned the database to the six-migration known-good state.
- `tests/database-phase2.test.ts` passes 2/2 against the disposable database.
- Type checking, linting, formatting and the application build pass.

The full database-enabled test suite still reports the pre-existing Phase 6 ownership-transfer failures documented in `PHASES.md`. Those failures are unrelated to migration recovery.

## Remaining limitations

- No shared, staging or production database was accessed or tested. The repository contains no deployment configuration or migration status record proving which databases have received these migrations; an operator must confirm that separately.
- The repository has no automated backup schedule, retention policy, encryption configuration or point-in-time-recovery setup. Those belong to the deployment and production-readiness phases.
- The verification uses a logical `pg_dump` backup, not a managed provider snapshot or point-in-time recovery.
- The script restores into the disposable test database. A separate manual run also verified a restore into a new database. Neither performs a production traffic switch.
- No per-migration down scripts exist. That is intentional. Destructive changes rely on backup restoration or forward corrective migrations.
- Application deployment rollback was reviewed but not exercised against a running staging deployment because the repository has no deployment environment.
- A restore can lose writes made after the backup. Backup frequency and recovery point objectives must be defined before production use.
