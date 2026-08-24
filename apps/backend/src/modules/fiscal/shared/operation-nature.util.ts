// DOC-08 §4.6 RN-FIS-050 [INVIOLÁVEL: "é PROIBIDO emitir com natureza não
// cadastrada para o par cliente × tipo"] — resolução de operation_nature:
// tenta a linha específica do cliente × armazém (override de cadastro);
// se ausente, cai para o padrão de instalação (linha GLOBAL, tenant_id/
// warehouse_id NULOS, seedada na migration 0069) — mesmo padrão de
// resolução "mais específico → GLOBAL" já usado por app_parameter
// (RNF-ARQ-080), só que com 2 níveis (não 4) porque RD-FIS-003 só define
// TENANT×WAREHOUSE e GLOBAL para esta tabela.
import { BadRequestException } from '@nestjs/common';
import { PoolClient } from 'pg';

export interface OperationNature {
  id: string;
  cfop: string;
  scopeType: 'INTERNO' | 'INTERESTADUAL';
}

/** RN-FIS-050 "âmbito": interno quando UF do cliente == UF do armazém, interestadual caso contrário. */
export function resolveScopeType(clientState: string | null, warehouseState: string | null): 'INTERNO' | 'INTERESTADUAL' {
  if (!clientState || !warehouseState) return 'INTERNO'; // [LACUNA: DOC-08] UF ausente no cadastro — assume o caso mais comum (armazém geral, mesma UF) em vez de travar a emissão.
  return clientState === warehouseState ? 'INTERNO' : 'INTERESTADUAL';
}

export async function resolveOperationNature(
  client: PoolClient,
  input: { tenantId: string; warehouseId: string; documentType: 'NOTA_ARMAZENAGEM' | 'NOTA_DEVOLUCAO_ARMAZENAGEM'; scopeType: 'INTERNO' | 'INTERESTADUAL' }
): Promise<OperationNature> {
  const specific = await client.query<{ id: string; cfop: string }>(
    `SELECT id, cfop FROM wms.operation_nature
     WHERE tenant_id = $1 AND warehouse_id = $2 AND document_type = $3 AND scope_type = $4 AND status = 'ACTIVE'`,
    [input.tenantId, input.warehouseId, input.documentType, input.scopeType]
  );
  if (specific.rows.length > 0) {
    return { id: specific.rows[0].id, cfop: specific.rows[0].cfop, scopeType: input.scopeType };
  }

  const fallback = await client.query<{ id: string; cfop: string }>(
    `SELECT id, cfop FROM wms.operation_nature
     WHERE tenant_id IS NULL AND warehouse_id IS NULL AND document_type = $1 AND scope_type = $2 AND status = 'ACTIVE'`,
    [input.documentType, input.scopeType]
  );
  if (fallback.rows.length === 0) {
    throw new BadRequestException({
      error: 'OPERATION_NATURE_NOT_REGISTERED',
      detail: `RN-FIS-050: é proibido emitir ${input.documentType}/${input.scopeType} sem natureza de operação cadastrada (nem específica, nem padrão de instalação)`,
    });
  }
  return { id: fallback.rows[0].id, cfop: fallback.rows[0].cfop, scopeType: input.scopeType };
}
