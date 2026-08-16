// DOC-12 RF-SEG-005 — MFA TOTP (RFC 6238, sobre HOTP RFC 4226, SHA-1,
// step de 30s, 6 dígitos — parâmetros padrão de mercado; RF-SEG-005 exige
// "MFA TOTP" sem detalhar step/dígitos/algoritmo — [LACUNA: DOC-12 não
// especifica os parâmetros do TOTP; usados os defaults do RFC 6238/Google
// Authenticator, documentados aqui].
import { randomBytes, createHmac } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateBase32Secret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP core — dynamic truncation. keyBytes é o segredo cru (já decodificado), não base32. */
export function computeHotp(keyBytes: Buffer, counter: bigint, digits: number = DIGITS): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = createHmac('sha1', keyBytes).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const otp = binCode % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/** RFC 6238 TOTP: HOTP com contador derivado do tempo (step de 30s). */
export function computeTotp(secretBase32: string, timeMs: number = Date.now(), step: number = STEP_SECONDS, digits: number = DIGITS): string {
  const counter = BigInt(Math.floor(Math.floor(timeMs / 1000) / step));
  return computeHotp(base32Decode(secretBase32), counter, digits);
}

/** Verifica com janela de tolerância (±1 step, RFC 6238 recomenda tolerar deriva de relógio). */
export function verifyTotp(secretBase32: string, code: string, timeMs: number = Date.now(), windowSteps: number = 1): boolean {
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidateTime = timeMs + w * STEP_SECONDS * 1000;
    if (computeTotp(secretBase32, candidateTime) === code) {
      return true;
    }
  }
  return false;
}
