// DOC-17 RF-TEL-020 — "código de barras Code 128 do número" (obrigatório no
// Formulário de Campo, subconjunto B: dígitos, letras maiúsculas e hífen do
// número FRM-<ARMAZÉM>-<SEQ8> cabem todos em ASCII 32-127).
//
// Tabela de larguras (símbolos 0-106, START B = 104, STOP = 106) e o
// algoritmo de checksum (mod 103) vêm da especificação pública do Code 128
// (mesma tabela usada por qualquer gerador — não é um algoritmo do projeto).
// Cada padrão de 6 dígitos descreve 3 barras + 3 espaços alternados,
// começando em barra; o STOP tem 7 dígitos (4 barras + 3 espaços).
const PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;
const MIN_CHAR_CODE = 32;
const MAX_CHAR_CODE = 127;

export interface Code128Symbol {
  value: number;
  pattern: string;
}

/**
 * Codifica `text` em Code 128 subconjunto B: START B, um símbolo por
 * caractere (value = charCode - 32), dígito verificador (mod 103) e STOP.
 * Lança se algum caractere estiver fora de ASCII 32-127 (fora do
 * subconjunto B) — RF-TEL-020 não precisa de A/C nem de FNC.
 */
export function encodeCode128B(text: string): Code128Symbol[] {
  if (text.length === 0) throw new Error('Code128: texto vazio');

  const dataValues: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < MIN_CHAR_CODE || code >= MAX_CHAR_CODE) {
      throw new Error(`Code128 subset B: caractere fora do intervalo suportado (32-126): '${ch}' (${code})`);
    }
    dataValues.push(code - MIN_CHAR_CODE);
  }

  let checksum = START_B;
  dataValues.forEach((value, i) => {
    checksum += value * (i + 1);
  });
  checksum %= 103;

  const values = [START_B, ...dataValues, checksum, STOP];
  return values.map((value) => ({ value, pattern: PATTERNS[value] }));
}

export interface Code128Bar {
  /** Posição inicial da barra, em unidades de módulo (multiplicar pela largura do módulo em pt/mm). */
  x: number;
  /** Largura da barra, em unidades de módulo. */
  width: number;
}

/**
 * Expande os símbolos em retângulos de barra (só as barras — os espaços são
 * só avanço de posição, nada a desenhar). Cada padrão alterna barra/espaço
 * começando em barra.
 */
export function code128ToBars(symbols: Code128Symbol[]): { bars: Code128Bar[]; totalModules: number } {
  const bars: Code128Bar[] = [];
  let x = 0;
  for (const symbol of symbols) {
    let isBar = true;
    for (const digit of symbol.pattern) {
      const width = Number(digit);
      if (isBar) bars.push({ x, width });
      x += width;
      isBar = !isBar;
    }
  }
  return { bars, totalModules: x };
}
