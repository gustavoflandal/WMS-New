// Helpers compartilhados pelos testes de integração de cadastro (DOC-02).
import { v4 as uuid } from 'uuid';
import type { DatabaseService, TenantContext } from '../../../core/database/database.service.js';

const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

/** Gera um CNPJ com dígito verificador válido (mesmo algoritmo de wms.is_valid_cnpj), único a cada chamada. */
export function generateValidCnpj(): string {
  let base: number[];
  do {
    base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  } while (base.every((d) => d === base[0]));
  const dv1 = checkDigit(base, CNPJ_WEIGHTS_1);
  const dv2 = checkDigit([...base, dv1], CNPJ_WEIGHTS_2);
  return [...base, dv1, dv2].join('');
}

/** Código curto único (formato ^[A-Z0-9]{1,6}$) para warehouse.code em testes isolados. */
export function randomWarehouseCode(): string {
  return 'T' + uuid().replace(/-/g, '').substring(0, 5).toUpperCase();
}

/** Código curto único (formato ^[A-Z0-9]{1,10}$) para client.code em testes isolados. */
export function randomClientCode(): string {
  return 'C' + uuid().replace(/-/g, '').substring(0, 8).toUpperCase();
}

/** SKU único (product.sku, máx. 40 chars) em testes isolados. */
export function randomSku(): string {
  return 'SKU-' + uuid();
}

// DOC-12 migration 0015: usuário "Sistema" bootstrap — único UUID garantido
// como linha real de wms.user em qualquer ambiente de teste, necessário
// desde que audit_log.user_id ganhou FK NOT NULL para wms.user(id)
// (migration 0019). Um uuid() aleatório (como antes) violaria essa FK
// assim que o serviço grava a trilha de auditoria explícita (update/deactivate).
export const SEED_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

// DOC-05 RN-EST-001 [INVIOLÁVEL] (migration 0044): wms.stock_balance ganhou
// um trigger BEFORE INSERT/UPDATE que rejeita qualquer escrita fora do
// StockMovementService (sinalizada pela session var
// app.stock_movement_authorized). Estes testes de DOC-02 (Sessão 2B, prévios
// a esta sessão) escrevem em stock_balance diretamente por não terem o
// serviço central ainda — preservados aqui como prova de que os CHECKs/
// triggers de nível de dado (RG-004, RN-DAD-020) continuam válidos como
// última linha de defesa, "autorizando" a escrita crua só o suficiente para
// alcançar o CHECK/trigger que cada teste realmente exercita.
export async function rawAuthorizedQuery<T = any>(
  databaseService: DatabaseService,
  ctx: TenantContext,
  sql: string,
  params: unknown[]
): Promise<{ rows: T[] }> {
  return databaseService.transaction(ctx, async (client) => {
    await client.query(`SELECT set_config('app.stock_movement_authorized', 'true', true)`);
    return client.query(sql, params);
  });
}
