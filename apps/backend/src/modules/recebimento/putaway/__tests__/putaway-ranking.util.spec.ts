// DOC-04 RN-REC-040 Fase 2 — ranqueamento em cascata (lógica pura).
// O EXEMPLO NORMATIVO do §4.5 é teste de regressão permanente: se falhar, o
// algoritmo está errado — o valor esperado NÃO deve ser ajustado.
import {
  appliesPhysicalRotationTieBreak,
  rankPutawayLocations,
  splitSuggestionAndAlternatives,
  PutawayCriterion,
  RankableLocation,
} from '../putaway-ranking.util.js';

function loc(overrides: Partial<RankableLocation> & { code: string }): RankableLocation {
  return {
    locationId: `id-${overrides.code}`,
    isPreferredZone: false,
    hasSameProductBatch: false,
    abcClass: null,
    level: '00',
    dockDistanceM: null,
    zoneOccupancyRatio: 0,
    accessPolicy: null,
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

// RN-DAD-010, metade preferencial — emenda aprovada ao relatório da 4B.
// Desempate TÉCNICO: depois dos critérios configurados, antes do code.
describe('RN-DAD-010 — desempate por rotação física (FIFO_PHYSICAL > RANDOM > LIFO_PHYSICAL)', () => {
  const TIE_BREAK = { applyPhysicalRotationTieBreak: true };

  it('aplica-se a FEFO e FIFO; NAO se aplica a LIFO nem JIT', () => {
    expect(appliesPhysicalRotationTieBreak(['FEFO'])).toBe(true);
    expect(appliesPhysicalRotationTieBreak(['FIFO'])).toBe(true);
    expect(appliesPhysicalRotationTieBreak(['LIFO'])).toBe(false);
    expect(appliesPhysicalRotationTieBreak(['JIT'])).toBe(false);
    // Palete misto com ao menos um produto de rotação ordenada: aplica-se
    // (mesmo critério do filtro 6).
    expect(appliesPhysicalRotationTieBreak(['LIFO', 'FEFO'])).toBe(true);
  });

  it('produto FEFO: flowrack (FIFO_PHYSICAL) vence porta-paletes (RANDOM) mesmo com code MAIOR', () => {
    // Códigos deliberadamente invertidos: sem o desempate técnico, 'A-01'
    // (RANDOM) venceria pelo desempate final de código.
    const portaPaletes = loc({ code: 'A-01', accessPolicy: 'RANDOM' });
    const flowrack = loc({ code: 'Z-99', accessPolicy: 'FIFO_PHYSICAL' });

    const ranked = rankPutawayLocations([portaPaletes, flowrack], [], TIE_BREAK);
    expect(ranked.map((r) => r.code)).toEqual(['Z-99', 'A-01']);
  });

  it('ordem completa FIFO_PHYSICAL > RANDOM > LIFO_PHYSICAL', () => {
    const lifo = loc({ code: 'A-01', accessPolicy: 'LIFO_PHYSICAL' });
    const random = loc({ code: 'B-01', accessPolicy: 'RANDOM' });
    const fifo = loc({ code: 'C-01', accessPolicy: 'FIFO_PHYSICAL' });

    const ranked = rankPutawayLocations([lifo, random, fifo], [], TIE_BREAK);
    expect(ranked.map((r) => r.accessPolicy)).toEqual(['FIFO_PHYSICAL', 'RANDOM', 'LIFO_PHYSICAL']);
  });

  it('produto LIFO/JIT: desempate NAO se aplica, vale o menor code', () => {
    const portaPaletes = loc({ code: 'A-01', accessPolicy: 'RANDOM' });
    const flowrack = loc({ code: 'Z-99', accessPolicy: 'FIFO_PHYSICAL' });

    const ranked = rankPutawayLocations([flowrack, portaPaletes], [], { applyPhysicalRotationTieBreak: false });
    expect(ranked.map((r) => r.code)).toEqual(['A-01', 'Z-99']);
  });

  it('NAO sobrepoe criterio configurado: LIFO_PHYSICAL em zona preferencial vence FIFO_PHYSICAL fora dela', () => {
    const preferencialRuim = loc({ code: 'A-01', accessPolicy: 'LIFO_PHYSICAL', isPreferredZone: true });
    const naoPreferencialBom = loc({ code: 'B-01', accessPolicy: 'FIFO_PHYSICAL', isPreferredZone: false });

    const ranked = rankPutawayLocations([naoPreferencialBom, preferencialRuim], ['ZONA_PREFERENCIAL_PRODUTO'], TIE_BREAK);
    // O critério configurado decide; o desempate técnico nem chega a ser consultado.
    expect(ranked.map((r) => r.code)).toEqual(['A-01', 'B-01']);
  });

  // Decisão definitiva de 2026-08-17: sem restrição física de rotação
  // (RN-DAD-010), não há preferência. AUTOMATED resolve a rotação
  // internamente; piso/blocado tem acesso livre por definição. Ambos
  // empatam com RANDOM e caem no desempate final por código.
  it('AUTOMATED e endereco sem equipamento tem rank NEUTRO: empatam com RANDOM e caem no code', () => {
    const automated = loc({ code: 'B-01', accessPolicy: 'AUTOMATED' });
    const random = loc({ code: 'A-01', accessPolicy: 'RANDOM' });
    const semEquipamento = loc({ code: 'C-01', accessPolicy: null });

    const ranked = rankPutawayLocations([automated, semEquipamento, random], [], TIE_BREAK);
    expect(ranked.map((r) => r.code)).toEqual(['A-01', 'B-01', 'C-01']);
  });

  it('rank NEUTRO nao vence FIFO_PHYSICAL nem perde para LIFO_PHYSICAL', () => {
    // A neutralidade é posicional: fica exatamente onde RANDOM fica.
    const fifo = loc({ code: 'Z-01', accessPolicy: 'FIFO_PHYSICAL' });
    const automated = loc({ code: 'A-01', accessPolicy: 'AUTOMATED' });
    const lifo = loc({ code: 'B-01', accessPolicy: 'LIFO_PHYSICAL' });
    const semEquipamento = loc({ code: 'C-01', accessPolicy: null });

    const ranked = rankPutawayLocations([lifo, semEquipamento, fifo, automated], [], TIE_BREAK);
    expect(ranked.map((r) => r.code)).toEqual(['Z-01', 'A-01', 'C-01', 'B-01']);
  });

  it('exemplo normativo §4.5 permanece intacto com o desempate ligado', () => {
    // Regressão: a emenda não pode alterar o resultado do exemplo normativo.
    const e1 = loc({ code: 'E1', isPreferredZone: true, abcClass: 'B', level: '03', accessPolicy: 'RANDOM' });
    const e2 = loc({ code: 'E2', isPreferredZone: true, abcClass: 'A', level: '04', accessPolicy: 'LIFO_PHYSICAL' });
    const e3 = loc({ code: 'E3', isPreferredZone: false, abcClass: 'A', level: '00', accessPolicy: 'FIFO_PHYSICAL' });

    const criteria: PutawayCriterion[] = ['ZONA_PREFERENCIAL_PRODUTO', 'CLASSE_ABC', 'MENOR_NIVEL'];
    const ranked = rankPutawayLocations([e3, e1, e2], criteria, TIE_BREAK);
    expect(ranked.map((r) => r.code)).toEqual(['E2', 'E1', 'E3']);
  });
});
