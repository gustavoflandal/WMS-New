// DOC-17 RF-TEL-020 — código de barras Code 128 do número do formulário.
// Vetor de referência "DCODE" verificado externamente (checksum recalculado
// manualmente: 104*1 + 36*1 + 35*2 + 47*3 + 36*4 + 37*5 = 680; 680 mod 103 = 62)
// — travado como regressão permanente (mesmo padrão do CLAUDE.md §5 para
// exemplos normativos): qualquer mudança na tabela ou no checksum que altere
// este resultado é o algoritmo quebrado, não o teste.
import { describe, it, expect } from 'vitest';
import { encodeCode128B, code128ToBars } from '../code128.util.js';

describe('encodeCode128B', () => {
  it('codifica "DCODE" com o vetor de referência conhecido (START B, D,C,O,D,E, checksum 62, STOP)', () => {
    const symbols = encodeCode128B('DCODE');
    expect(symbols.map((s) => s.value)).toEqual([104, 36, 35, 47, 36, 37, 62, 106]);
    expect(symbols.map((s) => s.pattern)).toEqual(['211214', '112313', '131321', '133121', '112313', '132113', '431111', '2331112']);
  });

  it('sempre começa em START B (104) e termina em STOP (106)', () => {
    const symbols = encodeCode128B('FRM-000123-00000001');
    expect(symbols[0].value).toBe(104);
    expect(symbols.at(-1)!.value).toBe(106);
  });

  it('o penúltimo símbolo (checksum) bate com o recálculo manual mod 103', () => {
    const text = 'FRM-000123-00000001';
    const symbols = encodeCode128B(text);
    const dataValues = [...text].map((ch) => ch.charCodeAt(0) - 32);
    let expected = 104;
    dataValues.forEach((v, i) => (expected += v * (i + 1)));
    expected %= 103;
    expect(symbols.at(-2)!.value).toBe(expected);
  });

  it('cada símbolo tem um padrão de largura válido de 6 dígitos (7 para o STOP) somando 11 (13 no STOP)', () => {
    const symbols = encodeCode128B('AB-12');
    for (const s of symbols.slice(0, -1)) {
      expect(s.pattern).toHaveLength(6);
      expect([...s.pattern].reduce((a, d) => a + Number(d), 0)).toBe(11);
    }
    const stop = symbols.at(-1)!;
    expect(stop.pattern).toHaveLength(7);
    expect([...stop.pattern].reduce((a, d) => a + Number(d), 0)).toBe(13);
  });

  it('rejeita texto vazio', () => {
    expect(() => encodeCode128B('')).toThrow();
  });

  it('rejeita caractere fora do subconjunto B (ASCII 32-126)', () => {
    const belowRange = 'FRM' + String.fromCharCode(1);
    const aboveRange = 'FRM' + String.fromCharCode(127);
    expect(() => encodeCode128B(belowRange)).toThrow();
    expect(() => encodeCode128B(aboveRange)).toThrow();
  });
});

describe('code128ToBars', () => {
  it('gera só as barras (índices pares do padrão), com posições cumulativas em módulos', () => {
    const symbols = encodeCode128B('DCODE');
    const { bars, totalModules } = code128ToBars(symbols);
    // START B "211214": barra(2) espaço(1) barra(1) espaço(2) barra(1) espaço(4)
    expect(bars[0]).toEqual({ x: 0, width: 2 });
    expect(bars[1]).toEqual({ x: 3, width: 1 });
    expect(bars[2]).toEqual({ x: 6, width: 1 });
    // DCODE = START B + D,C,O,D,E + checksum = 7 símbolos de 11 módulos, mais o STOP de 13 = 7*11 + 13
    expect(totalModules).toBe(7 * 11 + 13);
  });

  it('nunca gera barras sobrepostas (cada barra começa onde a anterior termina ou depois)', () => {
    const { bars } = code128ToBars(encodeCode128B('FRM-000123-00000001'));
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].x).toBeGreaterThanOrEqual(bars[i - 1].x + bars[i - 1].width);
    }
  });
});
