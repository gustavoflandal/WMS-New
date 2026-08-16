// DOC-03 RN-POR-021 — exemplo normativo do documento (valor de regressão
// permanente, não alterar): pesos padrão P1=4 P2=3 P3=2 P4=8; veículo A
// (no horário, perecível) = 7; veículo B (fora da janela, hazmat) = 2;
// veículo C (no horário, prioridade manual) = 12. Ordem: C, A, B.
import { computeYardQueueScore, DEFAULT_YARD_QUEUE_WEIGHTS } from '../yard-queue-scoring.util.js';

describe('computeYardQueueScore - DOC-03 RN-POR-021', () => {
  it('exemplo normativo: veículo A (no horário, perecível) = 7', () => {
    const result = computeYardQueueScore({ onSchedule: true, perishable: true, hazmat: false, manualPriority: false }, DEFAULT_YARD_QUEUE_WEIGHTS);
    expect(result.score).toBe(7);
  });

  it('exemplo normativo: veículo B (fora da janela, hazmat) = 2', () => {
    const result = computeYardQueueScore({ onSchedule: false, perishable: false, hazmat: true, manualPriority: false }, DEFAULT_YARD_QUEUE_WEIGHTS);
    expect(result.score).toBe(2);
  });

  it('exemplo normativo: veículo C (no horário, prioridade manual) = 12', () => {
    const result = computeYardQueueScore({ onSchedule: true, perishable: false, hazmat: false, manualPriority: true }, DEFAULT_YARD_QUEUE_WEIGHTS);
    expect(result.score).toBe(12);
  });

  it('ordem determinística C > A > B com os 3 exemplos normativos juntos', () => {
    const a = computeYardQueueScore({ onSchedule: true, perishable: true, hazmat: false, manualPriority: false }, DEFAULT_YARD_QUEUE_WEIGHTS);
    const b = computeYardQueueScore({ onSchedule: false, perishable: false, hazmat: true, manualPriority: false }, DEFAULT_YARD_QUEUE_WEIGHTS);
    const c = computeYardQueueScore({ onSchedule: true, perishable: false, hazmat: false, manualPriority: true }, DEFAULT_YARD_QUEUE_WEIGHTS);
    const ordered = [c, a, b].map((r) => r.score);
    expect(ordered).toEqual([...ordered].sort((x, y) => y - x));
    expect(c.score).toBeGreaterThan(a.score);
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('componentes individuais são persistíveis (não apenas o total)', () => {
    const result = computeYardQueueScore({ onSchedule: true, perishable: true, hazmat: true, manualPriority: true }, DEFAULT_YARD_QUEUE_WEIGHTS);
    expect(result.scoreNoHorario).toBe(4);
    expect(result.scorePerecivel).toBe(3);
    expect(result.scoreHazmat).toBe(2);
    expect(result.scorePrioridadeManual).toBe(8);
    expect(result.score).toBe(17);
  });

  it('zero em todos os componentes quando nada se aplica', () => {
    const result = computeYardQueueScore({ onSchedule: false, perishable: false, hazmat: false, manualPriority: false }, DEFAULT_YARD_QUEUE_WEIGHTS);
    expect(result.score).toBe(0);
  });

  it('respeita pesos customizados por armazém (não apenas o padrão)', () => {
    const result = computeYardQueueScore({ onSchedule: true, perishable: false, hazmat: false, manualPriority: false }, { p1: 100, p2: 1, p3: 1, p4: 1 });
    expect(result.score).toBe(100);
  });
});
