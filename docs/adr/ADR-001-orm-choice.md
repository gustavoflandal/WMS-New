# ADR-001: ORM/Query Builder Choice for PostgreSQL

**Date**: 2026-08-11  
**Status**: PENDING  
**Decision Maker**: Architecture Team

## Problem

The WMS system requires database access layer for PostgreSQL. DOC-00 §2.2 mandates PostgreSQL ≥ 16 but leaves the choice of ORM/query builder unspecified for this session.

Two main options exist:

1. **Kysely** — Lightweight, type-safe SQL query builder (no migration runner included)
2. **node-pg** with raw SQL + custom migration runner — Maximum control, minimal abstractions

Both preserve type safety and support prepared statements (security requirement: SQL injection prevention).

## Constraints

- RNF-ARQ-001: Multi-tenancy via Row-Level Security (RLS) in PostgreSQL
- RG-001: `tenant_id` filtration mandatory before ANY query
- RNF-ARQ-011: Application role `wms_app` WITHOUT BYPASSRLS
- Stack frozen (DOC-00 §2.2): No Sequelize, TypeORM, or other alternatives

## Decision

**DEFERRED to Session 1** — Technical spike required:

### Investigation Tasks
1. Test RLS policy filtering with Kysely transactions vs. raw node-pg context setting
2. Benchmark query building overhead vs. raw SQL for high-concurrency scenarios (50k orders/day target)
3. Evaluate migration versioning & deployment tooling

### Preliminary Recommendation
- **node-pg + Kysely hybrid**: Use node-pg for RLS context injection + connection management, Kysely for query building in modules with complex queries
- Rationale: Gives maximum control over RLS setup (RG-001) while keeping queries type-safe

## Next Steps
- [ ] Session 1: Create ADR-001-RESOLVED with final decision
- [ ] Implement database module in Session 1
- [ ] Create migration runner script

## References
- DOC-00 §2.2: Stack congelada
- DOC-01: RNF-ARQ-001 (multi-tenancy)
- RG-001: Isolamento de tenant
- RNF-ARQ-011: Application role constraints
