// DOC-04 RN-REC-040 Fase 2 — ranqueamento em cascata (lógica pura).
// O EXEMPLO NORMATIVO do §4.5 é teste de regressão permanente: se falhar, o
// algoritmo está errado — o valor esperado NÃO deve ser ajustado.
import { rankPutawayLocations, splitSuggestionAndAlternatives, PutawayCriterion, RankableLocation } from '../putaway-ranking.util.js';

function loc(overrides: Partial<RankableLocation> & { code: string }): RankableLocation {
  return {
    locationId: `id-${overrides.code}`,
    isPreferredZone: false,
    hasSameProductBatch: false,
    abcClass: null,
    level: '00',
    dockDistanceM: null,
    zoneOccupancyRatio: 0,
    ...overrides,
  };
}

describe('RN-REC-040 Fase 2 — ranqueamento configurável em cascata', () => {
  it('EXEMPLO NORMATIVO §4.5: criterios [ZONA_PREFERENCIAL_PRODUTO, CLASSE_ABC, MENOR_NIVEL] -> E2, E1, E3 (sugestao E2)', () => {
    // "endereços aprovados E1 (zona pref., classe B, nível 03), E2 (zona
    // pref., classe A, nível 04), E3 (outra zona, classe A, nível 00)"
    const e1 = loc({ code: 'E1', isPreferredZone: true, abcClass: 'B', level: '03' });
    const e2 = loc({ code: 'E2', isPreferredZone: true, abcClass: 'A', level: '04' });
    const e3 = loc({ code: 'E3', isPreferredZone: false, abcClass: 'A', level: '00' });

    const criteria: PutawayCriterion[] = ['ZONA_PREFERENCIAL_PRODUTO', 'CLASSE_ABC', 'MENOR_NIVEL'];
    // Entrada deliberadamente fora de ordem: o resultado não pode depender
    // da ordem de chegada dos candidatos.
    const ranked = rankPutawayLocations([e3, e1, e2], criteria);

    expect(ranked.map((r) => r.code)).toEqual(['E2', 'E1', 'E3']);

    const { suggestion, alternatives } = splitSuggestionAndAlternatives(ranked);
    expect(suggestion?.code).toBe('E2');
    expect(alternatives.map((a) => a.code)).toEqual(['E1', 'E3']);
  });

  it('cascata: o criterio seguinte SO desempata o anterior (nao e soma de pesos)', () => {
    // A vence no 1º critério e perde em TODOS os demais. Numa soma ponderada
    // B poderia vencer; em cascata, A vence sempre.
    const a = loc({ code: 'AA', isPreferredZone: true, abcClass: 'C', level: '99', dockDistanceM: 999, zoneOccupancyRatio: 0 });
    const b = loc({ code: 'BB', isPreferredZone: false, abcClass: 'A', level: '00', dockDistanceM: 1, zoneOccupancyRatio: 1 });

    const ranked = rankPutawayLocations([b, a], [
      'ZONA_PREFERENCIAL_PRODUTO',
      'CLASSE_ABC',
      'MENOR_NIVEL',
      'MENOR_DISTANCIA_DOCA',
      'MAIOR_OCUPACAO_ZONA',
    ]);

    expect(ranked.map((r) => r.code)).toEqual(['AA', 'BB']);
  });

  it('empate final: menor location.code, mesmo com lista de criterios vazia', () => {
    const ranked = rankPutawayLocations([loc({ code: 'C-02' }), loc({ code: 'A-01' }), loc({ code: 'B-01' })], []);
    expect(ranked.map((r) => r.code)).toEqual(['A-01', 'B-01', 'C-02']);
  });

  it('CONSOLIDACAO_PRODUTO_LOTE: endereco com o mesmo produto+lote vem primeiro', () => {
    const semSaldo = loc({ code: 'Z-01' });
    const comSaldo = loc({ code: 'Z-99', hasSameProductBatch: true });
    const ranked = rankPutawayLocations([semSaldo, comSaldo], ['CONSOLIDACAO_PRODUTO_LOTE']);
    expect(ranked.map((r) => r.code)).toEqual(['Z-99', 'Z-01']);
  });

  it('MENOR_DISTANCIA_DOCA: endereco sem entrada na matriz vai para o FIM, nao para o comeco', () => {
    const semMatriz = loc({ code: 'A-00', dockDistanceM: null });
    const longe = loc({ code: 'B-00', dockDistanceM: 500 });
    const perto = loc({ code: 'C-00', dockDistanceM: 10 });
    const ranked = rankPutawayLocations([semMatriz, longe, perto], ['MENOR_DISTANCIA_DOCA']);
    expect(ranked.map((r) => r.code)).toEqual(['C-00', 'B-00', 'A-00']);
  });

  it('MAIOR_OCUPACAO_ZONA: zona mais ocupada primeiro (completar zonas)', () => {
    const vazia = loc({ code: 'A-00', zoneOccupancyRatio: 0.1 });
    const cheia = loc({ code: 'B-00', zoneOccupancyRatio: 0.9 });
    const ranked = rankPutawayLocations([vazia, cheia], ['MAIOR_OCUPACAO_ZONA']);
    expect(ranked.map((r) => r.code)).toEqual(['B-00', 'A-00']);
  });

  it('CLASSE_ABC: endereco SEM classe fica depois de qualquer classificado', () => {
    const semClasse = loc({ code: 'A-00', abcClass: null });
    const classeC = loc({ code: 'Z-99', abcClass: 'C' });
    const ranked = rankPutawayLocations([semClasse, classeC], ['CLASSE_ABC']);
    expect(ranked.map((r) => r.code)).toEqual(['Z-99', 'A-00']);
  });

  it('sugestao + 4 alternativas no maximo (RN-REC-040), mesmo com 10 aprovados', () => {
    const many = Array.from({ length: 10 }, (_, i) => loc({ code: `L-${String(i).padStart(2, '0')}` }));
    const { suggestion, alternatives } = splitSuggestionAndAlternatives(rankPutawayLocations(many, []));
    expect(suggestion?.code).toBe('L-00');
    expect(alternatives).toHaveLength(4);
    expect(alternatives.map((a) => a.code)).toEqual(['L-01', 'L-02', 'L-03', 'L-04']);
  });

  it('lista vazia de candidatos: sem sugestao, sem alternativas', () => {
    const { suggestion, alternatives } = splitSuggestionAndAlternatives(rankPutawayLocations([], ['CLASSE_ABC']));
    expect(suggestion).toBeNull();
    expect(alternatives).toEqual([]);
  });
});
