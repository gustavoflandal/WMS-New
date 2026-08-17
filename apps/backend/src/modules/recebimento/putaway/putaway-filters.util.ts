// DOC-04 RN-REC-040 Fase 1 [INVIOLÁVEL] — Filtros invioláveis.
//
// "Para cada palete, o motor DEVE executar: Fase 1 — Filtros invioláveis
// (ordem fixa, não configurável, sem override)". Os SEIS filtros abaixo
// estão na ORDEM EXATA do documento e essa ordem é parte da regra: o motivo
// de reprovação devolvido é o do PRIMEIRO filtro que reprovou.
//
// Lógica PURA (sem I/O): o service carrega os dados e chama isto. Assim a
// regra [INVIOLÁVEL] é auditável e testável isoladamente, sem depender de
// fixtures de banco para provar que um endereço ilegal é rejeitado.
//
// ─────────────────────────────────────────────────────────────────────────
// VEREDITO TERNÁRIO (L definitivo × O superável por override): interpretação
// NORMATIVA APROVADA — o enunciado completo, com as três fontes e o
// raciocínio, está no cabeçalho do FILTRO 3 mais abaixo, que é onde a
// distinção nasce. Todo o motor obedece a ela.
// ─────────────────────────────────────────────────────────────────────────

/** Veredito por endereço. `REJECTED_OPERATIONAL` só é superável via RN-REC-041 (override). */
export type PutawayVerdict = 'APPROVED' | 'REJECTED_LEGAL' | 'REJECTED_OPERATIONAL';

export interface PutawayFilterOutcome {
  verdict: PutawayVerdict;
  /** 1..6 — número do filtro do RN-REC-040 que reprovou; null quando aprovado. */
  failedFilter: number | null;
  /** Motivo EXATO para diagnóstico (filtro + endereço), exigido por RN-REC-040. */
  reason: string | null;
}

export interface CandidateLocationInput {
  locationId: string;
  code: string;
  status: string;
  zoneId: string;
  zoneType: string;
  zoneStatus: string;
  allowedSpecies: string[];
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  accessPolicy: string | null;
  maxWeightKg: number;
  maxVolumeM3: number;
  maxPallets: number;
  maxHeightM: number;
  /** Ocupação FÍSICA atual (cross-tenant, wms.location_physical_occupancy). */
  occupiedWeightKg: number;
  occupiedVolumeM3: number;
  occupiedPallets: number;
  /** Classes de segregação JÁ presentes no endereço (RN-EST-022) — cross-tenant. */
  presentSegregationClasses: string[];
  /** Lotes presentes no CANAL físico do endereço (filtro 6, LIFO_PHYSICAL) — cross-tenant. */
  channelBatchIds: string[];
  /** Classes de segregação já presentes na ZONA (RN-EST-021) — cross-tenant. */
  zonePresentSegregationClasses: string[];
  /** tenant dono do Armazém Lógico ao qual o endereço está vinculado; null = endereço livre. */
  logicalWarehouseOwnerTenantId: string | null;
}

export interface PalletToStoreInput {
  tenantId: string;
  /** Espécies (product_species.code) presentes no palete. */
  speciesCodes: string[];
  /** Classes de segregação (RN-EST-020) presentes no palete. */
  segregationClasses: string[];
  /** Lotes do palete — filtro 6 (canal homogêneo). */
  batchIds: string[];
  /** RN-REC-031: algum lote do palete está em QUARANTINE. */
  hasQuarantineBatch: boolean;
  /** Políticas de giro (product.giro_policy ou herdada da espécie) presentes no palete. */
  giroPolicies: string[];
  totalWeightKg: number;
  totalVolumeM3: number;
  /** Altura do palete montado — ver LACUNA em putaway-engine.service.ts. */
  heightM: number;
}

export interface WarehouseContextInput {
  /** Armazém Lógico ATIVO do tenant neste armazém (RG-015); null = tenant sem armazém lógico. */
  tenantLogicalWarehouseOwnerId: string | null;
}

