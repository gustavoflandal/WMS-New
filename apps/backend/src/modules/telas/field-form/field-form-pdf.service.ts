// DOC-17 RF-TEL-020 — PDF do Formulário de Campo. Mesmo padrão de
// `DanfeService` (DOC-08/8B): pdf-lib, página A4, texto linha a linha,
// upload via FileStorageService — não inventa uma segunda técnica de
// geração de PDF no projeto. Entrega só por download (ver decisão 5 do
// prompt da sessão) — não enfileira PRINT_PDF no Edge Agent.
import { Inject, Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { FileStorageService } from '../../../core/storage/file-storage.service.js';
import { encodeCode128B, code128ToBars } from './code128.util.js';

export interface FieldFormPdfLine {
  lineNumber: number;
  previsto: Record<string, unknown>;
}

export interface FieldFormPdfInput {
  id: string;
  number: string;
  formType: string;
  warehouseCode: string;
  issuedAt: Date;
  validUntil: Date;
  declaredExecutorName: string;
  declaredExecutorRegistration: string | null;
  reissueSeq: number;
  lines: FieldFormPdfLine[];
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.join(' | ');
  return String(value);
}

@Injectable()
export class FieldFormPdfService {
  constructor(@Inject(FileStorageService) private readonly fileStorageService: FileStorageService) {}

  async generate(input: FieldFormPdfInput): Promise<string> {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let y = 800;
    const drawLine = (text: string, size = 10, useFont = font) => {
      page.drawText(text, { x: 40, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + 6;
    };

    drawLine(`Formulário de Campo — ${input.formType}`, 14, bold);
    const reissueSuffix = input.reissueSeq > 0 ? ` (RE${input.reissueSeq})` : '';
    drawLine(`Número: ${input.number}${reissueSuffix}`, 12, bold);

    // RF-TEL-020: código de barras Code 128 do número (localizar na transcrição).
    const { bars } = code128ToBars(encodeCode128B(input.number));
    const moduleWidth = 1.4;
    const barcodeHeight = 32;
    const barcodeX = 40;
    const barcodeY = y - barcodeHeight;
    for (const bar of bars) {
      page.drawRectangle({ x: barcodeX + bar.x * moduleWidth, y: barcodeY, width: Math.max(bar.width * moduleWidth, 0.5), height: barcodeHeight, color: rgb(0, 0, 0) });
    }
    y = barcodeY - 16;

    drawLine(`Armazém: ${input.warehouseCode}   Emitido em: ${input.issuedAt.toLocaleString('pt-BR')}`);
    drawLine(`Validade até: ${input.validUntil.toLocaleString('pt-BR')}`);
    drawLine(`Executante: ${input.declaredExecutorName}${input.declaredExecutorRegistration ? ` (matrícula ${input.declaredExecutorRegistration})` : ''}`);
    y -= 8;

    drawLine('Linhas de trabalho:', 11, bold);
    for (const l of input.lines) {
      const fields = Object.entries(l.previsto)
        .map(([k, v]) => `${k}: ${formatFieldValue(v)}`)
        .join('   ');
      drawLine(`${l.lineNumber}. ${fields}`, 8);
      drawLine('    Realizado: ______________________   Observação (divergência): ______________________', 8);
      y -= 4;
    }

    y -= 10;
    drawLine('Este formulário deve retornar para digitação (DOC-17 RF-TEL-020).', 9);

    const pdfBytes = await pdfDoc.save();
    return this.fileStorageService.upload('field_form', input.id, 'formulario.pdf', 'application/pdf', Buffer.from(pdfBytes));
  }
}
