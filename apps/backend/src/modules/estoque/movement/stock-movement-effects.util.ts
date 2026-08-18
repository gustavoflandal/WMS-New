// DOC-05 §4.1 RN-EST-001 [INVIOLÁVEL] — catálogo fechado de movement_type e
// o efeito EXATO de cada um nas parcelas de wms.stock_balance.
//
// Lógica PURA e determinística (sem I/O), no mesmo espírito de
// putaway-ranking.util.ts: separada do service para que os 18 efeitos
// possam ser exercitados como teste de regressão permanente sem depender de
// banco (entregável 7 desta sessão: "teste parametrizado provando que cada
// um dos tipos produz o efeito exato de partição").

import { BadRequestException } from '@nestjs/common';

/** As 6 parcelas de wms.stock_balance (qty_available..qty_in_transit). */
export const STOCK_BUCKETS = ['AVAILABLE', 'RESERVED', 'BLOCKED', 'QUARANTINE', 'DAMAGED', 'IN_TRANSIT'] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

export const BUCKET_COLUMN: Record<StockBucket, string> = {
  AVAILABLE: 'qty_available',
  RESERVED: 'qty_reserved',
  BLOCKED: 'qty_blocked',
  QUARANTINE: 'qty_quarantine',
  DAMAGED: 'qty_damaged',
  IN_TRANSIT: 'qty_in_transit',
};

