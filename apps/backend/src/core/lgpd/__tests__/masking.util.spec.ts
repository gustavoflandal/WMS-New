// Teste de referência PERMANENTE — DOC-12 §6 (Gherkin), exemplo normativo
// de mascaramento de CPF. NÃO altere o valor esperado.
import { maskCpf, maskCnh } from '../masking.util.js';

describe('RN-SEG-051 - mascaramento de CPF/CNH', () => {
  it('exemplo normativo do DOC-12: CPF 123.456.789-09 -> "***.456.789-**"', () => {
    expect(maskCpf('123.456.789-09')).toBe('***.456.789-**');
  });

  it('aceita CPF sem formatação (apenas dígitos)', () => {
    expect(maskCpf('12345678909')).toBe('***.456.789-**');
  });

  it('rejeita CPF com quantidade errada de dígitos', () => {
    expect(() => maskCpf('123.456.789')).toThrow(/11 dígitos/);
  });

  it('maskCnh mantém formato consistente (3 blocos, bloco central visível)', () => {
    const masked = maskCnh('12345678901');
    expect(masked).toBe('***45678***');
  });
});
