// DOC-17 RF-TEL-022 / RN-TEL-023 [INVIOLÁVEL] — cegueira preservada no papel.
import { describe, it, expect } from 'vitest';
import {
  buildPutawayLineContent,
  buildPickingLineContent,
  buildConferenciaLineContent,
  buildContagemLineContent,
  buildReposicaoLineContent,
  buildCarregamentoLineContent,
} from '../field-form-content.util.js';

describe('buildPutawayLineContent', () => {
  it('inclui LPN, produto, endereço sugerido e as alternativas (RF-TEL-022 Putaway)', () => {
    const content = buildPutawayLineContent({
      lpn: '129000000000012346',
      productDescription: 'Caixa de parafusos M6',
      locationSuggestedCode: 'A1-012-03-02',
      alternativeCodes: ['A1-012-03-03', 'A1-012-04-01', 'A1-013-01-01', 'A1-013-01-02'],
    });
    expect(content.lpn).toBe('129000000000012346');
    expect(content.endereco_sugerido).toBe('A1-012-03-02');
    expect(content.alternativas).toHaveLength(4);
  });
});

describe('buildPickingLineContent', () => {
  it('inclui sequência de rota, endereço, produto, lote, validade, quantidade e embalagem', () => {
    const content = buildPickingLineContent({
      routeSequence: 3,
      locationCode: 'B2-005-01-01',
      productDescription: 'Filtro de óleo',
      batchSuggested: 'LOTE-2026-08',
      expiryDate: '2027-01-01',
      qtySuggested: 12,
      packagingCode: 'CX12',
    });
    expect(content).toEqual({
      sequencia_rota: 3,
      endereco: 'B2-005-01-01',
      produto: 'Filtro de óleo',
      lote_sugerido: 'LOTE-2026-08',
      validade: '2027-01-01',
      quantidade_a_separar: 12,
      embalagem: 'CX12',
    });
  });
});

describe('buildConferenciaLineContent — RN-TEL-023', () => {
  it('conferência cega NÃO imprime o produto esperado', () => {
    const content = buildConferenciaLineContent({ expectedProductDescription: 'Produto X', blindChecking: true });
    expect(content.produto_esperado).toBeNull();
  });

  it('conferência não-cega imprime o produto esperado', () => {
    const content = buildConferenciaLineContent({ expectedProductDescription: 'Produto X', blindChecking: false });
    expect(content.produto_esperado).toBe('Produto X');
  });

  it('nenhum dos dois modos tem campo de quantidade esperada (não existe no catálogo)', () => {
    const cego = buildConferenciaLineContent({ expectedProductDescription: 'Produto X', blindChecking: true });
    const naoCego = buildConferenciaLineContent({ expectedProductDescription: 'Produto X', blindChecking: false });
    expect(Object.keys(cego)).not.toContain('quantidade_esperada');
    expect(Object.keys(naoCego)).not.toContain('quantidade_esperada');
  });
});

describe('buildContagemLineContent — RN-TEL-023 [INVIOLÁVEL]', () => {
  it('só contém o endereço — nenhum saldo do sistema, contagem anterior ou divergência', () => {
    const content = buildContagemLineContent({ locationCode: 'C3-001-01-01' });
    expect(content).toEqual({ endereco: 'C3-001-01-01' });
    const keys = Object.keys(content);
    expect(keys).not.toContain('saldo');
    expect(keys).not.toContain('saldo_sistema');
    expect(keys).not.toContain('contagem_anterior');
    expect(keys).not.toContain('divergencia');
  });

  it('a assinatura da função não aceita nenhum campo de saldo — a única entrada possível é o endereço', () => {
    // Prova estrutural: ContagemLineInput só declara locationCode. Se um
    // chamador futuro tentar passar saldo, o TypeScript rejeita antes do
    // teste rodar — este `it` documenta a garantia para quem só lê o arquivo
    // de teste, sem abrir o .d.ts.
    const content = buildContagemLineContent({ locationCode: 'C3-001-01-01' });
    expect(Object.keys(content)).toEqual(['endereco']);
  });
});

describe('buildReposicaoLineContent', () => {
  it('inclui origem, produto, lote, quantidade e destino', () => {
    const content = buildReposicaoLineContent({
      originLocationCode: 'D1-001-01-01',
      productDescription: 'Produto Y',
      batchSuggested: null,
      qty: 5,
      destinationLocationCode: 'D1-002-01-01',
    });
    expect(content).toEqual({
      origem: 'D1-001-01-01',
      produto: 'Produto Y',
      lote: null,
      quantidade: 5,
      destino: 'D1-002-01-01',
    });
  });
});

describe('buildCarregamentoLineContent', () => {
  it('inclui LPN e sequência n/N', () => {
    const content = buildCarregamentoLineContent({ lpn: '129000000000012346', sequence: '1/5' });
    expect(content).toEqual({ lpn: '129000000000012346', sequencia: '1/5' });
  });
});
