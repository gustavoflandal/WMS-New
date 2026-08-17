// RNF-ARQ-090: Database migration runner
// Versioned SQL migrations with tracking in schema_migration table
import { Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

interface Migration {
  version: number;
  description: string;
  sql: string;
}

// RNF-ARQ-003: docker-compose de dev sobe backend-api/worker/scheduler
// concorrentemente — os 3 chamam runPending() ao mesmo tempo contra o MESMO
// Postgres. Sem serialização, todos veem a mesma migration como "pendente"
// (getAppliedVersions() lida ANTES de qualquer um commitar) e tentam
// executá-la em paralelo — bug real encontrado ao rodar `docker compose up
// -d --build` pela 1ª vez com as migrations novas desta sessão (0033-0042):
// migration 39 (bootstrap de partição de wms.putaway_task) tem um "IF NOT
// EXISTS ... THEN CREATE TABLE" que não é atômico entre transações
// concorrentes — 2 dos 3 containers viram a partição como inexistente ao
// mesmo tempo, ambos tentam criar, um vence e o outro quebra com
// "duplicate key value violates unique constraint pg_type_typname_nsp_index"
// (colisão do tipo linha implícito da tabela). Corrigido com um advisory
// lock de sessão do Postgres em volta de toda a execução — instâncias
// concorrentes ficam bloqueadas em pg_advisory_lock() até a 1ª terminar, daí
// releem schema_migration (já tudo aplicado) e não fazem nada.
const MIGRATION_ADVISORY_LOCK_ID = 904090; // RNF-ARQ-090, arbitrário mas estável

export class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);

  constructor(private readonly pool: Pool) {}

  /**
   * Run pending migrations in order
   * Tracks execution in schema_migration table
   */
  async runPending(): Promise<number> {
    const lockClient = await this.pool.connect();
    try {
      await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);

      // Relido DEPOIS de obter o lock: se outra instância rodou as
      // migrations enquanto esta esperava o lock, applied já reflete isso.
      const applied = await this.getAppliedVersions();
      const migrations = await this.getMigrations();

      let count = 0;
      for (const migration of migrations) {
        if (!applied.includes(migration.version)) {
          await this.runMigration(migration);
          count++;
          this.logger.log(`✓ Migration ${migration.version}: ${migration.description}`);
        }
      }

      return count;
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
      lockClient.release();
    }
  }

  /**
   * Get list of already-applied migrations
   */
  private async getAppliedVersions(): Promise<number[]> {
    try {
      const result = await this.pool.query(
        'SELECT version FROM wms.schema_migration ORDER BY version'
      );
      return result.rows.map((row) => row.version);
    } catch (error) {
      this.logger.warn('schema_migration table not found, assuming no migrations applied');
      return [];
    }
  }

  /**
   * Load all SQL migration files from infra/postgres/migrations (single source of
   * truth, shared with the integration test bootstrap in test-setup.ts).
   */
  private async getMigrations(): Promise<Migration[]> {
    const candidates = [
      path.join(process.cwd(), 'infra', 'postgres', 'migrations'),
      path.join(process.cwd(), '..', '..', 'infra', 'postgres', 'migrations'),
    ];
    const migrationsDir = candidates.find((dir) => fs.existsSync(dir));

    if (!migrationsDir) {
      return [];
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.match(/^\d+-.*\.sql$/))
      .sort();

    return files.map((file) => {
      const version = parseInt(file, 10);
      const description = file
        .replace(/^\d+-/, '')
        .replace(/\.sql$/, '')
        .replace(/-/g, ' ');
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      return { version, description, sql };
    });
  }

  /**
   * Execute a single migration in a transaction
   */
  private async runMigration(migration: Migration): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Execute migration SQL
      await client.query(migration.sql);

      // Record in schema_migration (if migration doesn't do it itself)
      await client.query(
        `INSERT INTO wms.schema_migration (version, description, type, installed_by)
         VALUES ($1, $2, 'SQL', 'system')
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.description]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${migration.version} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }
}