// RN-EST-021 [INVIOLÁVEL] — matriz de coabitação de ZONA, transcrita
// literalmente do DOC-05 §4.3. Linha = classe JÁ presente na zona; coluna =
// classe ENTRANDO. P = permitido, L = proibição legal, O = operacional.
const ZONE_COHABITATION: Record<string, Record<string, 'P' | 'L' | 'O'>> = {
  FARMA:       { FARMA: 'P', ALIMENTAR: 'L', INFLAMAVEIS: 'L', QUIMICA: 'L', NEUTRA: 'O' },
  ALIMENTAR:   { FARMA: 'L', ALIMENTAR: 'P', INFLAMAVEIS: 'L', QUIMICA: 'L', NEUTRA: 'O' },
  INFLAMAVEIS: { FARMA: 'L', ALIMENTAR: 'L', INFLAMAVEIS: 'P', QUIMICA: 'O', NEUTRA: 'L' },
  QUIMICA:     { FARMA: 'L', ALIMENTAR: 'L', INFLAMAVEIS: 'O', QUIMICA: 'P', NEUTRA: 'L' },
  NEUTRA:      { FARMA: 'O', ALIMENTAR: 'O', INFLAMAVEIS: 'L', QUIMICA: 'L', NEUTRA: 'P' },
};

// RN-EST-021, "regras adicionais invioláveis": espécie -> zonas onde PODE
// entrar. Ausente do mapa = sem restrição de tipo de zona própria.
// [LACUNA: o documento escreve "REFRIGERADO/CONGELADO somente em zonas
// COLD/FROZEN" como conjunto pareado, sem dizer que REFRIGERADO exige
// exatamente COLD e CONGELADO exatamente FROZEN — implementada a leitura
// LITERAL (ambas aceitam COLD ou FROZEN); um pareamento 1:1 mais estrito
// seria invenção e rejeitaria configurações que o texto permite.]
const SPECIES_REQUIRED_ZONE_TYPES: Record<string, string[]> = {
  INFLAMAVEL: ['CLASSIFIED_FLAMMABLE'],
  COMBUSTIVEL: ['CLASSIFIED_FLAMMABLE'],
  QUIMICO_CONTROLADO: ['CONTROLLED'],
  REFRIGERADO: ['COLD', 'FROZEN'],
  CONGELADO: ['COLD', 'FROZEN'],
};

const APPROVED: PutawayFilterOutcome = { verdict: 'APPROVED', failedFilter: null, reason: null };

function reject(verdict: 'REJECTED_LEGAL' | 'REJECTED_OPERATIONAL', failedFilter: number, reason: string): PutawayFilterOutcome {
  return { verdict, failedFilter, reason };
}

/**
 * RN-REC-040 Fase 1 — aplica os 6 filtros NA ORDEM FIXA e devolve o veredito
 * do PRIMEIRO que reprovar. Ordem não é configurável e não há atalho: cada
 * filtro só roda se todos os anteriores aprovaram.
 */
