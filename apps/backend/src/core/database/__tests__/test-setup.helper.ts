// Helper para setup de testes de integração com NestJS
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module.js';
import { DatabaseService } from '../database.service.js';
import { CacheModule } from '../../cache/cache.module.js';
import { RedisModule } from '../../redis/redis.module.js';
import { EventsModule } from '../../events/events.module.js';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Sessão 4A item 0 [débito da Sessão 4]: carrega .env.test (porta 5433/6380,
// isolado do docker-compose.yml de desenvolvimento) com override:true —
// mesmo motivo e mesmo mecanismo de test-setup.ts (globalSetup): sem isso,
// um POSTGRES_PORT já presente no shell (herdado de .env) sobreviveria aos
// defaults abaixo, apontando os testes de cada arquivo para o Postgres de
// desenvolvimento.
const envTestCandidates = [
  path.resolve(process.cwd(), '.env.test'),
  path.resolve(process.cwd(), '../../.env.test'),
];
const envTestPath = envTestCandidates.find((p) => fs.existsSync(p));
if (envTestPath) {
  dotenv.config({ path: envTestPath, override: true });
}

// RNF-ARQ-011: Application pool MUST connect as wms_app — NEVER as postgres/owner.
// POSTGRES_USER/PASSWORD stay as the admin credentials (.env.test has POSTGRES_USER=postgres,
// needed by DatabaseModule's MigrationRunner to CREATE ROLE/SCHEMA). The app pool
// (DatabaseService) reads the separate POSTGRES_APP_USER/PASSWORD namespace instead —
// forced here unconditionally so it's always wms_app in tests regardless of .env.
if (!process.env.POSTGRES_HOST) process.env.POSTGRES_HOST = 'localhost';
if (!process.env.POSTGRES_PORT) process.env.POSTGRES_PORT = '5433';
if (!process.env.POSTGRES_DB) process.env.POSTGRES_DB = 'wms_test';
process.env.POSTGRES_APP_USER = 'wms_app';
process.env.POSTGRES_APP_PASSWORD = 'wms_app_password';
if (!process.env.REDIS_URL) process.env.REDIS_URL = 'redis://localhost:6380/0';
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'info';

// Defesa em profundidade: recusa a rodar contra a porta do Postgres de
// desenvolvimento (docker-compose.yml usa 5432).
if (process.env.POSTGRES_PORT === '5432') {
  throw new Error(
    'POSTGRES_PORT=5432 apontaria os testes para o Postgres de DESENVOLVIMENTO. ' +
      'Verifique .env.test (deve usar a porta 5433, ver .env.test.example).'
  );
}

// Root test module that provides ConfigModule globally
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.cwd().includes('apps/backend')
        ? '../../../.env'
        : '.env',
      // Ensure test env vars are loaded (fail-fast if missing)
      expandVariables: true,
      // Warn on missing critical vars instead of silent fallback
      cache: false, // Disable caching to catch changes
    }),
  ],
  exports: [ConfigModule],
})
class TestRootModule {}

// Parse SQL safely, respecting quotes and structure
function parseSQL(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let i = 0;

  // First remove comments
  let cleaned = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  while (i < cleaned.length) {
    const char = cleaned[i];
    const nextChar = cleaned[i + 1];

    // Handle quotes
    if ((char === '"' || char === "'") && (i === 0 || cleaned[i - 1] !== '\\')) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
    }

    // Handle statement terminator
    if (char === ';' && !inQuote) {
      current = current.trim();
      if (current.length > 0) {
        statements.push(current);
      }
      current = '';
    } else {
      current += char;
    }

    i++;
  }

  // Add remaining statement
  current = current.trim();
  if (current.length > 0) {
    statements.push(current);
  }

  return statements;
}

