// DOC-08 §4.7 — simulador de referência da SEFAZ, mesmo espírito do
// simulador do Edge Agent (DOC-11/Sessão 8): não é mock de framework, é um
// adaptador real que implementa a MESMA interface (SefazClientPort) da
// produção, só que responde deterministicamente em vez de bater na rede.
// É o que os testes de integração REAIS usam — e o que `docker-compose`
// usa por padrão neste ambiente, que não tem acesso à SEFAZ nem em
// homologação (DOC-08 §4.7/prompt da 8B, seção "Simulador de SEFAZ").
import { Injectable } from '@nestjs/common';
import { SefazClientPort, SefazTransmitInput, SefazTransmitResult } from './sefaz-client.port.js';

export interface ForcedSefazResponse {
  cStat: number;
  cStatMessage: string;
  /** Atraso simulado (ms) antes de responder — para testar timeout/contingência. */
  delayMs?: number;
  /** Lança erro de transporte em vez de responder (indisponibilidade real). */
  throwTransportError?: boolean;
}

const HAPPY_PATH: ForcedSefazResponse = { cStat: 100, cStatMessage: 'Autorizado o uso da NF-e' };

@Injectable()
export class SefazSimulatorAdapter implements SefazClientPort {
  /**
   * Respostas forçadas por chave arbitrária definida pelo teste (ex.: chave
   * de acesso ou nfe_number extraído do envelope). Fila FIFO por chave —
   * cada chamada consome a próxima resposta enfileirada; sem entrada
   * configurada, cai no caminho feliz (cStat 100).
   */
  private readonly queues = new Map<string, ForcedSefazResponse[]>();
  private availability = new Map<string, boolean>();

  /** Usado pelos testes para configurar o próximo (ou os próximos N) retorno(s) para uma chave. */
  configureResponse(key: string, responses: ForcedSefazResponse | ForcedSefazResponse[]): void {
    const list = Array.isArray(responses) ? responses : [responses];
    this.queues.set(key, [...(this.queues.get(key) ?? []), ...list]);
  }

  configureAvailability(uf: string, available: boolean): void {
    this.availability.set(uf, available);
  }

  reset(): void {
    this.queues.clear();
    this.availability.clear();
  }

  async transmit(input: SefazTransmitInput): Promise<SefazTransmitResult> {
    const key = extractSimulatorKey(input.envelopeXml);
    const queue = this.queues.get(key);
    const forced = queue && queue.length > 0 ? queue.shift() : undefined;
    const response = forced ?? HAPPY_PATH;

    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }
    if (response.throwTransportError) {
      throw new Error(`SefazSimulatorAdapter: falha de transporte simulada para ${key}`);
    }

    return {
      cStat: response.cStat,
      cStatMessage: response.cStatMessage,
      protocolNumber: response.cStat === 100 ? `SIM-${Date.now()}` : null,
      authorizedAt: response.cStat === 100 ? new Date() : null,
    };
  }

  async checkAvailability(uf: string): Promise<boolean> {
    return this.availability.get(uf) ?? true;
  }
}

/** A chave do simulador viaja no envelope como `<simKey>...</simKey>` (ver nfe-xml-builder.util.ts). */
export function extractSimulatorKey(envelopeXml: string): string {
  const match = /<simKey>([^<]*)<\/simKey>/.exec(envelopeXml);
  return match ? match[1] : 'default';
}
