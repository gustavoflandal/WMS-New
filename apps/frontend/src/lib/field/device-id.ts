// DOC-15 RNF-COL-003 — device_id (UUID v7) gerado na primeira execução e
// persistido em IndexedDB (não sessionStorage/localStorage — DOC-15 é
// explícito: "persistido em IndexedDB"). `idb` é só um wrapper de
// Promise sobre a API nativa, não um banco alternativo.
import { openDB, DBSchema } from 'idb';

interface FieldDeviceDB extends DBSchema {
  device: {
    key: string;
    value: { id: string; createdAt: string };
  };
}

const DB_NAME = 'wms_field';
const STORE_NAME = 'device';
const RECORD_KEY = 'current';

function uuidV7(): string {
  // UUID v7 mínimo (timestamp de 48 bits + aleatório) — suficiente como
  // identificador de dispositivo (RD-COL-001), sem dependência externa.
  const timestamp = BigInt(Date.now());
  const timeHex = timestamp.toString(16).padStart(12, '0');
  const randomHex = crypto.getRandomValues(new Uint8Array(10)).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${randomHex.slice(0, 3)}`,
    ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + randomHex.slice(4, 7),
    randomHex.slice(7, 19),
  ].join('-');
}

async function getDb() {
  return openDB<FieldDeviceDB>(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

/** RNF-COL-003: retorna o device_id persistido, gerando um novo na primeira execução. */
export async function getOrCreateFieldDeviceId(): Promise<string> {
  const db = await getDb();
  const existing = await db.get(STORE_NAME, RECORD_KEY);
  if (existing) return existing.id;

  const id = uuidV7();
  await db.put(STORE_NAME, { id, createdAt: new Date().toISOString() }, RECORD_KEY);
  return id;
}