/** Catálogo FECHADO de wms.stock_movement.movement_type (DOC-05 §4.1) — 18 códigos distintos. */
export const MOVEMENT_TYPES = [
  'ENTRADA_RECEBIMENTO',
  'PUTAWAY',
  'RESERVA',
  'LIBERACAO_RESERVA',
  'PICKING',
  'TRANSFERENCIA_INTERNA',
  'TRANSFERENCIA_SAIDA_ARMAZEM',
  'TRANSFERENCIA_ENTRADA_ARMAZEM',
  'REPOSICAO',
  'BLOQUEIO',
  'DESBLOQUEIO',
  'LIBERACAO_QUARENTENA',
  'RECLASSIFICACAO_AVARIA',
  'AJUSTE_INVENTARIO_POS',
  'AJUSTE_INVENTARIO_NEG',
  'DESCARTE',
  'ENTRADA_REVERSA',
  'SAIDA_EXPEDICAO',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export function isMovementType(value: string): value is MovementType {
  return (MOVEMENT_TYPES as readonly string[]).includes(value);
}

/** Tipos "mesma parcela" — RN-EST-001: "move entre endereços, mesma parcela" (PUTAWAY) e mesma semântica para TRANSFERENCIA_INTERNA/REPOSICAO. */
const SAME_BUCKET_TYPES = new Set<MovementType>(['PUTAWAY', 'TRANSFERENCIA_INTERNA', 'REPOSICAO']);

export interface MovementBucketEffect {
  bucketFrom: StockBucket | null;
  bucketTo: StockBucket | null;
}

/**
 * Override do chamador para os tipos cujo efeito depende de contexto que só
 * o módulo de origem conhece — "conforme DOC-04" (ENTRADA_RECEBIMENTO),
 * "conforme triagem" (ENTRADA_REVERSA), "conforme ajuste aprovado"
 * (AJUSTE_INVENTARIO_POS/NEG), fonte da avaria/descarte/expedição (RECLASSIFICACAO_AVARIA,
 * DESCARTE, SAIDA_EXPEDICAO), destino de um TRF (TRANSFERENCIA_ENTRADA_ARMAZEM) e o
 * ÚNICO bucket usado pelos 3 tipos "mesma parcela".
 */
export interface MovementBucketOverride {
  bucketFrom?: StockBucket;
  bucketTo?: StockBucket;
}

function requireOverride(value: StockBucket | undefined, movementType: MovementType, field: 'bucketFrom' | 'bucketTo'): StockBucket {
  if (!value) {
    throw new BadRequestException({
      error: 'MISSING_BUCKET_OVERRIDE',
      detail: `RN-EST-001: movement_type '${movementType}' exige '${field}' explícito (efeito não é fixo neste tipo).`,
    });
  }
  return value;
}

/**
 * RN-EST-001 [INVIOLÁVEL] — resolve o efeito EXATO (bucketFrom → bucketTo)
 * de um movement_type. Tipos com efeito FIXO ignoram qualquer override
 * (o catálogo é fechado e a tabela do §4.1 já determina o valor); tipos
 * "conforme X" exigem override (lançado como erro determinístico, não
 * assumido em silêncio).
 */
export function resolveMovementBucketEffect(movementType: MovementType, override: MovementBucketOverride = {}): MovementBucketEffect {
  switch (movementType) {
    case 'PUTAWAY':
    case 'TRANSFERENCIA_INTERNA':
    case 'REPOSICAO': {
      const bucket = requireOverride(override.bucketFrom ?? override.bucketTo, movementType, 'bucketFrom');
      return { bucketFrom: bucket, bucketTo: bucket };
    }
    case 'ENTRADA_RECEBIMENTO':
      // "+ available (ou +quarantine/+blocked/+damaged conforme DOC-04)".
      return { bucketFrom: null, bucketTo: requireOverride(override.bucketTo, movementType, 'bucketTo') };
    case 'RESERVA':
      return { bucketFrom: 'AVAILABLE', bucketTo: 'RESERVED' };
    case 'LIBERACAO_RESERVA':
      return { bucketFrom: 'RESERVED', bucketTo: 'AVAILABLE' };
    case 'PICKING':
      // "− reserved (saída do endereço)".
      return { bucketFrom: 'RESERVED', bucketTo: null };
    case 'TRANSFERENCIA_SAIDA_ARMAZEM':
      // "− no origem (via in_transit)": available -> in_transit, no ARMAZÉM ORIGEM.
      return { bucketFrom: 'AVAILABLE', bucketTo: 'IN_TRANSIT' };
    case 'TRANSFERENCIA_ENTRADA_ARMAZEM':
      // "+ no destino": crédito no destino; a contraparte é a BAIXA do
      // in_transit represado no armazém ORIGEM (RF-EST-051: "enquanto em
      // trânsito, o saldo aparece na parcela qty_in_transit do armazém
      // origem") — por isso bucketFrom é FIXO em IN_TRANSIT, não null: este
      // tipo sempre limpa o in_transit de origem ao creditar o destino.
      return { bucketFrom: 'IN_TRANSIT', bucketTo: requireOverride(override.bucketTo, movementType, 'bucketTo') };
    case 'BLOQUEIO':
      return { bucketFrom: 'AVAILABLE', bucketTo: 'BLOCKED' };
    case 'DESBLOQUEIO':
      return { bucketFrom: 'BLOCKED', bucketTo: 'AVAILABLE' };
    case 'LIBERACAO_QUARENTENA':
      return { bucketFrom: 'QUARANTINE', bucketTo: 'AVAILABLE' };
    case 'RECLASSIFICACAO_AVARIA':
      // "available/blocked → damaged". [LACUNA: DOC-05 também prevê "(e
      // inverso mediante aprovação)" sem detalhar o fluxo de aprovação da
      // reversão — não implementado nesta sessão; só o sentido direto.]
      return { bucketFrom: requireOverride(override.bucketFrom, movementType, 'bucketFrom'), bucketTo: 'DAMAGED' };
    case 'AJUSTE_INVENTARIO_POS':
      return { bucketFrom: null, bucketTo: override.bucketTo ?? 'AVAILABLE' };
    case 'AJUSTE_INVENTARIO_NEG':
      return { bucketFrom: override.bucketFrom ?? 'AVAILABLE', bucketTo: null };
    case 'DESCARTE':
      // "− damaged/blocked".
      return { bucketFrom: requireOverride(override.bucketFrom, movementType, 'bucketFrom'), bucketTo: null };
    case 'ENTRADA_REVERSA':
      // "+ conforme triagem" (DOC-07).
      return { bucketFrom: null, bucketTo: requireOverride(override.bucketTo, movementType, 'bucketTo') };
    case 'SAIDA_EXPEDICAO':
      // "baixa final no carregamento" — parte de RESERVED por padrão (fluxo
      // normal passa por RESERVA antes de expedir, DOC-06), com override
      // disponível para o caso excepcional de baixa direta de AVAILABLE.
      return { bucketFrom: override.bucketFrom ?? 'RESERVED', bucketTo: null };
    default: {
      const exhaustive: never = movementType;
      throw new BadRequestException({ error: 'UNKNOWN_MOVEMENT_TYPE', detail: `RN-EST-001: movement_type desconhecido: ${exhaustive}` });
    }
  }
}

/** Verdadeiro para os 3 tipos cujo efeito é MOVER de endereço (mesma parcela) — usado para decidir se a linha de stock_movement leva location_id_from E to. */
export function isSameBucketLocationMove(movementType: MovementType): boolean {
  return SAME_BUCKET_TYPES.has(movementType);
}
