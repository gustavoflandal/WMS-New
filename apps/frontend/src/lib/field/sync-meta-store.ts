// RNF-ARQ-054 — timestamp da última sincronização bem-sucedida (round-trip
// completo ao servidor, independente de a fila ter esvaziado).
import { getFieldDb, SINGLETON_KEY } from './field-db';

export async function getLastSyncSuccessAt(): Promise<string | null> {
  const db = await getFieldDb();
  const meta = await db.get('sync_meta', SINGLETON_KEY);
  return meta?.lastSyncSuccessAt ?? null;
}

export async function setLastSyncSuccessAt(iso: string): Promise<void> {
  const db = await getFieldDb();
  await db.put('sync_meta', { lastSyncSuccessAt: iso }, SINGLETON_KEY);
}
