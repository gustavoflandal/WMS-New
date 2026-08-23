// DOC-15 RNF-COL-003 — device_id (UUID v7) gerado na primeira execução e
// persistido em IndexedDB (não sessionStorage/localStorage — DOC-15 é
// explícito: "persistido em IndexedDB"). `idb` é só um wrapper de
// Promise sobre a API nativa, não um banco alternativo.
//
// A conexão IndexedDB em si (schema, versão, `openDB`) vive em field-db.ts
// (COL-2B) — um único ponto de conexão para todos os stores de `wms_field`,
// evitando duas chamadas concorrentes de `openDB` com versões diferentes.
import { getFieldDb, uuidV7, SINGLETON_KEY } from './field-db';

const STORE_NAME = 'device';

/** RNF-COL-003: retorna o device_id persistido, gerando um novo na primeira execução. */
export async function getOrCreateFieldDeviceId(): Promise<string> {
  const db = await getFieldDb();
  const existing = await db.get(STORE_NAME, SINGLETON_KEY);
  if (existing) return existing.id;

  const id = uuidV7();
  await db.put(STORE_NAME, { id, createdAt: new Date().toISOString() }, SINGLETON_KEY);
  return id;
}
