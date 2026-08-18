// DOC-05 §4.2 — Seleção de Saldo. Lógica PURA (sem I/O), no mesmo espírito de
// putaway-filters.util.ts / putaway-ranking.util.ts (Sessão 4B): o service
// carrega os dados e chama isto. Assim as regras [INVIOLÁVEL] RN-EST-010,
// RN-EST-011 e RN-EST-012 são auditáveis e testáveis linha a linha, sem
// depender de fixture de banco para provar que um lote vencido é excluído ou
// que a cadeia de desempate está na ordem exata do documento.
//
// É este arquivo que decide QUAL saldo sai. Toda ordenação e todo filtro
// abaixo cita o §/ID que o origina; nenhum critério é inventado.

/** RG-006 / RN-EST-011 — catálogo FECHADO de políticas de giro (DOC-02 client_warehouse_settings_giro_policy_check). */
export const GIRO_POLICIES = ['FEFO', 'FIFO', 'LIFO', 'JIT'] as const;
export type GiroPolicy = (typeof GIRO_POLICIES)[number];

export function isGiroPolicy(value: string): value is GiroPolicy {
  return (GIRO_POLICIES as readonly string[]).includes(value);
}

/**
 * Um saldo candidato, já reduzido ao que as regras de ordenação precisam.
 * Montado por StockSelectionService a partir de wms.stock_balance + joins.
 */
export interface SelectionCandidate {
  stockBalanceId: string;
  productId: string;
  batchId: string | null;
  locationId: string;
  palletId: string | null;
  /** Parcela qty_available (RN-EST-010: a ÚNICA parcela elegível). */
  qtyAvailable: number;
  /** 'YYYY-MM-DD' ou null (produto/espécie sem validade). */
  expirationDate: string | null;
  /**
   * RN-EST-011 — "data de entrada do saldo (primeiro `stock_movement` de
   * entrada)". ISO 8601 UTC. Derivação documentada em
   * stock-selection.service.ts (loadCandidates) — é a base de FIFO/LIFO e
   * não pode ser ambígua.
   */
  entryDate: string;
  /** RN-EST-011 desempate: `PICKING` antes de `STORAGE`. */
  locationType: string;
  /** RN-EST-011 desempate final: menor `location.code`. */
  locationCode: string;
  /** RN-EST-011 (JIT): saldo em zona `CROSS_DOCKING` primeiro. */
  zoneType: string;
  /** DOC-02 RN-DAD-010 — política física do equipamento do endereço. */
  accessPolicy: string | null;
  /** Canal físico (physical-channel.util.ts) — usado só para LIFO_PHYSICAL. */
  channelKey: string;
}

// ─────────────────────────────────────────────────────────────────────────
// RN-EST-012 — Shelf Life Mínimo [INVIOLÁVEL]
// ─────────────────────────────────────────────────────────────────────────

/**
 * Converte um percentual decimal ("30", "30.00", "25.5") para CENTÉSIMOS de
 * ponto percentual, como INTEIRO exato — sem passar por ponto flutuante.
 *
 * Por que não `Number(x) * 100`: `min_shelf_life_pct` é NUMERIC(5,2) e chega
 * do pg como string; multiplicar em float pode produzir 3049.9999999999995
 * para "30.50" e mudar uma decisão de corte no limite exato. A comparação de
 * shelf life é [INVIOLÁVEL] — não pode depender de arredondamento binário.
 */
export function parsePercentToCentiPercent(value: string): number {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ''] = unsigned.split('.');
  const fracPart = (fracPartRaw + '00').slice(0, 2);
  const magnitude = Number(intPart || '0') * 100 + Number(fracPart);
  return negative ? -magnitude : magnitude;
}

/** Dias inteiros entre duas datas 'YYYY-MM-DD', em UTC (sem fuso, sem hora). */
export function wholeDaysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = Date.UTC(Number(fromIsoDate.slice(0, 4)), Number(fromIsoDate.slice(5, 7)) - 1, Number(fromIsoDate.slice(8, 10)));
  const to = Date.UTC(Number(toIsoDate.slice(0, 4)), Number(toIsoDate.slice(5, 7)) - 1, Number(toIsoDate.slice(8, 10)));
  return Math.round((to - from) / 86400000);
}

export interface ShelfLifeInput {
  /** Validade do lote ('YYYY-MM-DD'); null = lote sem validade. */
  expirationDate: string | null;
  /** product.shelf_life_days. */
  shelfLifeDays: number | null;
  /** Percentual mínimo JÁ RESOLVIDO (produto → cliente), como string decimal. */
  minShelfLifePct: string | null;
  /** Data de referência ('YYYY-MM-DD') — SEMPRE explícita, nunca now() implícito. */
  today: string;
}

