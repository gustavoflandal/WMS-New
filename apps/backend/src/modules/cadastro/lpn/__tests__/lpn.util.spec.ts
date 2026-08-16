// Teste de referência PERMANENTE — DOC-02 §7 (Gherkin) e RN-DAD-030: exemplo
// normativo validado por cálculo. NÃO altere o valor esperado.
import { computeGs1Mod10CheckDigit, buildSsccLpn } from '../lpn.util.js';

describe('RN-DAD-030 - Mod-10 GS1 e montagem do SSCC (LPN)', () => {
  it('exemplo normativo: extensão 1, prefixo 2900000, sequencial 000001234 -> LPN 129000000000012346', () => {
    expect(buildSsccLpn(1, '2900000', 1234)).toBe('129000000000012346');
  });

  it('dígito verificador isolado sobre a base 12900000000001234 é 6', () => {
    expect(computeGs1Mod10CheckDigit('12900000000001234')).toBe(6);
  });

  it('aceita sequencial como bigint', () => {
    expect(buildSsccLpn(1, '2900000', 1234n)).toBe('129000000000012346');
  });

  it('rejeita prefixo com tamanho diferente de 7', () => {
    expect(() => buildSsccLpn(1, '29000', 1234)).toThrow(/7 dígitos/);
  });

  it('rejeita sequencial que excede 9 dígitos', () => {
    expect(() => buildSsccLpn(1, '2900000', 9_999_999_999)).toThrow(/excede 9 dígitos/);
  });

  it('rejeita base com tamanho diferente de 17 no cálculo do dígito verificador', () => {
    expect(() => computeGs1Mod10CheckDigit('123')).toThrow(/17 dígitos/);
  });
});
