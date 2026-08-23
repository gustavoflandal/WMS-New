// Teste de referência PERMANENTE — DOC-11 §6 (Gherkin "Conteúdo GS1 do
// LPN") e RN-PER-010. O LPN 129000000000012346 é o MESMO exemplo normativo
// já validado em cadastro/lpn/__tests__/lpn.util.spec.ts (DOC-02 RN-DAD-030)
// — DOC-11 reaproveita o mesmo LPN para exemplificar a element string GS1.
import {
  computeGs1CheckDigit,
  validateSsccCheckDigit,
  buildLpnElementString,
  deriveGtin14FromEan13,
  formatExpirationAi17,
  buildBatchElementString,
  buildAddressContent,
} from '../gs1.util.js';

describe('DOC-11 RN-PER-010 — GS1: element string do LPN, um conteúdo/duas simbologias', () => {
  it('exemplo normativo: LPN 129000000000012346 -> element string (00)129000000000012346', () => {
    expect(buildLpnElementString('129000000000012346')).toBe('(00)129000000000012346');
  });

  it('valida o dígito verificador do SSCC (Gherkin: "coletor deve validar o dígito verificador antes de aceitar")', () => {
    expect(validateSsccCheckDigit('129000000000012346')).toBe(true);
  });

  it('rejeita SSCC com dígito verificador incorreto (1 dígito alterado)', () => {
    expect(validateSsccCheckDigit('129000000000012340')).toBe(false);
  });

  it('rejeita SSCC com tamanho diferente de 18', () => {
    expect(validateSsccCheckDigit('12900000000001234')).toBe(false);
  });

  it('buildLpnElementString lança para SSCC inválido (dígito verificador não confere)', () => {
    expect(() => buildLpnElementString('129000000000012340')).toThrow(/dígito verificador/);
  });

  it('computeGs1CheckDigit generaliza para qualquer tamanho de base (SSCC 17 dígitos)', () => {
    expect(computeGs1CheckDigit('12900000000001234')).toBe(6);
  });

  it('endereço: Code128/QR usam o location.code literal, sem AI (RN-DAD-011)', () => {
    expect(buildAddressContent('A1-012-03-02')).toBe('A1-012-03-02');
  });
});

describe('DOC-11 RN-PER-010 — GTIN derivado de EAN-13 e AI(17) de validade', () => {
  it('GTIN-14 = EAN-13 com indicador 0 à esquerda', () => {
    expect(deriveGtin14FromEan13('7891000100103')).toBe('07891000100103');
  });

  it('rejeita EAN-13 com tamanho incorreto', () => {
    expect(() => deriveGtin14FromEan13('789100010010')).toThrow(/13 dígitos/);
  });

  it('AI(17): 2026-08-23 -> "260823"', () => {
    expect(formatExpirationAi17('2026-08-23')).toBe('260823');
  });

  it('etiqueta de lote interno com EAN: (01)GTIN (10)LOTE (17)AAMMDD', () => {
    const result = buildBatchElementString({
      ean13: '7891000100103',
      sku: 'SKU1',
      batchCode: 'L2026001',
      expirationDate: '2026-08-23',
    });
    expect(result).toBe('(01)07891000100103(10)L2026001(17)260823');
  });

  it('produto SEM EAN: código interno Code128 simples "P|" + SKU (AI(02) proibido)', () => {
    const result = buildBatchElementString({
      ean13: null,
      sku: 'SKU-SEM-EAN',
      batchCode: 'L2026002',
      expirationDate: null,
    });
    expect(result).toBe('P|SKU-SEM-EAN');
  });

  it('produto com EAN mas sem expiration_date lança erro determinístico', () => {
    expect(() =>
      buildBatchElementString({ ean13: '7891000100103', sku: 'SKU1', batchCode: 'L1', expirationDate: null })
    ).toThrow(/expiration_date/);
  });
});