async function runTestMigrations(pool: Pool): Promise<void> {
  // Migrations are idempotent via IF NOT EXISTS, so run every time.
  // Reads ALL files from the canonical migrations directory (single source of
  // truth, shared with migration.runner.ts and test-setup.ts) instead of a
  // hardcoded list, so new migrations are picked up automatically.
  const migrationsDirCandidates = [
    path.resolve(process.cwd(), 'infra/postgres/migrations'),
    path.resolve(process.cwd(), '../../infra/postgres/migrations'),
  ];
  const migrationsDirFound = migrationsDirCandidates.find((p) => fs.existsSync(p));
  const migrations = migrationsDirFound
    ? fs
        .readdirSync(migrationsDirFound)
        .filter((f) => /^\d+-.*\.sql$/.test(f))
        .sort()
    : [];

  const client = await pool.connect();
  try {
    for (const migrationFile of migrations) {
      // Try multiple possible paths
      const possiblePaths = [
        // From source (during development/test)
        path.resolve(process.cwd(), 'infra/postgres/migrations', migrationFile),
        // From dist (after build)
        path.resolve(process.cwd(), '../../infra/postgres/migrations', migrationFile),
      ];

      let migrationPath: string | null = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          migrationPath = p;
          break;
        }
      }

      if (migrationPath) {
        const sql = fs.readFileSync(migrationPath, 'utf-8');
        // Split into statements and execute each
        const statements = parseSQL(sql);

        for (const stmt of statements) {
          try {
            await client.query(stmt);
          } catch (err: any) {
            // Ignore already-exists errors (42P07 = duplicate table, etc.)
            if (!['42P07', '42710', 'XX000'].includes(err.code)) {
              console.error(`Migration error in ${migrationFile} for statement:`, stmt.substring(0, 100));
              throw err;
            }
          }
        }
      }
    }
  } finally {
    client.release();
  }
}

async function cleanTestData(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Clear test data for each test run
    await client.query('DELETE FROM wms.event_outbox');
    await client.query('DELETE FROM wms.app_parameter');
    await client.query('DELETE FROM wms.rls_probe');
  } catch (e) {
    // Tables may not exist
  } finally {
    client.release();
  }
}

export interface TestContext {
  module: TestingModule;
  databaseService: DatabaseService;
  configService: ConfigService;
  pool: Pool;
}

export async function setupIntegrationTest(modules: any[] = []): Promise<TestContext> {
  const testModule = await Test.createTestingModule({
    imports: [TestRootModule, DatabaseModule, ...modules],
  }).compile();

  await testModule.init();

  const databaseService = testModule.get<DatabaseService>(DatabaseService);
  const configService = testModule.get<ConfigService>(ConfigService);

  if (!databaseService) {
    throw new Error('DatabaseService not found in TestingModule');
  }

  if (!configService) {
    throw new Error('ConfigService not found in TestingModule');
  }

  // RNF-ARQ-011: testContext.pool connects as wms_app — RLS is enforced.
  // Used by tests that verify unauthenticated/no-context behaviour (returns 0 rows).
  const pool = new Pool({
    host: configService.get('POSTGRES_HOST', 'localhost'),
    port: parseInt(configService.get('POSTGRES_PORT', '5432'), 10),
    database: configService.get('POSTGRES_DB', 'wms_db'),
    user: 'wms_app',
    password: 'wms_app_password',
  });

  // Separate admin pool to bypass RLS for data cleanup between test files.
  const adminPool = new Pool({
    host: configService.get('POSTGRES_HOST', 'localhost'),
    port: parseInt(configService.get('POSTGRES_PORT', '5432'), 10),
    database: configService.get('POSTGRES_DB', 'wms_db'),
    user: 'postgres',
    password: process.env.POSTGRES_ADMIN_PASSWORD || 'postgres_root_password',
  });

  try {
    await cleanTestData(adminPool);
  } catch (error) {
    // Tables may not exist yet — non-fatal
  } finally {
    await adminPool.end().catch(() => {});
  }

  return { module: testModule, databaseService, configService, pool };
}

export async function teardownIntegrationTest(context: TestContext): Promise<void> {
  try {
    await context.databaseService?.close();
  } catch (e) {
    console.warn('Error closing database service:', e);
  }

  try {
    await context.pool?.end();
  } catch (e) {
    console.warn('Error closing pool:', e);
  }

  try {
    await context.module?.close();
  } catch (e) {
    console.warn('Error closing module:', e);
  }
}
