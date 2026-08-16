// Runner standalone para infra/postgres/seeds/*.sql — NÃO faz parte do boot
// automático (DatabaseModule.onModuleInit só roda migrations, não seeds).
// Uso: pnpm db:seed (definido em apps/backend/package.json).
// Conecta como wms_app: todas as tabelas alvo já têm GRANT INSERT/SELECT
// para wms_app (migrations 0008/0009), nenhum seed precisa de privilégio de
// owner.
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'wms_db',
  user: process.env.POSTGRES_APP_USER ?? 'wms_app',
  password: process.env.POSTGRES_APP_PASSWORD ?? 'wms_app_password',
});

async function run() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.match(/^\d+-.*\.sql$/))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    console.log(`Seeding: ${file}`);
    await pool.query(sql);
  }

  console.log(`Done. ${files.length} seed file(s) applied (idempotent).`);
  await pool.end();
}

run().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
