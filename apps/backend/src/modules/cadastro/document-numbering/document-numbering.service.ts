// DOC-02 §5.6 — Numeração de documentos (resolve LAC-005), RN-DAD-040.
// Máscara PREFIXO-CODARMAZEM-SEQ8. O incremento é atômico via
// INSERT ... ON CONFLICT DO UPDATE (RNF-ARQ-021: o índice único de
// document_sequence serializa concorrência sem precisar de
// SELECT ... FOR UPDATE explícito) — deve rodar dentro da MESMA
// transação/client do documento causador, por isso recebe um PoolClient já
// aberto em vez de abrir a própria transação.
import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../core/database/database.service.js';

export type DocumentType =
  | 'INBOUND_ORDER'
  | 'OUTBOUND_ORDER'
  | 'TRANSFER'
  | 'INVENTORY'
  | 'LPN'
  | 'PRE_INVOICE'
  | 'RETURN_ORDER'
  | 'APPOINTMENT';

export type MaskedDocumentType = Exclude<DocumentType, 'LPN'>;

// DOC-02 §5.6 tabela de máscaras. LPN não usa esta máscara — "formato
// próprio RN-DAD-030" (ver lpn.service.ts).
const DOCUMENT_PREFIXES: Record<MaskedDocumentType, string> = {
  INBOUND_ORDER: 'REC',
  OUTBOUND_ORDER: 'PED',
  TRANSFER: 'TRF',
  INVENTORY: 'INV',
  PRE_INVOICE: 'FAT',
  RETURN_ORDER: 'DEV',
  APPOINTMENT: 'AGD',
};

@Injectable()
export class DocumentNumberingService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * Incrementa (ou cria) wms.document_sequence para (documentType,
   * warehouseId) e retorna o novo last_value. document_sequence é GLOBAL
   * (RN-DAD-004, sem RLS) — funciona com qualquer client/transação, tenha
   * ela contexto de tenant setado ou não.
   */
  async nextValue(client: PoolClient, documentType: DocumentType, warehouseId: string, actorUserId: string): Promise<bigint> {
    const result = await client.query(
      `INSERT INTO wms.document_sequence (document_type, warehouse_id, last_value, created_by)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (document_type, warehouse_id)
       DO UPDATE SET last_value = wms.document_sequence.last_value + 1, updated_at = now(), updated_by = $3
       RETURNING last_value`,
      [documentType, warehouseId, actorUserId]
    );
    return BigInt(result.rows[0].last_value);
  }

  /** RN-DAD-040: <PREFIXO>-<CÓDIGO DO ARMAZÉM>-<SEQUENCIAL 8 dígitos zero-padded>. */
  async generateDocumentNumber(
    client: PoolClient,
    documentType: MaskedDocumentType,
    warehouseId: string,
    warehouseCode: string,
    actorUserId: string
  ): Promise<string> {
    const seq = await this.nextValue(client, documentType, warehouseId, actorUserId);
    const prefix = DOCUMENT_PREFIXES[documentType];
    return `${prefix}-${warehouseCode}-${seq.toString().padStart(8, '0')}`;
  }

  /** Conveniência para uso fora de uma transação já aberta (ex.: testes) — abre a própria transactionGlobal(). */
  async generateDocumentNumberStandalone(
    documentType: MaskedDocumentType,
    warehouseId: string,
    warehouseCode: string,
    actorUserId: string
  ): Promise<string> {
    return this.db.transactionGlobal((client) => this.generateDocumentNumber(client, documentType, warehouseId, warehouseCode, actorUserId));
  }
}
