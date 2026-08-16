// DOC-02 RN-DAD-030 [INVIOLÁVEL] — LPN numérico de 18 dígitos, padrão GS1
// SSCC: extensão(1) + prefixo(7) + sequencial(9) + dígito verificador
// Mod-10 GS1(1). Funções puras (sem I/O) para permitir teste unitário
// determinístico do exemplo normativo do documento.

/**
 * Dígito verificador Mod-10 GS1 sobre uma base de 17 dígitos: pesos
 * alternados 3/1 a partir do dígito MAIS À DIREITA (peso 3 primeiro).
 * check = (10 - (soma mod 10)) mod 10.
 */
export function computeGs1Mod10CheckDigit(base17: string): number {
  if (!/^[0-9]{17}$/.test(base17)) {
    throw new Error(`RN-DAD-030: base do SSCC deve ter exatamente 17 dígitos numéricos, recebido: ${base17}`);
  }
  let sum = 0;
  for (let i = 0; i < base17.length; i++) {
    const digit = parseInt(base17[base17.length - 1 - i], 10);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Monta o LPN (SSCC de 18 dígitos) a partir do dígito de extensão, prefixo
 * GS1 (7 dígitos) e sequencial (até 9 dígitos, zero-padded à esquerda).
 * [LACUNA: DOC-02 não define regra de escolha do dígito de extensão além do
 * exemplo normativo (valor 1) — este serviço sempre usa 1 (ver
 * lpn.service.ts).]
 */
export function buildSsccLpn(extensionDigit: number, gs1Prefix7: string, sequentialRaw: bigint | number): string {
  if (extensionDigit < 0 || extensionDigit > 9) {
    throw new Error(`RN-DAD-030: dígito de extensão deve ser 0-9, recebido: ${extensionDigit}`);
  }
  if (!/^[0-9]{7}$/.test(gs1Prefix7)) {
    throw new Error(`RN-DAD-030: prefixo GS1 deve ter exatamente 7 dígitos, recebido: ${gs1Prefix7}`);
  }
  const sequential9 = sequentialRaw.toString().padStart(9, '0');
  if (sequential9.length > 9) {
    throw new Error(`RN-DAD-030: sequencial excede 9 dígitos: ${sequentialRaw}`);
  }
  const base17 = `${extensionDigit}${gs1Prefix7}${sequential9}`;
  const checkDigit = computeGs1Mod10CheckDigit(base17);
  return `${base17}${checkDigit}`;
}
