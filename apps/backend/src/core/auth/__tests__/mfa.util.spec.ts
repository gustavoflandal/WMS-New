// Teste de referência PERMANENTE — RFC 6238 Apêndice B, vetor de teste
// oficial (SHA-1). NÃO altere o valor esperado.
import { computeHotp, computeTotp, base32Encode, base32Decode, generateBase32Secret, verifyTotp } from '../mfa.util.js';

describe('RFC 6238/4226 - TOTP/HOTP', () => {
  it('vetor de teste oficial RFC 6238 Apêndice B (SHA-1, T=59 -> counter=1 -> 94287082, 8 dígitos)', () => {
    const key = Buffer.from('12345678901234567890', 'ascii');
    expect(computeHotp(key, 1n, 8)).toBe('94287082');
  });

  it('vetor de teste oficial RFC 6238 Apêndice B (T=1111111109 -> counter=0x23523EC -> 07081804)', () => {
    const key = Buffer.from('12345678901234567890', 'ascii');
    expect(computeHotp(key, 0x23523ecn, 8)).toBe('07081804');
  });

  it('base32Decode(base32Encode(x)) == x (round-trip)', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original))).toEqual(original);
  });

  it('generateBase32Secret produz segredo valido usavel por computeTotp/verifyTotp', () => {
    const secret = generateBase32Secret();
    const now = Date.now();
    const code = computeTotp(secret, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, now)).toBe(true);
  });

  it('verifyTotp rejeita codigo incorreto', () => {
    const secret = generateBase32Secret();
    expect(verifyTotp(secret, '000000', Date.now())).toBe(false);
  });

  it('verifyTotp tolera deriva de 1 step (30s) mas nao 2 steps', () => {
    const secret = generateBase32Secret();
    const now = Date.now();
    const codeOneStepAgo = computeTotp(secret, now - 30_000);
    const codeTwoStepsAgo = computeTotp(secret, now - 60_000);
    expect(verifyTotp(secret, codeOneStepAgo, now)).toBe(true);
    // So falha se o codigo de 2 steps atras tambem nao coincidir com o de 1 step (evita falso positivo por colisao)
    if (codeTwoStepsAgo !== codeOneStepAgo) {
      expect(verifyTotp(secret, codeTwoStepsAgo, now)).toBe(false);
    }
  });
});
