// DOC-04 RN-REC-040 Fase 1 [INVIOLÁVEL] — os 6 filtros, em lógica pura.
// Cada teste prova UM filtro isoladamente (os anteriores aprovando), para que
// a reprovação observada seja atribuível ao filtro correto.
import {
  evaluatePutawayFilters,
  CandidateLocationInput,
  PalletToStoreInput,
  WarehouseContextInput,
} from '../putaway-filters.util.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function location(overrides: Partial<CandidateLocationInput> = {}): CandidateLocationInput {
  return {
    locationId: 'loc-1',
    code: 'A1-001-00-01',
    status: 'ACTIVE',
    zoneId: 'zone-1',
    zoneType: 'STORAGE',
    zoneStatus: 'ACTIVE',
    allowedSpecies: [],
    temperatureMinC: null,
    temperatureMaxC: null,
    accessPolicy: 'RANDOM',
    maxWeightKg: 1000,
    maxVolumeM3: 10,
    maxPallets: 2,
    maxHeightM: 3,
    occupiedWeightKg: 0,
    occupiedVolumeM3: 0,
    occupiedPallets: 0,
    presentSegregationClasses: [],
    channelBatchIds: [],
    zonePresentSegregationClasses: [],
    logicalWarehouseOwnerTenantId: null,
    ...overrides,
  };
}

function pallet(overrides: Partial<PalletToStoreInput> = {}): PalletToStoreInput {
  return {
    tenantId: TENANT_A,
    speciesCodes: ['GERAL'],
    segregationClasses: ['NEUTRA'],
    batchIds: [],
    hasQuarantineBatch: false,
    giroPolicies: ['FIFO'],
    totalWeightKg: 100,
    totalVolumeM3: 1,
    heightM: 1,
    ...overrides,
  };
}

const NO_LW: WarehouseContextInput = { tenantLogicalWarehouseOwnerId: null };

