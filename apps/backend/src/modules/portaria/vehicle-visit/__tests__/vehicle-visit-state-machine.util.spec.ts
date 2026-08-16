// DOC-03 §5.1 — máquina de estados de vehicle_visit: prova que transições
// não previstas no diagrama são rejeitadas com erro determinístico, e que
// todas as transições da tabela do documento resolvem corretamente.
import {
  resolveVehicleVisitTransition,
  InvalidVehicleVisitTransitionError,
  VehicleVisitStatus,
} from '../vehicle-visit-state-machine.util.js';

describe('resolveVehicleVisitTransition - DOC-03 §5.1', () => {
  it('CHEGADA_REGISTRADA + GATE_IN_OK -> NO_PATIO', () => {
    expect(resolveVehicleVisitTransition('CHEGADA_REGISTRADA', 'GATE_IN_OK')).toBe('NO_PATIO');
  });

  it('CHEGADA_REGISTRADA + BLOQUEIO_AUTORIZACAO -> AGUARDANDO_AUTORIZACAO', () => {
    expect(resolveVehicleVisitTransition('CHEGADA_REGISTRADA', 'BLOQUEIO_AUTORIZACAO')).toBe('AGUARDANDO_AUTORIZACAO');
  });

  it('AGUARDANDO_AUTORIZACAO + EXCECAO_APROVADA -> NO_PATIO', () => {
    expect(resolveVehicleVisitTransition('AGUARDANDO_AUTORIZACAO', 'EXCECAO_APROVADA')).toBe('NO_PATIO');
  });

  it('AGUARDANDO_AUTORIZACAO + EXCECAO_REJEITADA_OU_EXPIRADA -> RECUSADO', () => {
    expect(resolveVehicleVisitTransition('AGUARDANDO_AUTORIZACAO', 'EXCECAO_REJEITADA_OU_EXPIRADA')).toBe('RECUSADO');
  });

  it('NO_PATIO + CHAMADA_CONFIRMADA -> EM_DESLOCAMENTO_DOCA', () => {
    expect(resolveVehicleVisitTransition('NO_PATIO', 'CHAMADA_CONFIRMADA')).toBe('EM_DESLOCAMENTO_DOCA');
  });

  it('EM_DESLOCAMENTO_DOCA + ATRACACAO_REGISTRADA -> EM_DOCA', () => {
    expect(resolveVehicleVisitTransition('EM_DESLOCAMENTO_DOCA', 'ATRACACAO_REGISTRADA')).toBe('EM_DOCA');
  });

  it('EM_DOCA + RETORNO_PATIO -> NO_PATIO', () => {
    expect(resolveVehicleVisitTransition('EM_DOCA', 'RETORNO_PATIO')).toBe('NO_PATIO');
  });

  it('EM_DOCA + OPERACAO_DOCA_CONCLUIDA -> LIBERADO_SAIDA', () => {
    expect(resolveVehicleVisitTransition('EM_DOCA', 'OPERACAO_DOCA_CONCLUIDA')).toBe('LIBERADO_SAIDA');
  });

  it('NO_PATIO + LIBERACAO_SEM_DOCA -> LIBERADO_SAIDA', () => {
    expect(resolveVehicleVisitTransition('NO_PATIO', 'LIBERACAO_SEM_DOCA')).toBe('LIBERADO_SAIDA');
  });

  it('LIBERADO_SAIDA + GATE_OUT -> ENCERRADA', () => {
    expect(resolveVehicleVisitTransition('LIBERADO_SAIDA', 'GATE_OUT')).toBe('ENCERRADA');
  });

  it('rejeita transição não prevista no diagrama com erro determinístico (não implementa setStatus livre)', () => {
    expect(() => resolveVehicleVisitTransition('ENCERRADA', 'GATE_IN_OK')).toThrow(InvalidVehicleVisitTransitionError);
    expect(() => resolveVehicleVisitTransition('CHEGADA_REGISTRADA', 'GATE_OUT')).toThrow(InvalidVehicleVisitTransitionError);
    expect(() => resolveVehicleVisitTransition('NO_PATIO', 'ATRACACAO_REGISTRADA')).toThrow(InvalidVehicleVisitTransitionError);
  });

  it('estados terminais (RECUSADO, ENCERRADA) não aceitam nenhum evento', () => {
    const terminalStates: VehicleVisitStatus[] = ['RECUSADO', 'ENCERRADA'];
    const allEvents = ['BLOQUEIO_AUTORIZACAO', 'GATE_IN_OK', 'EXCECAO_APROVADA', 'CHAMADA_CONFIRMADA', 'GATE_OUT'] as const;
    for (const state of terminalStates) {
      for (const event of allEvents) {
        expect(() => resolveVehicleVisitTransition(state, event)).toThrow(InvalidVehicleVisitTransitionError);
      }
    }
  });
});
