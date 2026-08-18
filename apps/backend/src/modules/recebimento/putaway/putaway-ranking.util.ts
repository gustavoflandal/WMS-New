// DOC-04 RN-REC-040 Fase 2 — Ranqueamento configurável.
//
// Lógica PURA e determinística (sem I/O): recebe candidatos já aprovados na
// Fase 1, com todos os atributos pré-calculados, e devolve a ordem final.
// Separada do service justamente para que o exemplo normativo do §4.5 possa
// ser exercitado como teste de regressão permanente sem depender de banco.
//
// Semântica EXATA do documento, não reinterpretada:
// "O motor ordena os aprovados aplicando os critérios em sequência (critério
// seguinte só desempata o anterior)" — ordenação lexicográfica em CASCATA,
// NÃO soma ponderada de pesos. "Empate final: menor `location.code`."

/** Catálogo FECHADO de critérios (RN-REC-040 Fase 2) — nenhum outro valor é aceito. */
export const PUTAWAY_CRITERIA = [
  'ZONA_PREFERENCIAL_PRODUTO',
  'CONSOLIDACAO_PRODUTO_LOTE',
  'CLASSE_ABC',
  'MENOR_NIVEL',
  'MENOR_DISTANCIA_DOCA',
  'MAIOR_OCUPACAO_ZONA',
] as const;

export type PutawayCriterion = (typeof PUTAWAY_CRITERIA)[number];

export function isPutawayCriterion(value: string): value is PutawayCriterion {
  return (PUTAWAY_CRITERIA as readonly string[]).includes(value);
}

export interface RankableLocation {
  locationId: string;
  /** RN-DAD-011 — usado no desempate final. */
  code: string;
  /** ZONA_PREFERENCIAL_PRODUTO: zona do endereço ∈ product_warehouse_parameter.putaway_zone_preference. */
  isPreferredZone: boolean;
  /** CONSOLIDACAO_PRODUTO_LOTE: "proximidade de saldo igual" — endereço já tem o MESMO produto+lote. */
  hasSameProductBatch: boolean;
  /** CLASSE_ABC: location.abc_class. */
  abcClass: string | null;
  /** MENOR_NIVEL: location.level (2 chars, '00' = piso). */
  level: string;
  /** MENOR_DISTANCIA_DOCA: metros pela matriz REC.MAPA_DISTANCIA_DOCA_ZONA (RF-REC-003); null = sem entrada na matriz. */
  dockDistanceM: number | null;
  /** MAIOR_OCUPACAO_ZONA: fração 0..1 de ocupação da zona ("completar zonas"). */
  zoneOccupancyRatio: number;
  /** storage_equipment.access_policy (DOC-02 §5.2, coluna gerada) — desempate técnico de RN-DAD-010. */
  accessPolicy: string | null;
}

// RN-DAD-010, metade PREFERENCIAL ("FIFO_PHYSICAL preferencial para
// FEFO/FIFO") — emenda aprovada ao relatório da Sessão 4B (2026-08-17).
//
// NÃO é um 7º critério: o catálogo da Fase 2 permanece FECHADO em 6. É um
// DESEMPATE TÉCNICO, aplicado DEPOIS de todos os critérios configurados em
// REC.CRITERIOS_PUTAWAY e ANTES do desempate final por `location.code`
// (RN-REC-040). Portanto nunca altera a decisão de um critério configurado —
// só decide entre endereços que a configuração do armazém deixou empatados.
//
// Ordem: FIFO_PHYSICAL > RANDOM > LIFO_PHYSICAL (access_policy, DOC-02 §5.2).
// Só se aplica a produtos de política FEFO ou FIFO; LIFO/JIT não usam este
// desempate (a estrutura física não favorece nem prejudica sua rotação).
//
// RANK NEUTRO — DECISÃO DEFINITIVA (aprovada em 2026-08-17), não provisória.
// A emenda nomeia três políticas; as duas restantes recebem o rank NEUTRO de
// RANDOM pelo princípio que dá origem ao desempate:
//
//   Este desempate existe para refletir RESTRIÇÃO FÍSICA DE ROTAÇÃO
//   (DOC-02 RN-DAD-010). Onde não há restrição, não há preferência.
//
//   · `AUTOMATED` (CARROSSEL): o equipamento resolve a rotação
//     internamente e não impõe ao motor nenhuma ordem física de retirada.
//   · `storage_equipment_id` NULL (piso / blocado demarcado, migration
//     0008): acesso livre por definição.
//
// Não é ausência de decisão nem lacuna a preencher depois: é a aplicação
// direta do princípio. Se um dia o blocado passar a ser tratado como LIFO
// físico (empilhamento real), isso será EMENDA AO DOC-02 — que mudará o
// `access_policy` derivado do tipo de equipamento — e não uma mudança neste
// motor, que apenas obedece ao valor da coluna.
const ROTATION_FRIENDLINESS: Record<string, number> = {
  FIFO_PHYSICAL: 0,
  RANDOM: 1,
  AUTOMATED: 1,
  LIFO_PHYSICAL: 2,
};