/**
 * RN-EST-012 [INVIOLÁVEL] — "saldos cuja vida útil restante
 * `(expiration_date − hoje) / shelf_life_days × 100` for inferior ao
 * `min_shelf_life_pct` resolvido DEVEM ser excluídos dos candidatos".
 *
 * Comparação em ARITMÉTICA INTEIRA EXATA (sem divisão em ponto flutuante):
 *   restantes/shelfLifeDays*100 >= minPct
 *   ⟺ restantes * 100 * 100 >= (minPct em centésimos) * shelfLifeDays
 *
 * Exemplo normativo do §4.2 (teste de regressão permanente): shelf_life_days
 * 365, min 30%, hoje 2026-08-10 — validade 2026-11-10 → 92 dias:
 * 92*10000 = 920.000 < 3000*365 = 1.095.000 → EXCLUÍDO (25,2%);
 * validade 2027-01-10 → 153 dias: 1.530.000 >= 1.095.000 → ELEGÍVEL (41,9%).
 *
 * Quando o critério não é aplicável (sem validade, sem shelf_life_days ou sem
 * percentual mínimo configurado), o candidato NÃO é excluído — a regra só
 * exclui quando há os três insumos para calcular.
 */
export function meetsMinimumShelfLife(input: ShelfLifeInput): boolean {
  if (input.expirationDate === null || input.shelfLifeDays === null || input.minShelfLifePct === null) return true;
  if (input.shelfLifeDays <= 0) return true;

  const remainingDays = wholeDaysBetween(input.today, input.expirationDate);
  const minCentiPercent = parsePercentToCentiPercent(input.minShelfLifePct);

  // Lote já vencido (restantes <= 0) nunca atende a um mínimo positivo.
  return remainingDays * 100 * 100 >= minCentiPercent * input.shelfLifeDays;
}

// ─────────────────────────────────────────────────────────────────────────
// RN-EST-011 — Ordenação por política [INVIOLÁVEL]
//
// A cadeia de desempate de CADA política está transcrita da tabela do §4.2,
// na ORDEM EXATA. A ordem é parte da regra: mudar a posição de um desempate
// muda qual lote sai do armazém.
// ─────────────────────────────────────────────────────────────────────────

type Comparator = (a: SelectionCandidate, b: SelectionCandidate) => number;

/** Compara strings ISO ('YYYY-MM-DD' ou timestamp) — lexicográfico é cronológico e exato. */
function compareIsoAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `expiration_date` ausente: DOC-05 não define a posição de um saldo SEM
 * validade numa ordenação por validade. [LACUNA: posição de saldo sem
 * expiration_date em FEFO / no desempate de FIFO.] Adotado NULLS LAST — o
 * saldo com validade conhecida sai primeiro, que é o comportamento
 * conservador (não deixa vencer o que tem prazo) e o único coerente com o
 * propósito declarado do FEFO ("first expired, first out").
 */
function compareExpirationAsc(a: SelectionCandidate, b: SelectionCandidate): number {
  if (a.expirationDate === b.expirationDate) return 0;
  if (a.expirationDate === null) return 1;
  if (b.expirationDate === null) return -1;
  return compareIsoAsc(a.expirationDate, b.expirationDate);
}

const compareEntryAsc: Comparator = (a, b) => compareIsoAsc(a.entryDate, b.entryDate);
const compareEntryDesc: Comparator = (a, b) => -compareIsoAsc(a.entryDate, b.entryDate);

/** RN-EST-011: "endereço tipo `PICKING` antes de `STORAGE`". */
const comparePickingBeforeStorage: Comparator = (a, b) => {
  const rank = (c: SelectionCandidate) => (c.locationType === 'PICKING' ? 0 : 1);
  return rank(a) - rank(b);
};

/** RN-EST-011: desempate final "menor `location.code`". */
const compareLocationCodeAsc: Comparator = (a, b) => (a.locationCode < b.locationCode ? -1 : a.locationCode > b.locationCode ? 1 : 0);

/** RN-EST-011 (JIT): "saldo em zona `CROSS_DOCKING` primeiro". */
const compareCrossDockingFirst: Comparator = (a, b) => {
  const rank = (c: SelectionCandidate) => (c.zoneType === 'CROSS_DOCKING' ? 0 : 1);
  return rank(a) - rank(b);
};

/**
 * Cadeias EXATAS da tabela RN-EST-011 (§4.2). Cada array é lido em ordem: o
 * primeiro comparador que devolver != 0 decide.
 */
