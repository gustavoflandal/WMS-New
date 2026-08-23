// Teste de referência PERMANENTE — DOC-15 §6 (Gherkin) e RN-COL-012/RN-PER-010.
// Mesmo exemplo normativo já usado no backend (LPN 129000000000012346).
import { describe, it, expect } from 'vitest';
import { classifyCode, validateSsccCheckDigit, validateExpectedType, computeGs1CheckDigit } from '../scanner.js';

describe('DOC-15 RN-COL-012 — classificação universal de leitura', () => {
  it('classifica LPN válido (exemplo normativo)', () => {
    expect(classifyCode('129000000000012346')).toEqual({ type: 'LPN', value: '129000000000012346', valid: true });
  });

  it('aceita LPN com prefixo AI (00) explícito (conteúdo GS1-128/QR)', () => {
    expect(classifyCode('(00)129000000000012346')).toEqual({ type: 'LPN', value: '129000000000012346', valid: true });
  });

  it('LPN com dígito verificador inválido é classificado como LPN mas inválido (Gherkin DOC-15 §6)', () => {
    const result = classifyCode('129000000000012345');
    expect(result.type).toBe('LPN');
    expect(result.valid).toBe(false);
  });

  it('classifica endereço (RN-DAD-011)', () => {
    expect(classifyCode('A1-012-03-02')).toEqual({ type: 'ENDERECO', value: 'A1-012-03-02', valid: true });
  });

  it('classifica EAN-13/EAN-8/DUN-14 por comprimento', () => {
    expect(classifyCode('7891000100103').type).toBe('EAN13');
    expect(classifyCode('12345678').type).toBe('EAN8');
    expect(classifyCode('12345678901234').type).toBe('DUN14');
  });

  it('código não reconhecido', () => {
    expect(classifyCode('abc').type).toBe('DESCONHECIDO');
  });

  it('computeGs1CheckDigit generaliza para base de 17 dígitos (mesmo exemplo do backend)', () => {
    expect(computeGs1CheckDigit('12900000000001234')).toBe(6);
  });

  it('validateSsccCheckDigit rejeita tamanho diferente de 18', () => {
    expect(validateSsccCheckDigit('12900000000001234')).toBe(false);
  });
});

describe('DOC-15 §6 Gherkin — "Tipo de código inesperado é rejeitado"', () => {
  it('esperando ENDEREÇO, lê um LPN válido -> rejeitado com motivo claro', () => {
    const result = validateExpectedType('129000000000012346', ['ENDERECO']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Esperado: ENDERECO/);
  });

  it('esperando LPN, lê um endereço -> rejeitado', () => {
    const result = validateExpectedType('A1-012-03-02', ['LPN']);
    expect(result.ok).toBe(false);
  });

  it('esperando LPN, lê o LPN correto -> aceito', () => {
    const result = validateExpectedType('129000000000012346', ['LPN']);
    expect(result.ok).toBe(true);
    expect(result.classified.value).toBe('129000000000012346');
  });

  it('LPN com dígito verificador inválido é rejeitado mesmo quando LPN é o tipo esperado', () => {
    const result = validateExpectedType('129000000000012345', ['LPN']);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/verificador/);
  });
});
