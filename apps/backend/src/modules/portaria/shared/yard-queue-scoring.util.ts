// DOC-03 RN-POR-021 [regra determinística] — pontuação da fila de pátio.
// prioridade = P1*no_horario + P2*perecivel + P3*hazmat + P4*prioridade_manual
// Função pura (sem I/O) para poder ser testada isoladamente com o exemplo
// normativo do documento (valor de regressão permanente — não alterar).
export interface YardQueueScoringWeights {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
}

export interface YardQueueScoringInput {
  onSchedule: boolean; // no_horario
  perishable: boolean; // perecivel
  hazmat: boolean; // hazmat
  manualPriority: boolean; // prioridade_manual
}

export interface YardQueueScoringResult {
  score: number;
  scoreNoHorario: number;
  scorePerecivel: number;
  scoreHazmat: number;
  scorePrioridadeManual: number;
}

export const DEFAULT_YARD_QUEUE_WEIGHTS: YardQueueScoringWeights = { p1: 4, p2: 3, p3: 2, p4: 8 };

export function computeYardQueueScore(input: YardQueueScoringInput, weights: YardQueueScoringWeights): YardQueueScoringResult {
  const scoreNoHorario = input.onSchedule ? weights.p1 : 0;
  const scorePerecivel = input.perishable ? weights.p2 : 0;
  const scoreHazmat = input.hazmat ? weights.p3 : 0;
  const scorePrioridadeManual = input.manualPriority ? weights.p4 : 0;

  return {
    score: scoreNoHorario + scorePerecivel + scoreHazmat + scorePrioridadeManual,
    scoreNoHorario,
    scorePerecivel,
    scoreHazmat,
    scorePrioridadeManual,
  };
}