export function evaluatePutawayFilters(
  location: CandidateLocationInput,
  pallet: PalletToStoreInput,
  context: WarehouseContextInput
): PutawayFilterOutcome {
  // ── Filtro 1 — location.status = ACTIVE ─────────────────────────────────
  if (location.status !== 'ACTIVE') {
    return reject('REJECTED_LEGAL', 1, `RN-REC-040 filtro 1: endereço ${location.code} não está ACTIVE (status ${location.status})`);
  }
  // A zona também precisa estar ativa: um endereço ACTIVE dentro de zona
  // BLOCKED/INACTIVE não é utilizável. [LACUNA: RN-REC-040 filtro 1 cita só
  // `location.status`; zona bloqueada é a mesma classe de indisponibilidade
  // e ignorá-la sugeriria endereço de zona desativada.]
  if (location.zoneStatus !== 'ACTIVE') {
    return reject('REJECTED_LEGAL', 1, `RN-REC-040 filtro 1: zona do endereço ${location.code} não está ACTIVE (status ${location.zoneStatus})`);
  }

  // ── Filtro 2 — Contenção do Armazém Lógico (RG-015) ─────────────────────
  // RG-015 item 2 [INVIOLÁVEL]: endereço de armazém lógico de OUTRO cliente
  // nunca aceita produto deste cliente — "Esta exclusividade NÃO admite
  // override por nenhum papel".
  if (location.logicalWarehouseOwnerTenantId !== null && location.logicalWarehouseOwnerTenantId !== pallet.tenantId) {
    return reject(
      'REJECTED_LEGAL',
      2,
      `RG-015 item 2 (filtro 2): endereço ${location.code} pertence ao Armazém Lógico de OUTRO cliente — exclusividade sem override`
    );
  }
  // RG-015 item 1: havendo Armazém Lógico ativo do cliente, os candidatos
  // ficam restritos aos endereços vinculados a ele. O transbordo (item 3)
  // exige aprovação em workflow com LOGICAL_WAREHOUSE_OVERFLOW e NÃO é um
  // override de putaway — [DÉBITO: fluxo de transbordo RG-015 item 3 é do
  // DOC-05 (EST.LOGICAL_WAREHOUSE_OVERFLOW), fora do escopo desta sessão;
  // aqui o endereço fora do armazém lógico é simplesmente reprovado].
  if (context.tenantLogicalWarehouseOwnerId !== null && location.logicalWarehouseOwnerTenantId === null) {
    return reject(
      'REJECTED_LEGAL',
      2,
      `RG-015 item 1 (filtro 2): cliente possui Armazém Lógico ativo — endereço ${location.code} não está vinculado a ele`
    );
  }

  // ── Filtro 3 — Compatibilidade de espécie (RG-005 + RN-EST-020/021/022) ──
  //
  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║ INTERPRETAÇÃO NORMATIVA APROVADA (emenda ao relatório da Sessão 4B,   ║
  // ║ 2026-08-17). Não é leitura livre do implementador: é a resolução      ║
  // ║ OFICIAL da tensão entre três requisitos, e vale para todo o motor.    ║
  // ║                                                                       ║
  // ║ Fontes:                                                               ║
  // ║  · RN-REC-040 (DOC-04 §4.5): "Endereço reprovado em qualquer filtro   ║
  // ║    NÃO PODE ser sugerido nem aceito por override."                    ║
  // ║  · RG-005 (DOC-00) [INVIOLÁVEL]: "Incompatibilidades legais ... NÃO   ║
  // ║    admitem override por nenhum papel. Incompatibilidades operacionais ║
  // ║    admitem override apenas com permissão específica + motivo + log."  ║
  // ║  · RN-EST-021 (DOC-05 §4.3) [INVIOLÁVEL]: tipifica cada célula da     ║
  // ║    matriz como P / L (legal, sem override) / O (operacional, override ║
  // ║    com EST.PUTAWAY_OVERRIDE + motivo).                                ║
  // ║                                                                       ║
  // ║ RESOLUÇÃO OFICIAL — o veredito é TERNÁRIO:                            ║
  // ║  · `L` (legal) e TODOS os demais filtros -> REJECTED_LEGAL:           ║
  // ║    reprovação DEFINITIVA. Nada a supera: nem EST.PUTAWAY_OVERRIDE,    ║
  // ║    nem chamada direta de API, nem importação.                         ║
  // ║  · `O` (operacional) -> REJECTED_OPERATIONAL: NUNCA é sugerido nem    ║
  // ║    entra nas 4 alternativas; só é alcançável por escolha EXPLÍCITA do ║
  // ║    operador com EST.PUTAWAY_OVERRIDE + motivo obrigatório + auditoria ║
  // ║    `action = OVERRIDE` (RN-REC-041 / AD-006).                         ║
  // ║                                                                       ║
  // ║ Ou seja: "reprovado" em RN-REC-040 significa reprovação DEFINITIVA.   ║
  // ║ Uma célula `O` não é reprovação definitiva — é exatamente a           ║
  // ║ "incompatibilidade operacional" que RG-005 e RN-EST-021 (ambas       ║
  // ║ [INVIOLÁVEL] e específicas sobre a matriz de espécies) autorizam      ║
  // ║ superar sob condições estritas.                                       ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  //
  // 3a. zone.allowed_species (RN-REC-040 cita "zona allowed_species + matriz").
  // [LACUNA: DOC-02/DOC-05 não definem a semântica de allowed_species VAZIO
  // — interpretado como "a zona não impõe restrição própria" (a matriz
  // RN-EST-021 continua valendo). O inverso tornaria toda zona sem
  // configuração explícita inutilizável para qualquer produto.]
  if (location.allowedSpecies.length > 0) {
    const notAllowed = pallet.speciesCodes.filter((s) => !location.allowedSpecies.includes(s));
    if (notAllowed.length > 0) {
      return reject(
        'REJECTED_LEGAL',
        3,
        `RG-005 (filtro 3): zona do endereço ${location.code} não permite a(s) espécie(s) ${notAllowed.join(', ')} (allowed_species)`
      );
    }
  }

  // 3b. RN-EST-021, regras adicionais invioláveis por tipo de zona.
  for (const species of pallet.speciesCodes) {
    const requiredZones = SPECIES_REQUIRED_ZONE_TYPES[species];
    if (requiredZones && !requiredZones.includes(location.zoneType)) {
      return reject(
        'REJECTED_LEGAL',
        3,
        `RN-EST-021 (filtro 3): espécie ${species} só pode ser armazenada em zona ${requiredZones.join('/')} — endereço ${location.code} está em zona ${location.zoneType}`
      );
    }
  }
  // FARMA: "somente em zonas cujo allowed_species contenha MEDICAMENTO" —
  // exigência POSITIVA: aqui uma zona sem allowed_species NÃO serve.
  if (pallet.speciesCodes.includes('MEDICAMENTO') && !location.allowedSpecies.includes('MEDICAMENTO')) {
    return reject(
      'REJECTED_LEGAL',
      3,
      `RN-EST-021 (filtro 3): espécie MEDICAMENTO exige zona com MEDICAMENTO em allowed_species — endereço ${location.code} não a declara`
    );
  }
  // REFRIGERADO/CONGELADO: "com faixa de temperatura compatível" — a faixa
  // precisa estar CONFIGURADA na zona.
  // [LACUNA: DOC-02 não tem faixa de temperatura exigida por PRODUTO, então
  // "compatível" só pode ser verificado como "a zona declara uma faixa";
  // a comparação produto×zona fica impossível com o modelo atual.]
  if (pallet.speciesCodes.some((s) => s === 'REFRIGERADO' || s === 'CONGELADO')) {
    if (location.temperatureMinC === null || location.temperatureMaxC === null) {
      return reject(
        'REJECTED_LEGAL',
        3,
        `RN-EST-021 (filtro 3): espécie refrigerada/congelada exige zona com faixa de temperatura configurada — zona do endereço ${location.code} não declara faixa`
      );
    }
  }

  // 3c. RN-EST-022 [INVIOLÁVEL] — coabitação de ENDEREÇO: todas as espécies
  // presentes no MESMO endereço devem ser da MESMA classe. "misturar classes
  // no mesmo endereço é PROIBIDO sem exceção, inclusive NEUTRA com qualquer
  // outra" — portanto sempre LEGAL, nunca operacional.
  const palletClasses = [...new Set(pallet.segregationClasses)];
  const addressClasses = [...new Set(location.presentSegregationClasses)];
  const mixedInAddress = [...new Set([...palletClasses, ...addressClasses])];
  if (mixedInAddress.length > 1) {
    return reject(
      'REJECTED_LEGAL',
      3,
      `RN-EST-022 (filtro 3): endereço ${location.code} ficaria com classes de segregação distintas (${mixedInAddress.join(' + ')}) — proibido sem exceção`
    );
  }

  // 3d. RN-EST-021 — matriz de coabitação de ZONA (classe já na zona × classe entrando).
  // Zona vazia não restringe (não há com o que coabitar).
  let operationalBlock: PutawayFilterOutcome | null = null;
  for (const present of new Set(location.zonePresentSegregationClasses)) {
    for (const entering of palletClasses) {
      const cell = ZONE_COHABITATION[present]?.[entering];
      if (cell === 'L') {
        return reject(
          'REJECTED_LEGAL',
          3,
          `RN-EST-021 (filtro 3): zona do endereço ${location.code} já contém classe ${present}; entrada de ${entering} é proibição LEGAL (sem override, RG-005)`
        );
      }
      if (cell === 'O' && operationalBlock === null) {
        operationalBlock = reject(
          'REJECTED_OPERATIONAL',
          3,
          `RN-EST-021 (filtro 3): zona do endereço ${location.code} já contém classe ${present}; entrada de ${entering} é proibição OPERACIONAL (override com EST.PUTAWAY_OVERRIDE + motivo)`
        );
      }
    }
  }
  // Só devolve o bloqueio operacional depois de varrer TUDO: uma proibição
  // legal em qualquer par tem precedência sobre uma operacional.
  if (operationalBlock) return operationalBlock;

  // ── Filtro 4 — Quarentena (RN-REC-031) ──────────────────────────────────
  // "lote QUARANTINE -> apenas zonas QUARANTINE".
  if (pallet.hasQuarantineBatch && location.zoneType !== 'QUARANTINE') {
    return reject(
      'REJECTED_LEGAL',
      4,
      `RN-REC-031 (filtro 4): palete contém lote em QUARANTINE — só pode ser endereçado em zona QUARANTINE, e ${location.code} está em zona ${location.zoneType}`
    );
  }

  // ── Filtro 5 — Capacidades considerando a ocupação ATUAL ────────────────
  if (location.occupiedPallets + 1 > location.maxPallets) {
    return reject(
      'REJECTED_LEGAL',
      5,
      `RN-REC-040 filtro 5: endereço ${location.code} sem vaga de palete (ocupados ${location.occupiedPallets} de ${location.maxPallets})`
    );
  }
  if (location.occupiedWeightKg + pallet.totalWeightKg > location.maxWeightKg) {
    return reject(
      'REJECTED_LEGAL',
      5,
      `RN-REC-040 filtro 5: endereço ${location.code} excederia o peso máximo (${location.occupiedWeightKg} + ${pallet.totalWeightKg} > ${location.maxWeightKg} kg)`
    );
  }
  if (location.occupiedVolumeM3 + pallet.totalVolumeM3 > location.maxVolumeM3) {
    return reject(
      'REJECTED_LEGAL',
      5,
      `RN-REC-040 filtro 5: endereço ${location.code} excederia o volume máximo (${location.occupiedVolumeM3} + ${pallet.totalVolumeM3} > ${location.maxVolumeM3} m³)`
    );
  }
  // Altura NÃO acumula (é uma dimensão do palete, não uma soma).
  if (pallet.heightM > location.maxHeightM) {
    return reject(
      'REJECTED_LEGAL',
      5,
      `RN-REC-040 filtro 5: palete (${pallet.heightM} m) excede a altura máxima do endereço ${location.code} (${location.maxHeightM} m)`
    );
  }

  // ── Filtro 6 — Coerência física × giro (RN-DAD-010) ─────────────────────
  // LIFO_PHYSICAL (DRIVE_IN/BLOCADO): produto FEFO/FIFO só entra se TODO o
  // canal for do mesmo lote — senão o último a entrar (primeiro a sair)
  // violaria a política de giro do produto na saída.
  if (location.accessPolicy === 'LIFO_PHYSICAL') {
    const needsOrderedRotation = pallet.giroPolicies.some((g) => g === 'FEFO' || g === 'FIFO');
    if (needsOrderedRotation) {
      const foreignBatches = location.channelBatchIds.filter((b) => !pallet.batchIds.includes(b));
      if (foreignBatches.length > 0) {
        return reject(
          'REJECTED_LEGAL',
          6,
          `RN-DAD-010 (filtro 6): endereço ${location.code} é de estrutura LIFO_PHYSICAL e o canal já contém lote diferente — produto ${pallet.giroPolicies.join('/')} exige canal de lote homogêneo`
        );
      }
      // Palete SEM lote (espécie que não exige lote) em canal LIFO com giro
      // ordenado também quebra a homogeneidade se o canal já tem qualquer coisa.
      if (pallet.batchIds.length === 0 && location.channelBatchIds.length > 0) {
        return reject(
          'REJECTED_LEGAL',
          6,
          `RN-DAD-010 (filtro 6): endereço ${location.code} é LIFO_PHYSICAL e o canal já contém lote — palete sem lote não pode compor canal homogêneo`
        );
      }
    }
  }
  // [LACUNA/DÉBITO: RN-DAD-010 também diz "FIFO_PHYSICAL preferencial para
  // FEFO/FIFO". "Preferencial" é ranqueamento, não filtro — mas o catálogo
  // da Fase 2 é FECHADO em 6 critérios (RN-REC-040) e nenhum deles trata de
  // estrutura física. Implementar a preferência exigiria um 7º critério, o
  // que violaria o catálogo fechado. Implementada apenas a metade
  // OBRIGATÓRIA (restrição LIFO_PHYSICAL acima); a preferência fica como
  // débito para quando o catálogo da Fase 2 for revisto por documento.]

  return APPROVED;
}
