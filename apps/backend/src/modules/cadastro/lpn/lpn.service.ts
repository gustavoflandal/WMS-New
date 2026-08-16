// DOC-02 RN-DAD-030 [INVIOLÁVEL] — geração de LPN (SSCC 18 dígitos).
// Prefixo GS1 lido de wms.app_parameter (scope WAREHOUSE, name
// 'GS1_PREFIX'); fallback para o prefixo interno 2900000 quando o armazém
// não tem prefixo próprio configurado. Sequencial por armazém via
// wms.document_sequence (document_type = 'LPN', DocumentNumberingService).
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DocumentNumberingService } from '../document-numbering/document-numbering.service.js';
import { buildSsccLpn } from './lpn.util.js';

// [LACUNA: DOC-02 não define regra de escolha do dígito de extensão além do
// exemplo normativo (valor 1) — fixado em 1 para todo LPN gerado.]
const EXTENSION_DIGIT = 1;
const DEFAULT_GS1_PREFIX = '2900000';

@Injectable()
export class LpnService {
  constructor(private readonly documentNumbering: DocumentNumberingService) {}

  /**
   * Gera um LPN único (SSCC de 18 dígitos) para o armazém informado, dentro
   * do client/transação fornecido pelo chamador (pallet é DE TENANT — a
   * transação já tem app.tenant_ids setado quando isto é chamado a partir
   * de PalletService.create()). app_parameter não tem RLS restritiva para
   * scope=WAREHOUSE além de exigir algum tenant context setado (ver
   * migration 0004) — funciona normalmente dentro dessa transação.
   */
  async generate(client: PoolClient, warehouseId: string, actorUserId: string): Promise<string> {
    const paramResult = await client.query(
      `SELECT value FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND warehouse_id = $1 AND name = 'GS1_PREFIX'`,
      [warehouseId]
    );
    const prefix: string = paramResult.rows[0]?.value ?? DEFAULT_GS1_PREFIX;
    if (!/^[0-9]{7}$/.test(prefix)) {
      throw new Error(`RN-DAD-030: GS1_PREFIX configurado inválido para o armazém ${warehouseId}: "${prefix}"`);
    }

    const sequential = await this.documentNumbering.nextValue(client, 'LPN', warehouseId, actorUserId);
    return buildSsccLpn(EXTENSION_DIGIT, prefix, sequential);
  }
}
