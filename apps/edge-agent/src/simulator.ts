// DOC-11 §4.1/Entregável 7 — "Implementação de referência do agent... que
// conecta, responde heartbeat e executa jobs simulados por driver — permite
// testar o ciclo completo sem hardware. Não é mock: é um agent real falando
// o protocolo real, com dispositivos simulados." Os testes de integração do
// backend importam esta classe diretamente (dependência de workspace
// `@wms/edge-agent`) e a conduzem via `setHandler()` para exercitar cada
// cenário do §6 (idempotência, PAPER_OUT, timeout de balança instável,
// etc.) sem precisar de hardware nem de um processo separado.
import { io, Socket } from 'socket.io-client';

export interface JobEnvelope {
  job_id: string;
  job_type: 'PRINT_ZPL' | 'PRINT_PDF' | 'WEIGH' | 'GATE_OPEN' | 'LPR_STATUS';
  device_code: string;
  timeout_ms: number;
  payload: Record<string, unknown>;
  issued_at: string;
}

export interface JobResponse {
  status: 'CONCLUIDO' | 'FALHA';
  result?: Record<string, unknown>;
  error_code?: 'DEVICE_OFFLINE' | 'TIMEOUT' | 'PROTOCOL_ERROR' | 'PAPER_OUT' | 'RIBBON_OUT' | 'SERIAL_UNAVAILABLE';
}

/** `undefined`/`{ noResponse: true }` simula um agent que nunca responde (o watchdog de timeout do backend deve cobrir isso — RNF-PER-002). */
export type JobHandler = (envelope: JobEnvelope) => Promise<JobResponse | { noResponse: true }> | JobResponse | { noResponse: true };

export interface EdgeAgentSimulatorOptions {
  backendUrl: string;
  token: string;
  heartbeatIntervalMs?: number;
  telemetryIntervalMs?: number;
  devices?: Array<{ deviceCode: string; status: 'ONLINE' | 'OFFLINE' | 'ERRO' | 'MANUTENCAO' }>;
}

function defaultHandler(envelope: JobEnvelope): JobResponse {
  switch (envelope.job_type) {
    case 'PRINT_ZPL':
    case 'PRINT_PDF':
      return { status: 'CONCLUIDO', result: { printed: true } };
    case 'WEIGH':
      return {
        status: 'CONCLUIDO',
        result: { weight_kg: 12.345, unit: 'kg', stable: true, device_code: envelope.device_code, raw_frame: 'STX+012345kgETX' },
      };
    case 'GATE_OPEN':
      return { status: 'CONCLUIDO', result: { opened: true } };
    case 'LPR_STATUS':
      return { status: 'CONCLUIDO', result: { status: 'ONLINE' } };
  }
}

export class EdgeAgentSimulator {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private readonly handlers = new Map<string, JobHandler>();
  // RG-009/RNF-PER-002: memória de jobs já executados — reenvio do MESMO
  // job_id responde o resultado original, SEM chamar o handler de novo (é
  // isto que garante "nenhuma segunda etiqueta impressa" no Gherkin §6).
  private readonly completedJobs = new Map<string, JobResponse>();
  public readonly receivedJobs: JobEnvelope[] = [];

  constructor(private readonly options: EdgeAgentSimulatorOptions) {}

  /** Handler por device_code — sobrepõe o default (`defaultHandler`) só para aquele dispositivo. */
  setHandler(deviceCode: string, handler: JobHandler): void {
    this.handlers.set(deviceCode, handler);
  }

  clearHandler(deviceCode: string): void {
    this.handlers.delete(deviceCode);
  }

  /** Quantas vezes um job_id específico chegou a EXECUTAR o handler (não conta respostas por cache de idempotência). */
  executionCountFor(jobId: string): number {
    return this.receivedJobs.filter((j) => j.job_id === jobId).length;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(`${this.options.backendUrl}/edge-agent`, {
        auth: { token: this.options.token },
        transports: ['websocket'],
        reconnection: true,
      });

      this.socket.on('connect_error', (err) => reject(err));
      this.socket.on('connected', () => {
        this.startHeartbeat();
        this.startTelemetry();
        resolve();
      });

      this.socket.on('job', (envelope: JobEnvelope) => {
        void this.handleJob(envelope);
      });
    });
  }

  private async handleJob(envelope: JobEnvelope): Promise<void> {
    // RG-009/RNF-PER-002: só um job que já terminou CONCLUIDO é idempotente
    // no reenvio ("agent que já executou responde o resultado original,
    // sem segunda impressão"). Um job que terminou FALHA e foi reenviado
    // pelo próprio mecanismo de retry assimétrico (§5.1 — MESMO job_id,
    // estado volta a PENDENTE/ENVIADO) é uma tentativa física NOVA (ex.:
    // papel recolocado) — não deve ser respondido do cache, senão o retry
    // nunca teria efeito nenhum.
    const cached = this.completedJobs.get(envelope.job_id);
    if (cached) {
      this.socket?.emit('job_result', { job_id: envelope.job_id, ...cached });
      return;
    }

    this.receivedJobs.push(envelope);
    const handler = this.handlers.get(envelope.device_code) ?? defaultHandler;
    const response = await handler(envelope);

    if ('noResponse' in response) {
      return; // simula agent/dispositivo que nunca responde (watchdog de timeout do backend cobre isto)
    }

    if (response.status === 'CONCLUIDO') {
      this.completedJobs.set(envelope.job_id, response);
    }
    this.socket?.emit('job_result', { job_id: envelope.job_id, ...response });
  }

  /** RNF-PER-060: empurra uma leitura LPR normalizada (push do driver da câmera simulado). */
  pushLprReading(reading: { device_code: string; plate: string; confidence: number; lane?: string; captured_at: string; image_ref?: string }): void {
    this.socket?.emit('lpr_reading', reading);
  }

  /** RNF-PER-003: força o envio de telemetria fora do ciclo automático (útil para testar transição OFFLINE/ERRO). */
  sendTelemetry(deviceCode: string, status: 'ONLINE' | 'OFFLINE' | 'ERRO' | 'MANUTENCAO', detail?: string): void {
    this.socket?.emit('telemetry', { device_code: deviceCode, status, detail });
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatIntervalMs ?? 15000;
    this.heartbeatTimer = setInterval(() => this.socket?.emit('heartbeat', {}), interval);
  }

  private startTelemetry(): void {
    const interval = this.options.telemetryIntervalMs ?? 60000;
    const devices = this.options.devices ?? [];
    if (devices.length === 0) return;
    this.telemetryTimer = setInterval(() => {
      for (const device of devices) {
        this.socket?.emit('telemetry', { device_code: device.deviceCode, status: device.status });
      }
    }, interval);
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.socket?.disconnect();
    this.socket = null;
  }

  get connected(): boolean {
    return !!this.socket?.connected;
  }
}