const NEUTRAL_ROTATION_RANK = 1;

function rotationRank(accessPolicy: string | null): number {
  if (accessPolicy === null) return NEUTRAL_ROTATION_RANK;
  return ROTATION_FRIENDLINESS[accessPolicy] ?? NEUTRAL_ROTATION_RANK;
}

/** RG-006: só FEFO/FIFO têm rotação ordenada a preservar. Mesmo critério do filtro 6. */
export function appliesPhysicalRotationTieBreak(giroPolicies: string[]): boolean {
  return giroPolicies.some((g) => g === 'FEFO' || g === 'FIFO');
}

// CLASSE_ABC — "abc_class do endereço × giro". A antes de B antes de C.
// [LACUNA: DOC-04 não define o mapeamento explícito entre a política de giro
// do produto e a classe do endereço (só cita "abc_class do endereço × giro").
// Implementada a única ordenação que o próprio exemplo normativo do §4.5
// comprova — E2 (classe A) vence E1 (classe B) com os demais critérios
// empatados. Endereço SEM classe fica por último (não é melhor que um
// classificado).]
const ABC_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };

function abcRank(abcClass: string | null): number {
  if (abcClass === null) return Number.POSITIVE_INFINITY;
  return ABC_ORDER[abcClass] ?? Number.POSITIVE_INFINITY;
}

/** Compara UM critério. <0 = `a` primeiro; >0 = `b` primeiro; 0 = empate (passa ao próximo critério). */
function compareByCriterion(criterion: PutawayCriterion, a: RankableLocation, b: RankableLocation): number {
  switch (criterion) {
    case 'ZONA_PREFERENCIAL_PRODUTO':
      // Preferencial primeiro.
      return Number(b.isPreferredZone) - Number(a.isPreferredZone);
    case 'CONSOLIDACAO_PRODUTO_LOTE':
      // Consolidar com saldo igual primeiro.
      return Number(b.hasSameProductBatch) - Number(a.hasSameProductBatch);
    case 'CLASSE_ABC':
      return abcRank(a.abcClass) - abcRank(b.abcClass);
    case 'MENOR_NIVEL':
      // level é TEXT de 2 chars zero-padded ('00'..'99') — comparação
      // lexicográfica é equivalente à numérica nesse formato.
      return a.level.localeCompare(b.level);
    case 'MENOR_DISTANCIA_DOCA': {
      // Sem entrada na matriz = distância desconhecida: vai para o fim, não
      // para o começo (não pode "ganhar" de um endereço com distância real).
      const da = a.dockDistanceM ?? Number.POSITIVE_INFINITY;
      const db = b.dockDistanceM ?? Number.POSITIVE_INFINITY;
      return da - db;
    }
    case 'MAIOR_OCUPACAO_ZONA':
      // "completar zonas" — maior ocupação primeiro.
      return b.zoneOccupancyRatio - a.zoneOccupancyRatio;
  }
}

/**
 * RN-REC-040 Fase 2 — ordena os endereços APROVADOS na Fase 1 aplicando os
 * critérios em cascata. NÃO filtra nada: filtrar é exclusividade da Fase 1.
 *
 * `criteria` vem de REC.CRITERIOS_PUTAWAY (lista ordenada por armazém). Lista
 * vazia é válida: cai direto nos desempates.
 *
 * Ordem de decisão completa:
 *   1. critérios configurados, em cascata (catálogo FECHADO de 6);
 *   2. desempate técnico de rotação física (RN-DAD-010), quando o produto é
 *      FEFO/FIFO — ver ROTATION_FRIENDLINESS;
 *   3. desempate final: menor `location.code` (RN-REC-040, literal).
 */
export function rankPutawayLocations(
  candidates: RankableLocation[],
  criteria: PutawayCriterion[],
  options: { applyPhysicalRotationTieBreak?: boolean } = {}
): RankableLocation[] {
  return [...candidates].sort((a, b) => {
    for (const criterion of criteria) {
      const result = compareByCriterion(criterion, a, b);
      if (result !== 0) return result;
    }

    // RN-DAD-010 (metade preferencial): só desempata o que os critérios
    // configurados deixaram empatado — nunca sobrepõe uma decisão deles.
    if (options.applyPhysicalRotationTieBreak) {
      const rotation = rotationRank(a.accessPolicy) - rotationRank(b.accessPolicy);
      if (rotation !== 0) return rotation;
    }

    // "Empate final: menor location.code" (RN-REC-040 Fase 2, literal).
    return a.code.localeCompare(b.code);
  });
}

/**
 * RN-REC-040: "O sistema DEVE apresentar o 1º colocado como sugestão e os 4
 * seguintes como alternativas."
 */
export function splitSuggestionAndAlternatives<T>(ranked: T[]): { suggestion: T | null; alternatives: T[] } {
  return {
    suggestion: ranked[0] ?? null,
    alternatives: ranked.slice(1, 5),
  };
}
