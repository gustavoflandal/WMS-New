// DOC-06 §4.4 RF-EXP-030 — sequenciamento da rota de picking.
//
// "zona -> rua serpenteando (ruas alternadas em ordem crescente/decrescente
// de módulo) -> módulo -> nível." Lógica PURA (sem I/O), mesmo espírito de
// putaway-filters.util.ts (4B) e outbound-flow.util.ts (6A): a regra vive
// isolada, auditável e testável linha a linha, sem depender de banco.
//
// [LACUNA: DOC-06 não define o critério de ordenação da ZONA em si (só a
// serpentina dentro da rua). Adotada ordem alfabética do código da zona —
// determinística e estável, mesmo padrão já usado para desempates sem regra
// explícita nesta base (ex.: FIFO_PHYSICAL como desempate técnico, DOC-05).]

export interface RouteCoordinates {
  zoneCode: string;
  aisle: string; // "Rua" (DOC-02: 2 caracteres)
  moduleCode: string; // 3 dígitos
  level: string; // 2 caracteres
}

/**
 * Calcula a chave de ordenação da rota para UM conjunto de coordenadas,
 * dado o mapa aisle -> ordinal (posição da rua entre as ruas distintas do
 * conjunto, em ordem alfabética) que determina a paridade da serpentina.
 *
 * Ruas de ordinal PAR percorrem módulo em ordem CRESCENTE; ímpar, DECRESCENTE
 * — a serpentina clássica de picking (evita o operador atravessar o
 * corredor duas vezes). A escolha de par=crescente é arbitrária (o documento
 * não fixa qual paridade começa crescente) mas CONSISTENTE, que é o que a
 * regra exige.
 */
export function routeSortKey(coord: RouteCoordinates, aisleOrdinal: number): [string, number, number, string] {
  const moduleNum = Number(coord.moduleCode);
  const isAscending = aisleOrdinal % 2 === 0;
  const moduleOrderValue = isAscending ? moduleNum : -moduleNum;
  return [coord.zoneCode, aisleOrdinal, moduleOrderValue, coord.level];
}

function compareKeys(a: [string, number, number, string], b: [string, number, number, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  if (a[3] !== b[3]) return a[3] < b[3] ? -1 : 1;
  return 0;
}

/**
 * Ordena itens quaisquer (T) pela rota de picking, dado como extrair as
 * coordenadas de cada um. Devolve os itens na ordem final — quem chama
 * atribui `route_sequence` pelo índice resultante (mesmo padrão de gap de
 * OperationFlowService: múltiplo de 10, espaço para reordenação futura).
 */
export function sortByPickingRoute<T>(items: T[], getCoordinates: (item: T) => RouteCoordinates): T[] {
  const distinctAisles = [...new Set(items.map((item) => getCoordinates(item).aisle))].sort();
  const aisleOrdinal = new Map<string, number>(distinctAisles.map((aisle, index) => [aisle, index]));

  return [...items].sort((a, b) => {
    const coordA = getCoordinates(a);
    const coordB = getCoordinates(b);
    const keyA = routeSortKey(coordA, aisleOrdinal.get(coordA.aisle)!);
    const keyB = routeSortKey(coordB, aisleOrdinal.get(coordB.aisle)!);
    return compareKeys(keyA, keyB);
  });
}

const ROUTE_SEQUENCE_GAP = 10;

/** Sequência final (múltiplo de 10) na ordem devolvida por sortByPickingRoute. */
export function assignRouteSequence<T>(sortedItems: T[]): Array<{ item: T; routeSequence: number }> {
  return sortedItems.map((item, index) => ({ item, routeSequence: (index + 1) * ROUTE_SEQUENCE_GAP }));
}
