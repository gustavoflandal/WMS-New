// DOC-15 RN-COL-012 [INVIOLÁVEL] — validador universal de leitura: toda
// leitura, de qualquer origem (wedge, câmera, digitação com
// EST.DIGITACAO_LPN), passa pela MESMA classificação/validação. Funções
// puras (sem I/O) para teste unitário determinístico.
//
// computeGs1CheckDigit/validateSsccCheckDigit duplicam o algoritmo de
// apps/backend/src/modules/perifericos/gs1/gs1.util.ts (RN-PER-010) — front
// e backend são pacotes/builds separados sem um `packages/` compartilhado
// para isto ainda; a duplicação é de ~15 linhas, puras, e cobertas por teste
// próprio (mesmo exemplo normativo LPN 129000000000012346).

export type CodeType = 'LPN' | 'ENDERECO' | 'EAN13' | 'EAN8' | 'DUN14' | 'DESCONHECIDO';

export interface ClassifiedCode {
  type: CodeType;
  value: string;
  valid: boolean;
}

/** Mod-10 GS1 (pesos alternados 3/1 a partir do dígito mais à direita) — mesmo algoritmo de RN-PER-010/RN-DAD-030. */
export function computeGs1CheckDigit(base: string): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const digit = parseInt(base[base.length - 1 - i], 10);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  return (10 - (sum % 10)) % 10;
}

export function validateSsccCheckDigit(sscc18: string): boolean {
  if (!/^[0-9]{18}$/.test(sscc18)) return false;
  const base17 = sscc18.slice(0, 17);
  const checkDigit = parseInt(sscc18[17], 10);
  return computeGs1CheckDigit(base17) === checkDigit;
}

// RN-DAD-011: endereço = Rua-Módulo-Nível-Vão (ex.: A1-012-03-02).
const ADDRESS_PATTERN = /^[A-Z0-9]{1,4}-[0-9]{2,3}-[0-9]{2}-[0-9]{2}$/;

/** RN-COL-012: identifica o tipo do código lido, de QUALQUER origem (físico ou câmera). */
export function classifyCode(raw: string): ClassifiedCode {
  const trimmed = raw.trim().toUpperCase();
  // GS1-128/QR podem incluir o AI (00) explícito no conteúdo decodificado.
  const ssccCandidate = trimmed.startsWith('(00)') ? trimmed.slice(4) : trimmed;

  if (/^[0-9]{18}$/.test(ssccCandidate)) {
    return { type: 'LPN', value: ssccCandidate, valid: validateSsccCheckDigit(ssccCandidate) };
  }
  if (ADDRESS_PATTERN.test(trimmed)) {
    return { type: 'ENDERECO', value: trimmed, valid: true };
  }
  if (/^[0-9]{13}$/.test(trimmed)) return { type: 'EAN13', value: trimmed, valid: true };
  if (/^[0-9]{8}$/.test(trimmed)) return { type: 'EAN8', value: trimmed, valid: true };
  if (/^[0-9]{14}$/.test(trimmed)) return { type: 'DUN14', value: trimmed, valid: true };
  return { type: 'DESCONHECIDO', value: trimmed, valid: false };
}

export interface ScanValidationResult {
  ok: boolean;
  classified: ClassifiedCode;
  reason?: string;
}

/**
 * RN-COL-012 [INVIOLÁVEL]: rejeição imediata de código de tipo inesperado
 * para o passo atual — "leu produto quando o passo pede endereço" é erro
 * claro, nunca aceitação silenciosa.
 */
export function validateExpectedType(raw: string, expectedTypes: CodeType[]): ScanValidationResult {
  const classified = classifyCode(raw);
  if (!classified.valid) {
    return {
      ok: false,
      classified,
      reason: classified.type === 'LPN' ? 'Dígito verificador do LPN inválido' : 'Código não reconhecido',
    };
  }
  if (!expectedTypes.includes(classified.type)) {
    return { ok: false, classified, reason: `Esperado: ${expectedTypes.join(' ou ')} — lido: ${classified.type}` };
  }
  return { ok: true, classified };
}
