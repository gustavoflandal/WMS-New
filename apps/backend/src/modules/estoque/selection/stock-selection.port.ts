// DOC-05 §4.2 — CONTRATO da Seleção de Saldo (RN-EST-010/011/012/013).
//
// Porta explícita, com implementação única em stock-selection.service.ts.
// Existe para que os TRÊS consumidores previstos da seleção falem a mesma
// língua, em vez de cada um montar sua própria chamada:
//   1. Reposição/kanban (RF-EST-041/042, Sessão 5A — já consome);
//   2. Picking de pedidos (DOC-06 — consumirá);
//   3. Inventário/ajuste (DOC-05 §4.7, Sessão 5C — consumirá).
//
// O contrato é tipado nos dois sentidos: a ENTRADA obriga o consumidor a
// declarar a finalidade da demanda (que decide se RN-EST-012 se aplica) e a
// SAÍDA é sempre uma LISTA de alocações (§4.2: atendimento parcial consome
// vários saldos), nunca um saldo único.

import { SelectionAllocation, GiroPolicy } from './stock-selection.util.js';

/**
 * Finalidade da demanda — catálogo FECHADO.
 *
 * RN-EST-012 [INVIOLÁVEL] aplica o Shelf Life Mínimo apenas "QUANDO a demanda
 * for de expedição a cliente". As demais finalidades são movimentações
 * internas do armazém, que não expedem nada ao cliente final e portanto não
 * disparam a exclusão por vida útil — mas continuam sujeitas a TODO o resto
 * (RN-EST-010 universo, RN-EST-011 ordenação).
 */
export const SELECTION_PURPOSES = ['CLIENT_DISPATCH', 'INTERNAL_REPLENISHMENT', 'INTERNAL_TRANSFER'] as const;
export type SelectionPurpose = (typeof SELECTION_PURPOSES)[number];

/** RN-EST-012 só incide sobre expedição a cliente (§4.2). */
export function purposeAppliesShelfLife(purpose: SelectionPurpose): boolean {
  return purpose === 'CLIENT_DISPATCH';
}

export interface StockSelectionRequest {
  tenantId: string;
  warehouseId: string;
  productId: string;
  /** Quantidade demandada, na UoM base do produto (RG-010). */
  demandQty: number;
  purpose: SelectionPurpose;
  /**
   * Data de referência 'YYYY-MM-DD' para RN-EST-012. Opcional: o service
   * resolve para a data corrente (UTC) quando ausente. Explicitável para que
   * teste e auditoria sejam determinísticos (nunca now() escondido na regra).
   */
  today?: string;
  /**
   * RN-EST-013 — seleção FORA da ordem (ex.: lote específico exigido pelo
   * cliente). Exige `EST.QUEBRA_POLITICA_GIRO` + exceção `EST.QUEBRA_FEFO`
   * APROVADA antes de efetivar a reserva; validado em StockReservationService,
   * não aqui (a seleção em si é só leitura).
   */
  forcedBatchId?: string | null;
  /**
   * RN-EST-013 — a SEGUNDA forma de quebra: "Exclusões por shelf life
   * (RN-EST-012) admitem quebra apenas com autorização registrada do cliente
   * (anexo obrigatório na exceção)".
   *
   * Quando true, RN-EST-012 deixa de EXCLUIR — mas os saldos reprovados
   * continuam sendo reportados em `excludedByShelfLife`, para que a reserva
   * saiba que houve quebra por shelf life e exija o anexo. Sozinho não
   * autoriza nada: a seleção é leitura pura, e a autorização (permissão +
   * exceção aprovada + anexo) é validada em StockReservationService ANTES de
   * qualquer efeito.
   */
  overrideShelfLife?: boolean;
  actorUserId: string;
}

export interface StockSelectionOutcome {
  /** Política efetivamente aplicada, já resolvida por RG-006 (produto → cliente×armazém). */
  policy: GiroPolicy;
  /** Alocações na ORDEM de consumo (RN-EST-011). Vazio = nenhum candidato elegível. */
  allocations: SelectionAllocation[];
  /** Quantidade não coberta pelos candidatos (0 = demanda integralmente atendida). */
  shortfall: number;
  /**
   * Saldos que NÃO atendem RN-EST-012. Sem override, foram efetivamente
   * excluídos do universo; com `overrideShelfLife`, permanecem candidatos mas
   * seguem listados aqui — é por esta lista que StockReservationService
   * descobre que a reserva configura quebra por shelf life e passa a exigir o
   * anexo de autorização do cliente (RN-EST-013).
   */
  excludedByShelfLife: Array<{ stockBalanceId: string; batchId: string | null; expirationDate: string | null }>;
  /** true quando a seleção foi restrita a um lote específico (RN-EST-013). */
  policyBreak: boolean;
  /** true quando RN-EST-012 deixou de excluir por override explícito (RN-EST-013). */
  shelfLifeOverridden: boolean;
}

/**
 * Porta consumida por reposição/kanban, picking (DOC-06) e inventário (5C).
 * Implementação: StockSelectionService.
 */
export interface StockSelectionPort {
  select(request: StockSelectionRequest): Promise<StockSelectionOutcome>;
}

/** Token de injeção — permite trocar a implementação sem tocar nos consumidores. */
export const STOCK_SELECTION_PORT = Symbol('StockSelectionPort');
