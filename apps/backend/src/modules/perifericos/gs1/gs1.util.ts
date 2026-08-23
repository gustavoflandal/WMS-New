// DOC-11 RN-PER-010 [INVIOLÁVEL] — conteúdo normativo GS1: um único
// conteúdo, duas simbologias (GS1-128 1D + QR 2D idêntico). Funções puras
// (sem I/O), mesmo espírito de cadastro/lpn/lpn.util.ts (que já implementa
// o dígito verificador Mod-10 GS1 fixo em 17 dígitos para o SSCC do LPN de
// palete/volume — reaproveitado aqui via computeGs1Mod10CheckDigit local,
// generalizado para qualquer tamanho de base, porque o dígito de GTIN é
// calculado sobre uma base de 12 dígitos, não 17).

/**
 * Dígito verificador Mod-10 GS1 (pesos alternados 3/1 a partir do dígito
 * MAIS À DIREITA, peso 3 primeiro) — mesmo algoritmo de
 * cadastro/lpn/lpn.util.ts#computeGs1Mod10CheckDigit, generalizado para
 * qualquer tamanho de base (SSCC: 17; GTIN-13: 12).
 */
export function computeGs1CheckDigit(base: string): number {
  if (!/^[0-9]+$/.test(base)) {
    throw new Error(`RN-PER-010: base do dígito verificador GS1 deve ser numérica, recebido: ${base}`);
  }
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const digit = parseInt(base[base.length - 1 - i], 10);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** RN-PER-010/Gherkin §6: valida o dígito verificador de um SSCC de 18 dígitos (LPN). */
export function validateSsccCheckDigit(sscc18: string): boolean {
  if (!/^[0-9]{18}$/.test(sscc18)) return false;
  const base17 = sscc18.slice(0, 17);
  const checkDigit = parseInt(sscc18[17], 10);
  return computeGs1CheckDigit(base17) === checkDigit;
}

/** RN-PER-010: element string do LPN — AI(00) + SSCC de 18 dígitos. */
export function buildLpnElementString(sscc18: string): string {
  if (!validateSsccCheckDigit(sscc18)) {
    throw new Error(`RN-PER-010: SSCC inválido (dígito verificador não confere): ${sscc18}`);
  }
  return `(00)${sscc18}`;
}

/**
 * RN-PER-010: GTIN-14 derivado de EAN-13 cadastrado — EAN-13 já É um
 * GTIN-14 válido com indicador de dígito 0 à esquerda (o dígito verificador
 * do EAN-13, calculado sobre os 12 primeiros dígitos, permanece
 * posicionalmente correto para o GTIN-14 resultante — nenhum recálculo
 * necessário).
 */
export function deriveGtin14FromEan13(ean13: string): string {
  if (!/^[0-9]{13}$/.test(ean13)) {
    throw new Error(`RN-PER-010: EAN-13 deve ter exatamente 13 dígitos, recebido: ${ean13}`);
  }
  return `0${ean13}`;
}

/** RN-PER-010: data no formato AI(17) — AAMMDD (2 dígitos de ano). */
export function formatExpirationAi17(expirationDate: Date | string): string {
  const date = typeof expirationDate === 'string' ? new Date(expirationDate) : expirationDate;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`RN-PER-010: expiration_date inválida para AI(17): ${expirationDate}`);
  }
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * RN-PER-010: etiqueta de lote interno — GS1-128 (01)GTIN (10)LOTE
 * (17)AAMMDD quando o produto tem EAN cadastrado; produto SEM EAN usa
 * código interno em Code 128 simples com prefixo `P|` + SKU (AI(02) —
 * "GTIN do conteúdo de uma unidade de expedição não indicada em (01)" —
 * é explicitamente PROIBIDO pelo documento para este caso, não uma opção
 * alternativa a implementar).
 */
export function buildBatchElementString(
  input: { ean13: string | null; sku: string; batchCode: string; expirationDate: Date | string | null }
): string {
  if (!input.ean13) {
    return `P|${input.sku}`;
  }
  const gtin14 = deriveGtin14FromEan13(input.ean13);
  if (!input.expirationDate) {
    throw new Error('RN-PER-010: expiration_date é obrigatória para etiqueta de lote interno de produto com EAN (AI 17)');
  }
  const ai17 = formatExpirationAi17(input.expirationDate);
  return `(01)${gtin14}(10)${input.batchCode}(17)${ai17}`;
}

/** RN-PER-010: endereço — Code128/QR usam o location.code literal (RN-DAD-011), sem AI. */
export function buildAddressContent(locationCode: string): string {
  return locationCode;
}
