// DOC-17 RF-TEL-034 — cenário Gherkin §10 "Dupla digitação em contagem".
import { describe, it, expect } from 'vitest';
import { compareDoubleEntry, requiresDoubleEntry } from '../double-entry.util.js';

describe('compareDoubleEntry (RF-TEL-034)', () => {
  it('Cenário §10: 95 na primeira passagem e 96 na segunda — divergência apontada antes de confirmar', () => {
    const outcome = compareDoubleEntry([{ lineNumber: 1, firstPass: 95, secondPass: 96 }]);
    expect(outcome.matches).toBe(false);
    expect(outcome.divergences).toEqual([{ lineNumber: 1, firstPass: 95, secondPass: 96 }]);
  });

  it('passagens idênticas em todas as linhas liberam a confirmação', () => {
    const outcome = compareDoubleEntry([
      { lineNumber: 1, firstPass: 95, secondPass: 95 },
      { lineNumber: 2, firstPass: 0, secondPass: 0 },
      { lineNumber: 3, firstPass: 1200, secondPass: 1200 },
    ]);
    expect(outcome.matches).toBe(true);
    expect(outcome.divergences).toEqual([]);
  });

  it('"nada gravado até a resolução": UMA linha divergente reprova o lote inteiro', () => {
    const outcome = compareDoubleEntry([
      { lineNumber: 1, firstPass: 10, secondPass: 10 },
      { lineNumber: 2, firstPass: 20, secondPass: 21 },
      { lineNumber: 3, firstPass: 30, secondPass: 30 },
    ]);
    expect(outcome.matches).toBe(false);
    // Reporta só a linha problemática, mas não libera as que bateram.
    expect(outcome.divergences).toHaveLength(1);
    expect(outcome.divergences[0].lineNumber).toBe(2);
  });

  it('lista vazia não é divergência (formulário sem linha de quantidade)', () => {
    expect(compareDoubleEntry([])).toEqual({ matches: true, divergences: [] });
  });

  it('zero digitado nas duas passagens bate — "endereço vazio" é resposta válida (RF-TEL-022)', () => {
    expect(compareDoubleEntry([{ lineNumber: 1, firstPass: 0, secondPass: 0 }]).matches).toBe(true);
  });

  it('distingue 0 de não-preenchido: 0 vs 5 é divergência, não igualdade por coerção', () => {
    expect(compareDoubleEntry([{ lineNumber: 1, firstPass: 0, secondPass: 5 }]).matches).toBe(false);
  });
});

describe('requiresDoubleEntry (RF-TEL-034)', () => {
  it('exigida para CONTAGEM (padrão true para inventário)', () => {
    expect(requiresDoubleEntry('CONTAGEM', { CONTAGEM: true, CONFERENCIA: false })).toBe(true);
  });

  it('não exigida para CONFERENCIA quando o parâmetro está desligado', () => {
    expect(requiresDoubleEntry('CONFERENCIA', { CONTAGEM: true, CONFERENCIA: false })).toBe(false);
  });

  it('tipo fora do mapa não exige (ex.: PUTAWAY — RF-TEL-034 só cita contagem e conferência)', () => {
    expect(requiresDoubleEntry('PUTAWAY', { CONTAGEM: true, CONFERENCIA: false })).toBe(false);
  });

  it('parâmetro ausente não exige', () => {
    expect(requiresDoubleEntry('CONTAGEM', null)).toBe(false);
  });
});
