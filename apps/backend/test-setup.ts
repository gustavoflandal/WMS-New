// Global test setup — runs once before all tests
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Sessão 4A item 0 [débito da Sessão 4]: carrega .env.test com override:true
// ANTES de qualquer leitura de process.env.POSTGRES_* abaixo — este script
// executa `DROP SCHEMA wms CASCADE` logo a seguir; sem isso, herdar
// POSTGRES_PORT=5432 do shell/.env de desenvolvimento apagaria o banco de
// dev real se o docker-compose.yml estivesse ativo (achado da Sessão 4).
// override:true é necessário porque dotenv, por padrão, NUNCA sobrescreve
// uma variável já presente em process.env — e POSTGRES_PORT/REDIS_URL etc.
// podem já estar setados pelo shell do desenvolvedor a partir do .env.
const envTestCandidates = [
  path.resolve(process.cwd(), '.env.test'),
  path.resolve(process.cwd(), '../../.env.test'),
];
const envTestPath = envTestCandidates.find((p) => fs.existsSync(p));
if (envTestPath) {
  dotenv.config({ path: envTestPath, override: true });
} else {
  throw new Error(
    '.env.test não encontrado (candidatos: ' +
      envTestCandidates.join(', ') +
      '). Copie .env.test.example para .env.test na raiz do repositório antes de rodar pnpm test:integration — isso evita apontar os testes para o Postgres/Redis de desenvolvimento (docker-compose.yml).'
  );
}

// Ensure env vars are set for admin setup (must use postgres for schema creation)
const ADMIN_HOST = process.env.POSTGRES_HOST || 'localhost';
const ADMIN_PORT = parseInt(process.env.POSTGRES_PORT || '5432');
const ADMIN_DB = process.env.POSTGRES_DB || 'wms_db';
const ADMIN_USER = 'postgres'; // Always admin for setup
const ADMIN_PASSWORD = process.env.POSTGRES_ADMIN_PASSWORD || 'postgres_root_password';

// Defesa em profundidade: 5432 é a porta padrão do Postgres de DESENVOLVIMENTO
// (docker-compose.yml). Este script executa DROP SCHEMA CASCADE a seguir —
// recusa-se a rodar contra essa porta mesmo que .env.test esteja malformado.
if (ADMIN_PORT === 5432) {
  throw new Error(
    `POSTGRES_PORT=5432 apontaria os testes de integração para o Postgres de DESENVOLVIMENTO ` +
      `(docker-compose.yml) — este script executa DROP SCHEMA wms CASCADE. Verifique .env.test ` +
      `(deve usar a porta 5433, ver .env.test.example).`
  );
}

// SQL parser: remove single-line comments, then split by semicolon.
// Handles single-quotes, double-quotes, and dollar-quoted strings ($$...$$).
function parseSQL(sql: string): string[] {
  // Strip single-line comments (-- to end of line)
  const cleaned = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.substring(0, idx) : line;
    })
    .join('\n');

  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | null = null; // active dollar-quote tag, e.g. "$$" or "$body$"

  let i = 0;
  while (i < cleaned.length) {
    const char = cleaned[i];

    // --- Dollar-quote tracking (must check before single/double quote) ---
    if (!inSingleQuote && !inDoubleQuote && char === '$') {
      // Match $<tag>$ (tag may be empty for plain $$)
      const rest = cleaned.substring(i);
      const m = rest.match(/^\$([^$]*)\$/);
      if (m) {
        const tag = m[0]; // e.g. "$$" or "$body$"
        if (dollarTag === null) {
          // Open dollar-quote
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        } else if (tag === dollarTag) {
          // Close dollar-quote
          current += tag;
          i += tag.length;
          dollarTag = null;
          continue;
        }
      }
    }

    // Inside a dollar-quoted block — accumulate without quote/split tracking
    if (dollarTag !== null) {
      current += char;
      i++;
      continue;
    }

    // --- Single/double quote tracking ---
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    // --- Statement split ---
    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const stmt = current.trim();
      if (stmt.length > 0) statements.push(stmt);
      current = '';
    } else {
      current += char;
    }

    i++;
  }

  const stmt = current.trim();
  if (stmt.length > 0) statements.push(stmt);

  return statements;
}

// Global one-time setup
export async function setup() {
  console.log('🧪 Global test setup starting...');

  // Connect as admin (postgres) for schema setup
  const pool = new Pool({
    host: ADMIN_HOST,
    port: ADMIN_PORT,
    database: ADMIN_DB,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
  });

  try {
    const client = await pool.connect();
    try {
      // Drop old tables to ensure migrations recreate with correct schema
      // Force CASCADE to drop dependent objects (indexes, policies)
      try {
        console.log('Dropping wms schema...');
        await client.query('DROP SCHEMA IF EXISTS wms CASCADE');
        await client.query('CREATE SCHEMA wms');
        console.log('✓ Schema reset');
      } catch (e) {
        // If schema drop fails, try individual tables
        try {
          console.log('Dropping individual tables...');
          await client.query('DROP TABLE IF EXISTS wms.event_outbox CASCADE');
          await client.query('DROP TABLE IF EXISTS wms.app_parameter CASCADE');
          await client.query('DROP TABLE IF EXISTS wms.rls_probe CASCADE');
          console.log('✓ Tables dropped');
        } catch (e2) {
          // Ignore errors if tables don't exist
        }
      }

      // Run ALL migrations from the canonical directory (single source of truth,
      // shared with migration.runner.ts used by the real app/Docker bootstrap).
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

      for (const migrationFile of migrations) {
        const possiblePaths = [
          path.resolve(process.cwd(), 'infra/postgres/migrations', migrationFile),
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
          const statements = parseSQL(sql);

          console.log(`📝 Found ${statements.length} statements in ${migrationFile}`);

          for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            try {
              console.log(`📍 [${i+1}/${statements.length}] Executing: ${stmt.substring(0, 50)}...`);
              await client.query(stmt);
            } catch (err: any) {
              console.error(`❌ Failed statement [${i+1}]:`);
              console.error(`Statement length: ${stmt.length} chars`);
              console.error(`First 200 chars: ${stmt.substring(0, 200)}`);
              console.error(`Error: ${err.message}`);
              // Ignore duplicate table/index errors
              if (!['42P07', '42710'].includes(err.code)) {
                throw err;
              }
            }
          }

          // Record in schema_migration (mirrors MigrationRunner.runMigration()) so
          // that DatabaseModule's own MigrationRunner — invoked per test file via
          // setupIntegrationTest() — sees these as already applied and does not
          // attempt to rerun non-idempotent statements (e.g. CREATE POLICY without
          // a matching DROP POLICY IF EXISTS).
          const version = parseInt(migrationFile, 10);
          const description = migrationFile.replace(/^\d+-/, '').replace(/\.sql$/, '').replace(/-/g, ' ');
          await client.query(
            `INSERT INTO wms.schema_migration (version, description, type, installed_by)
             VALUES ($1, $2, 'SQL', 'system')
             ON CONFLICT (version) DO NOTHING`,
            [version, description]
          );
        }
      }

      console.log('✅ Test migrations initialized');
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('❌ Global setup error:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}
