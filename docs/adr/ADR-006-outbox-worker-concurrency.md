# ADR-006: Outbox Worker Concurrency and Cross-Tenant Access

**Date**: 2026-08-15
**Status**: DECIDED
**Decision Maker**: Session 1.5 (DOC-01 closure)

## Problem

`outbox-publisher` (RNF-ARQ-031/032 [INVIOLÁVEL]) must poll `wms.event_outbox`
across ALL tenants — a single batch of up to 500 events may belong to many
different `tenant_id` values — and must be safe to run as **multiple concurrent
replicas** without publishing the same `event_id` to Redis Streams twice.

Two sub-problems, two decisions:

1. **Cross-tenant read**: RG-001 requires RLS on every transactional table, and
   the `wms_app` role has no `BYPASSRLS` (RNF-ARQ-011). A worker authenticated as
   `wms_app` with a single tenant context set via `SELECT set_config('app.tenant_ids', ...)`
   can only ever see one tenant's rows per connection — incompatible with a single
   poll query spanning all tenants.
2. **Concurrency between replicas**: two worker processes polling the same table
   must not both claim and publish the same row.

## Decision

### 1. Dedicated `wms_worker` role with `BYPASSRLS` (migration `0005-worker-role.sql`)

A new Postgres role, `wms_worker`, is created with `BYPASSRLS`, granted only
`SELECT, UPDATE` on `wms.event_outbox` (least privilege — no access to any other
table, and no `INSERT`/`DELETE`).

This does **not** violate RG-001 ("é proibido desabilitar RLS em runtime"):
- RLS stays `ENABLE`d and `FORCE`d on every table, for every other role. Nothing
  is disabled.
- `BYPASSRLS` on a role is a normal, supported Postgres RLS mechanism for trusted
  system processes — not a runtime toggle on the policy itself.
- The worker never interprets or exposes cross-tenant business data to any
  end user. It relays an opaque, already-committed `payload` (written by
  application code that ran under the correct tenant's RLS context) from
  Postgres to a Redis Stream keyed by module. No query result reaches an HTTP
  response or a user of any tenant.
- `wms_worker` is only ever used by the two background worker processes
  (`outbox-publisher`, `realtime-fanout`'s DB access — currently none), never
  reachable from the HTTP request path, and never exposed via `ConfigService` to
  any controller.
- RG-001's "modo multi-tenant explícito, nunca modo 'todos'" restriction governs
  **interactive users** of the operator logístico. A background system process
  performing a mechanical relay is not a user session and carries no user-facing
  authorization decision.

Alternative considered and rejected: keep `wms_app` (no bypass) and loop the
poll once per known `tenant_id`. Rejected because it requires the worker to
enumerate all tenants up front (a tenant registry doesn't exist until DOC-02),
turns one `LIMIT 500 FOR UPDATE SKIP LOCKED` batch into N round-trips, and
breaks global ordering by `created_at` (RNF-ARQ-031 processes oldest-first
across all tenants, not oldest-first-per-tenant).

### 2. `FOR UPDATE SKIP LOCKED` for inter-replica concurrency

Chosen over a Redis lock (`SET NX PX`, RNF-ARQ-021, already implemented in
`CacheService.acquireLock`) for the specific job of claiming outbox rows:

- **Atomic with the claim**: `SELECT ... FOR UPDATE SKIP LOCKED` combined with
  the `UPDATE ... SET published_at = NOW()` in the *same* transaction means the
  row lock is held for the exact duration of "claim → XADD → mark published".
  A Redis lock would need a second network round-trip (acquire lock, then query,
  then release) with its own failure modes (lock expiry mid-XADD, split brain).
- **No lock-timeout tuning**: Postgres releases the row lock automatically on
  transaction end (commit or crash-disconnect) — no risk of an orphaned lock
  surviving a crashed worker (a Redis lock needs a TTL guess; too short → false
  contention, too long → stuck rows).
- **Failure semantics match the spec exactly**: "falha no XADD = não marca
  (retry natural no próximo poll)" is achieved by *not* updating `published_at`
  before the transaction commits; if the transaction rolls back (XADD threw),
  `SKIP LOCKED` releases the row back to the next poller immediately, with zero
  extra bookkeeping.
- **Verified with two concurrent instances** in
  `apps/backend/src/workers/__tests__/outbox-publisher-concurrency.integration.spec.ts`:
  100 events inserted, two `OutboxPublisherWorkerImpl` instances call
  `pollBatch()` concurrently in a tight loop; every `event_id` appears in the
  Redis Stream exactly once.

Redis distributed locks (`CacheService.acquireLock`/`releaseLock`) remain the
chosen mechanism for RNF-ARQ-021 in general (e.g. business-level cross-service
locks in future sessions) — this ADR only scopes the outbox worker's row claim.

## Consequences

- A new role/credential (`POSTGRES_WORKER_USER`/`POSTGRES_WORKER_PASSWORD`,
  defaults `wms_worker`/`wms_worker_password`) must be provisioned and rotated
  independently of `wms_app`.
- `DatabaseService.transactionAsWorker()` is the only code path allowed to use
  this role; it does not accept a `TenantContext` and does not call
  `set_config`, since bypassing RLS makes tenant scoping meaningless for this
  connection.
- If a future module needs the worker to write to a table other than
  `event_outbox`, that table must be granted to `wms_worker` explicitly
  (least-privilege, no blanket schema grant).

## References

- RNF-ARQ-031/032 (outbox pattern, retry/DLQ) — [INVIOLÁVEL]
- RNF-ARQ-021 (distributed locks)
- RG-001 (tenant isolation)
- `infra/postgres/migrations/0005-worker-role.sql`
- `apps/backend/src/core/database/database.service.ts:transactionAsWorker`
- `apps/backend/src/workers/outbox-publisher.worker.impl.ts`