describe('RN-REC-040 Fase 1 — filtros invioláveis', () => {
  it('caso base: endereço livre e compatível é APROVADO', () => {
    expect(evaluatePutawayFilters(location(), pallet(), NO_LW)).toEqual({ verdict: 'APPROVED', failedFilter: null, reason: null });
  });

  describe('filtro 1 — location.status = ACTIVE', () => {
    it.each(['BLOCKED', 'INVENTORY', 'INACTIVE'])('endereço %s é reprovado', (status) => {
      const out = evaluatePutawayFilters(location({ status }), pallet(), NO_LW);
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(1);
    });

    it('zona BLOCKED reprova mesmo com endereço ACTIVE', () => {
      const out = evaluatePutawayFilters(location({ zoneStatus: 'BLOCKED' }), pallet(), NO_LW);
      expect(out.failedFilter).toBe(1);
    });
  });

  describe('filtro 2 — contenção do Armazém Lógico (RG-015)', () => {
    it('endereço do armazém lógico de OUTRO cliente é reprovado LEGAL (sem override)', () => {
      const out = evaluatePutawayFilters(location({ logicalWarehouseOwnerTenantId: TENANT_B }), pallet({ tenantId: TENANT_A }), NO_LW);
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(2);
      expect(out.reason).toMatch(/RG-015 item 2/);
    });

    it('cliente COM armazém lógico ativo: endereço fora dele é reprovado', () => {
      const out = evaluatePutawayFilters(location({ logicalWarehouseOwnerTenantId: null }), pallet(), { tenantLogicalWarehouseOwnerId: TENANT_A });
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(2);
      expect(out.reason).toMatch(/RG-015 item 1/);
    });

    it('cliente COM armazém lógico ativo: endereço DENTRO dele é aprovado', () => {
      const out = evaluatePutawayFilters(location({ logicalWarehouseOwnerTenantId: TENANT_A }), pallet({ tenantId: TENANT_A }), {
        tenantLogicalWarehouseOwnerId: TENANT_A,
      });
      expect(out.verdict).toBe('APPROVED');
    });
  });

  describe('filtro 3 — espécie (RG-005 + RN-EST-020/021/022)', () => {
    it('espécie fora de allowed_species da zona é reprovada', () => {
      const out = evaluatePutawayFilters(location({ allowedSpecies: ['ALIMENTO'] }), pallet({ speciesCodes: ['GERAL'] }), NO_LW);
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(3);
    });

    it('INFLAMAVEL fora de zona CLASSIFIED_FLAMMABLE é reprovado LEGAL (cenário §6)', () => {
      const out = evaluatePutawayFilters(
        location({ zoneType: 'STORAGE' }),
        pallet({ speciesCodes: ['INFLAMAVEL'], segregationClasses: ['INFLAMAVEIS'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(3);
      expect(out.reason).toMatch(/CLASSIFIED_FLAMMABLE/);
    });

    it('QUIMICO_CONTROLADO só em zona CONTROLLED', () => {
      const fora = evaluatePutawayFilters(
        location({ zoneType: 'STORAGE' }),
        pallet({ speciesCodes: ['QUIMICO_CONTROLADO'], segregationClasses: ['QUIMICA'] }),
        NO_LW
      );
      expect(fora.failedFilter).toBe(3);
      const dentro = evaluatePutawayFilters(
        location({ zoneType: 'CONTROLLED' }),
        pallet({ speciesCodes: ['QUIMICO_CONTROLADO'], segregationClasses: ['QUIMICA'] }),
        NO_LW
      );
      expect(dentro.verdict).toBe('APPROVED');
    });

    it('MEDICAMENTO exige allowed_species contendo MEDICAMENTO (exigência POSITIVA)', () => {
      const semDeclaracao = evaluatePutawayFilters(
        location({ allowedSpecies: [] }),
        pallet({ speciesCodes: ['MEDICAMENTO'], segregationClasses: ['FARMA'] }),
        NO_LW
      );
      expect(semDeclaracao.verdict).toBe('REJECTED_LEGAL');
      expect(semDeclaracao.failedFilter).toBe(3);

      const comDeclaracao = evaluatePutawayFilters(
        location({ allowedSpecies: ['MEDICAMENTO'] }),
        pallet({ speciesCodes: ['MEDICAMENTO'], segregationClasses: ['FARMA'] }),
        NO_LW
      );
      expect(comDeclaracao.verdict).toBe('APPROVED');
    });

    it('RN-EST-022: misturar classes no MESMO endereço é proibido sem exceção (inclusive NEUTRA)', () => {
      const out = evaluatePutawayFilters(
        location({ presentSegregationClasses: ['ALIMENTAR'], zonePresentSegregationClasses: ['ALIMENTAR'] }),
        pallet({ speciesCodes: ['GERAL'], segregationClasses: ['NEUTRA'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.reason).toMatch(/RN-EST-022/);
    });

    it('RN-EST-021 célula L (FARMA na zona, ALIMENTAR entrando): LEGAL, sem override', () => {
      const out = evaluatePutawayFilters(
        location({ allowedSpecies: [], zonePresentSegregationClasses: ['FARMA'] }),
        pallet({ speciesCodes: ['ALIMENTO'], segregationClasses: ['ALIMENTAR'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.reason).toMatch(/proibição LEGAL/);
    });

    it('RN-EST-021 célula O (NEUTRA na zona, FARMA entrando): OPERACIONAL, superável por override', () => {
      const out = evaluatePutawayFilters(
        location({ allowedSpecies: ['MEDICAMENTO'], zonePresentSegregationClasses: ['NEUTRA'] }),
        pallet({ speciesCodes: ['MEDICAMENTO'], segregationClasses: ['FARMA'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_OPERATIONAL');
      expect(out.reason).toMatch(/EST\.PUTAWAY_OVERRIDE/);
    });

    it('proibição LEGAL tem precedência sobre OPERACIONAL quando a zona tem as duas classes', () => {
      // Zona com NEUTRA (O para FARMA) e ALIMENTAR (L para FARMA) -> vence L.
      const out = evaluatePutawayFilters(
        location({ allowedSpecies: ['MEDICAMENTO'], zonePresentSegregationClasses: ['NEUTRA', 'ALIMENTAR'] }),
        pallet({ speciesCodes: ['MEDICAMENTO'], segregationClasses: ['FARMA'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
    });
  });

  describe('filtro 4 — quarentena (RN-REC-031)', () => {
    it('lote QUARANTINE fora de zona QUARANTINE é reprovado', () => {
      const out = evaluatePutawayFilters(location({ zoneType: 'STORAGE' }), pallet({ hasQuarantineBatch: true }), NO_LW);
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(4);
    });

    it('lote QUARANTINE em zona QUARANTINE é aprovado', () => {
      const out = evaluatePutawayFilters(location({ zoneType: 'QUARANTINE' }), pallet({ hasQuarantineBatch: true }), NO_LW);
      expect(out.verdict).toBe('APPROVED');
    });
  });

  describe('filtro 5 — capacidades sobre a ocupação ATUAL', () => {
    it('endereço nominalmente grande mas JÁ OCUPADO é reprovado (peso)', () => {
      const out = evaluatePutawayFilters(
        location({ maxWeightKg: 1000, occupiedWeightKg: 950 }),
        pallet({ totalWeightKg: 100 }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(5);
      expect(out.reason).toMatch(/peso máximo/);
    });

    it('vagas de palete esgotadas', () => {
      const out = evaluatePutawayFilters(location({ maxPallets: 1, occupiedPallets: 1 }), pallet(), NO_LW);
      expect(out.failedFilter).toBe(5);
      expect(out.reason).toMatch(/vaga de palete/);
    });

    it('volume acumulado excedido', () => {
      const out = evaluatePutawayFilters(location({ maxVolumeM3: 10, occupiedVolumeM3: 9.5 }), pallet({ totalVolumeM3: 1 }), NO_LW);
      expect(out.failedFilter).toBe(5);
      expect(out.reason).toMatch(/volume máximo/);
    });

    it('altura NÃO acumula: palete baixo entra em endereço já ocupado', () => {
      const out = evaluatePutawayFilters(location({ maxHeightM: 3, occupiedPallets: 1, maxPallets: 5 }), pallet({ heightM: 2.9 }), NO_LW);
      expect(out.verdict).toBe('APPROVED');
    });

    it('palete mais alto que o endereço é reprovado', () => {
      const out = evaluatePutawayFilters(location({ maxHeightM: 2 }), pallet({ heightM: 2.5 }), NO_LW);
      expect(out.failedFilter).toBe(5);
      expect(out.reason).toMatch(/altura máxima/);
    });
  });

  describe('filtro 6 — coerência física × giro (RN-DAD-010)', () => {
    it('LIFO_PHYSICAL: produto FEFO em canal com lote DIFERENTE é reprovado', () => {
      const out = evaluatePutawayFilters(
        location({ accessPolicy: 'LIFO_PHYSICAL', channelBatchIds: ['batch-outro'] }),
        pallet({ giroPolicies: ['FEFO'], batchIds: ['batch-meu'] }),
        NO_LW
      );
      expect(out.verdict).toBe('REJECTED_LEGAL');
      expect(out.failedFilter).toBe(6);
    });

    it('LIFO_PHYSICAL: produto FEFO em canal do MESMO lote é aprovado', () => {
      const out = evaluatePutawayFilters(
        location({ accessPolicy: 'LIFO_PHYSICAL', channelBatchIds: ['batch-meu'] }),
        pallet({ giroPolicies: ['FEFO'], batchIds: ['batch-meu'] }),
        NO_LW
      );
      expect(out.verdict).toBe('APPROVED');
    });

    it('LIFO_PHYSICAL: canal VAZIO aceita qualquer lote', () => {
      const out = evaluatePutawayFilters(
        location({ accessPolicy: 'LIFO_PHYSICAL', channelBatchIds: [] }),
        pallet({ giroPolicies: ['FEFO'], batchIds: ['batch-meu'] }),
        NO_LW
      );
      expect(out.verdict).toBe('APPROVED');
    });

    it('LIFO_PHYSICAL: produto LIFO não sofre a restrição (a estrutura casa com a política)', () => {
      const out = evaluatePutawayFilters(
        location({ accessPolicy: 'LIFO_PHYSICAL', channelBatchIds: ['batch-outro'] }),
        pallet({ giroPolicies: ['LIFO'], batchIds: ['batch-meu'] }),
        NO_LW
      );
      expect(out.verdict).toBe('APPROVED');
    });

    it('RANDOM (porta-paletes): lote heterogêneo no canal é irrelevante', () => {
      const out = evaluatePutawayFilters(
        location({ accessPolicy: 'RANDOM', channelBatchIds: ['batch-outro'] }),
        pallet({ giroPolicies: ['FEFO'], batchIds: ['batch-meu'] }),
        NO_LW
      );
      expect(out.verdict).toBe('APPROVED');
    });
  });

  describe('ordem FIXA dos filtros', () => {
    it('endereço que viola vários filtros reporta o de MENOR número', () => {
      // Viola 1 (INACTIVE), 4 (quarentena fora de zona) e 5 (sem vaga).
      const out = evaluatePutawayFilters(
        location({ status: 'INACTIVE', zoneType: 'STORAGE', maxPallets: 1, occupiedPallets: 1 }),
        pallet({ hasQuarantineBatch: true }),
        NO_LW
      );
      expect(out.failedFilter).toBe(1);
    });
  });
});
