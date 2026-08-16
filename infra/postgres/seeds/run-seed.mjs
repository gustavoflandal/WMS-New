// Runner standalone para infra/postgres/seeds/*.sql — NÃO faz parte do boot
// automático (DatabaseModule.onModuleInit só roda migrations, não seeds).
// Uso: pnpm db:seed (definido em apps/backend/package.json).
// Conecta como a role admin/bootstrap (mesma usada pelo MigrationRunner),
// NÃO como wms_app: a partir da Sessão 2B os seeds tocam tabelas DE TENANT
// com RLS (client, product, batch, ...) e client.id = tenant_id só é
// conhecido DEPOIS do INSERT — sem bypass de RLS não dá para fazer o
// bootstrap (mesmo problema documentado em ClientService.create()). Um
// script de seed é ferramenta administrativa (não é o pool de
// request-path/RNF-ARQ-011, que continua restrito a wms_app), então
// bypassar RLS aqui é apropriado, igual ao MigrationRunner.
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'wms_db',
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres_root_password',
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
