# ADR-001-RESOLVED: ORM Choice — node-pg + Kysely Hybrid

**Date**: 2026-08-12  
**Status**: ✅ DECIDED (Session 1)  
**Decision Maker**: Architecture Team

## Decision Summary

**Approved**: Hybrid approach using **node-pg for connection/RLS context** + **Kysely for query building**

### Rationale

1. **node-pg for RLS enforcement** (RNF-ARQ-010)
   - Direct control over connection context: `SET LOCAL app.tenant_ids`, `app.user_id`
   - Transactional isolation without ORM blocking
   - Ideal for enforcing [INVIOLÁVEL] RG-001 rule
   - Built-in prepared statement support prevents SQL injection

2. **Kysely for query building** (where used)
   - Type-safe SQL for complex queries (pagination, aggregates)
   - Better than raw SQL templating
   - Can be optional — raw SQL acceptable for simple queries

3. **Why NOT single-ORM**
   - TypeORM: Bloated, decorator hell, poor RLS integration
   - Sequelize: Slow migrations, weak type safety
   - node-pg alone: Verbose for complex queries
   - Prisma: Overkill, slow boot time, expensive hosting

## Implementation Strategy

### Connection Pool (node-pg)
```typescript
// core/database/connection.ts
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 20, // connection pool size
});

export async function createContextualConnection(
  tenantId: string,
  userId: string,
): Promise<PoolClient> {
  const client = await pool.connect();
  
  // RNF-ARQ-011: Set RLS context BEFORE any query
  await client.query(`SET LOCAL app.tenant_ids = $1`, [tenantId]);
  await client.query(`SET LOCAL app.user_id = $1`, [userId]);
  
  return client;
}
```

### Migrations
- **Flyway-style runner**: Simple Node.js script that versioning, applies, tracks completion
- **Stored in**: `migrations/00N_*.sql` (pure SQL, version controlled)
- **Tracked in**: `schema_migration` table

### Kysely (Optional, Used Selectively)
```typescript
// For complex queries only
import { Kysely, PostgresDialect } from 'kysely';

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

// Use when building dynamic queries
const query = db
  .selectFrom('products')
  .select(['id', 'sku', 'name'])
  .where('tenant_id', '=', tenantId)
  .orderBy('created_at', 'desc')
  .limit(10);
```

## Migration Runner Design

```typescript
// scripts/migrate.ts
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

class MigrationRunner {
  async runPending(): Promise<void> {
    const applied = await this.getAppliedVersions();
    const files = this.getMigrationFiles();
    
    for (const file of files) {
      const version = parseInt(file.split('_')[0]);
      if (!applied.includes(version)) {
        await this.run(file);
      }
    }
  }
  
  private async run(file: string): Promise<void> {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'migrations', file),
      'utf-8'
    );
    
    const pool = new Pool(/* config */);
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      await client.query(sql);
      
      // Record in schema_migration
      const version = parseInt(file.split('_')[0]);
      await client.query(
        `INSERT INTO schema_migration (version, description)
         VALUES ($1, $2)`,
        [version, file]
      );
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      pool.end();
    }
  }
}
```

## Deployment Notes

1. **Local development**: `pnpm run db:migrate` before running app
2. **Docker**: Migration runs in `docker-entrypoint-initdb.d/03-migrations.sh`
3. **Production**: Deployment pipeline runs migrations before app start

## Limitations & Trade-offs

| Aspect | Trade-off |
|--------|-----------|
| Query building | Not 100% type-safe (raw SQL allowed); defer to Kysely for complex |
| Migration tooling | Minimal vs. Flyway/Liquibase, but sufficient for project scale |
| ORM features | No lazy loading, relationships = join queries (fine for bounded contexts) |
| Developer experience | Higher code verbosity than "true" ORM, compensated by control + performance |

## Future Evolution

If needs grow:
1. Migrate to **Datasette** for admin querying
2. Add **Kysely codegen** for runtime type safety
3. Consider **pg-boss** for background job queue (already using Redis Streams here)

## References

- RNF-ARQ-010: Multi-tenancy via RLS
- RG-001: Tenant isolation [INVIOLÁVEL]
- DOC-01 §7: Database infrastructure
- ADR-002 (pnpm): Determined stack choice → node-pg stable for PostgreSQL