const POLICY_CHAINS: Record<GiroPolicy, Comparator[]> = {
  // "menor expiration_date | menor data de entrada do saldo; PICKING antes de STORAGE; menor location.code"
  FEFO: [compareExpirationAsc, compareEntryAsc, comparePickingBeforeStorage, compareLocationCodeAsc],
  // "menor data de entrada do saldo | menor expiration_date (se houver); PICKING antes de STORAGE; menor location.code"
  FIFO: [compareEntryAsc, compareExpirationAsc, comparePickingBeforeStorage, compareLocationCodeAsc],
  // "maior data de entrada do saldo | PICKING antes de STORAGE; menor location.code"
  LIFO: [compareEntryDesc, comparePickingBeforeStorage, compareLocationCodeAsc],
  // "saldo em zona CROSS_DOCKING primeiro; depois FIFO | como FIFO"
  JIT: [compareCrossDockingFirst, compareEntryAsc, compareExpirationAsc, comparePickingBeforeStorage, compareLocationCodeAsc],
};

/** RN-EST-011 [INVIOLÁVEL] — ordena os candidatos pela cadeia da política. Não muta a entrada. */
export function orderCandidatesByPolicy(candidates: SelectionCandidate[], policy: GiroPolicy): SelectionCandidate[] {
  const chain = POLICY_CHAINS[policy];
  return [...candidates].sort((a, b) => {
    for (const comparator of chain) {
      const verdict = comparator(a, b);
      if (verdict !== 0) return verdict;
    }
    return 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// RN-EST-011 (RN-DAD-010) — restrição de estrutura LIFO_PHYSICAL
// ─────────────────────────────────────────────────────────────────────────

/**
 * RN-EST-011: "Estruturas `LIFO_PHYSICAL` limitam candidatos ao palete
 * acessível (RN-DAD-010)". Num canal LIFO (drive-in/blocado) só o ÚLTIMO a
 * entrar está fisicamente alcançável — retirar outro exigiria remover os da
 * frente. Mantém, por canal LIFO_PHYSICAL, apenas os candidatos cuja data de
 * entrada é a MAIOR do canal.
 *
 * A 4B garante (filtro 6, RN-REC-040) que um canal LIFO_PHYSICAL só recebe
 * lote homogêneo quando o produto é FEFO/FIFO — por isso "o último que
 * entrou" não conflita com a política de giro nesses canais. Canais de outras
 * `access_policy` (RANDOM/FIFO_PHYSICAL/AUTOMATED) não têm restrição de
 * acesso e passam inteiros.
 *
 * [LACUNA: DOC-05 fala em "palete acessível", mas um canal pode conter saldo
 * SEM palete formal (`pallet_id` nulo). Adotado: a unidade de acessibilidade
 * é a data de entrada dentro do canal — com ou sem palete, só o mais recente
 * é alcançável, que é a leitura física direta de LIFO.]
 */
export function restrictToAccessiblePallets(candidates: SelectionCandidate[]): SelectionCandidate[] {
  const latestEntryByChannel = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.accessPolicy !== 'LIFO_PHYSICAL') continue;
    const current = latestEntryByChannel.get(candidate.channelKey);
    if (current === undefined || candidate.entryDate > current) {
      latestEntryByChannel.set(candidate.channelKey, candidate.entryDate);
    }
  }

  return candidates.filter((candidate) => {
    if (candidate.accessPolicy !== 'LIFO_PHYSICAL') return true;
    return candidate.entryDate === latestEntryByChannel.get(candidate.channelKey);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Atendimento parcial (§4.2, exemplo normativo)
// ─────────────────────────────────────────────────────────────────────────

export interface SelectionAllocation {
  candidate: SelectionCandidate;
  qtyAllocated: number;
}

export interface SelectionResult {
  allocations: SelectionAllocation[];
  /** Quantidade que os candidatos NÃO cobrem (0 = demanda integralmente atendida). */
  shortfall: number;
}

/**
 * RN-EST-011 (exemplo normativo §4.2) — "consome os candidatos em ordem até
 * completar a quantidade; o resultado é uma LISTA de alocações". Candidatos
 * DEVEM chegar já ordenados por orderCandidatesByPolicy().
 *
 * Exemplo normativo (teste de regressão permanente): demanda 150 sobre
 * S1(80, picking, val 2026-09-01), S2(100, storage, val 2026-09-01),
 * S3(200, picking, val 2026-10-15) em FEFO → 80 de S1 + 70 de S2; S3 intocado.
 */
export function allocateDemand(orderedCandidates: SelectionCandidate[], demandQty: number): SelectionResult {
  const allocations: SelectionAllocation[] = [];
  let remaining = demandQty;

  for (const candidate of orderedCandidates) {
    if (remaining <= 0) break;
    const qtyAllocated = Math.min(remaining, candidate.qtyAvailable);
    if (qtyAllocated <= 0) continue;
    allocations.push({ candidate, qtyAllocated });
    remaining -= qtyAllocated;
  }

  return { allocations, shortfall: remaining > 0 ? remaining : 0 };
}
