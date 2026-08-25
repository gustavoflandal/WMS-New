// DOC-08 RF-FIS-064 — DANFE (PDF) de toda nota autorizada. Layout mínimo
// (não é o layout oficial pixel-a-pixel do Manual de Orientação do
// Contribuinte — fora de escopo da 8B, que é sobre o motor/protocolo, não
// sobre diagramação fiscal): chave de acesso, emitente, destinatário,
// itens e valor total, o suficiente para conferência e impressão via
// Edge Agent (DOC-11).
import { Inject, Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';

@Injectable()
export class DanfeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(FileStorageService) private readonly fileStorageService: FileStorageService
  ) {}

  async generateDanfe(fiscalDocumentId: string, tenantId: string, warehouseId: string, actorUserId: string): Promise<string> {
    const ctx: TenantContext = { tenant_id: tenantId, user_id: actorUserId, warehouse_id: warehouseId };
    const docResult = await this.db.query(ctx, `SELECT * FROM wms.fiscal_document WHERE id = $1`, [fiscalDocumentId]);
    const doc = docResult.rows[0];
    if (!doc) throw new Error(`fiscal_document ${fiscalDocumentId} not found`);

    const itemsResult = await this.db.query(
      ctx,
      `SELECT fdi.*, p.description AS product_description
       FROM wms.fiscal_document_item fdi JOIN wms.product p ON p.id = fdi.product_id
       WHERE fdi.fiscal_document_id = $1 ORDER BY fdi.line_number`,
      [fiscalDocumentId]
    );

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let y = 800;
    const line = (text: string, size = 10, useFont = font) => {
      page.drawText(text, { x: 40, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + 6;
    };

    line('DANFE — Documento Auxiliar da Nota Fiscal Eletrônica', 14, bold);
    line(`Chave de acesso: ${doc.access_key ?? '(não emitida)'}`);
    line(`Número: ${doc.nfe_number ?? doc.internal_number}  Série: ${doc.nfe_serie ?? '-'}`);
    line(`Emitente: ${doc.issuer_name} (${doc.issuer_cnpj})`);
    line(`Destinatário: ${doc.recipient_name} (${doc.recipient_cnpj})`);
    line(`Status: ${doc.status}   Protocolo: ${doc.protocol_number ?? '-'}`);
    y -= 10;
    line('Itens:', 11, bold);
    for (const item of itemsResult.rows) {
      line(`${item.line_number}. ${item.product_description} — qtd ${Number(item.qty).toFixed(4)}`);
    }
    y -= 10;
    line(`Valor total: R$ ${Number(doc.total_value ?? 0).toFixed(2)}`, 11, bold);

    const pdfBytes = await pdfDoc.save();
    const storageKey = await this.fileStorageService.upload('fiscal_document_danfe', fiscalDocumentId, 'danfe.pdf', 'application/pdf', Buffer.from(pdfBytes));
    return storageKey;
  }
}
