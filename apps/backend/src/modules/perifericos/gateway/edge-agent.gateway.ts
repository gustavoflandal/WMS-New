// DOC-11 RNF-PER-001/002/003 [INVIOLÁVEL] — WebSocket OUTBOUND do Edge
// Agent (o agent conecta NELE, não o contrário). Namespace próprio
// ('/edge-agent'), autenticação por TOKEN DE DISPOSITIVO (hash em
// wms.edge_agent), nunca JWT de usuário — RG-008: navegador nunca fala com
// hardware; é o AGENT (processo de rede local do armazém) quem fala com o
// backend, e só o backend fala com o navegador (REST/`/realtime`).
import { WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Public } from '../../../core/rbac/decorators/public.decorator.js';
import { Socket } from 'socket.io';
import { EdgeAgentAdminService } from '../devices/edge-agent-admin.service.js';
import { EdgeAgentConnectionRegistry } from './edge-agent-connection.registry.js';
import { PeripheralJobService, PeripheralErrorCode } from '../jobs/peripheral-job.service.js';
import { PeripheralDeviceService } from '../devices/peripheral-device.service.js';
import { LprService } from '../lpr/lpr.service.js';
import { EventsService } from '../../../core/events/events.service.js';
import { DatabaseService } from '../../../core/database/database.service.js';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000001';

interface JobResultMessage {
  job_id: string;
  status: 'EXECUTANDO' | 'CONCLUIDO' | 'FALHA';
  result?: Record<string, unknown>;
  error_code?: PeripheralErrorCode;
}

interface TelemetryMessage {
  device_code: string;
  status: 'ONLINE' | 'OFFLINE' | 'ERRO' | 'MANUTENCAO';
  detail?: string;
}

interface LprPushMessage {
  device_code: string;
  plate: string;
  confidence: number;
  lane?: string;
  captured_at: string;
  image_ref?: string;
}

@WebSocketGateway({
  namespace: '/edge-agent',
  cors: { origin: '*' }, // agents rodam em rede local do armazém, não em navegador (RG-008) — sem origem de browser a restringir.
})
export class EdgeAgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EdgeAgentGateway.name);

  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(EdgeAgentAdminService) private readonly edgeAgentAdminService: EdgeAgentAdminService,
    @Inject(EdgeAgentConnectionRegistry) private readonly registry: EdgeAgentConnectionRegistry,
    @Inject(PeripheralJobService) private readonly peripheralJobService: PeripheralJobService,
    @Inject(PeripheralDeviceService) private readonly peripheralDeviceService: PeripheralDeviceService,
    @Inject(LprService) private readonly lprService: LprService,
    @Inject(EventsService) private readonly eventsService: EventsService,
    @Inject(DatabaseService) private readonly db: DatabaseService
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      this.logger.warn('Edge Agent connection rejected: no device token');
      client.disconnect(true);
      return;
    }

    const auth = await this.edgeAgentAdminService.authenticate(token);
    if (!auth) {
      this.logger.warn('Edge Agent connection rejected: invalid device token');
      client.disconnect(true);
      return;
    }

    client.data.edgeAgentId = auth.edgeAgentId;
    client.data.warehouseId = auth.warehouseId;

    this.registry.register(auth.edgeAgentId, client);
    await this.edgeAgentAdminService.setStatus(auth.edgeAgentId, 'ONLINE', SYSTEM_ACTOR);
    await this.publishAgentConnectionEvent(auth.edgeAgentId, auth.warehouseId, 'perifericos.agent_online');

    this.logger.log(`Edge Agent ${auth.edgeAgentId} connected (warehouse ${auth.warehouseId})`);

    // RF-PER-021: "ao reconectar o agent devem ser executados na ordem".
    await this.peripheralJobService.dispatchPendingForAgent(auth.edgeAgentId);

    client.emit('connected', { edge_agent_id: auth.edgeAgentId, server_time: new Date().toISOString() });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const edgeAgentId = client.data.edgeAgentId as string | undefined;
    if (!edgeAgentId) return;

    this.registry.unregister(edgeAgentId);
    await this.edgeAgentAdminService.setStatus(edgeAgentId, 'OFFLINE', SYSTEM_ACTOR);
    await this.publishAgentConnectionEvent(edgeAgentId, client.data.warehouseId, 'perifericos.agent_offline');
    this.logger.log(`Edge Agent ${edgeAgentId} disconnected`);
  }

  /**
   * RNF-PER-001: heartbeat a cada 15s (2 perdidos = OFFLINE — detectado
   * pelo watchdog do worker, não aqui). @Public(): este gateway não usa
   * RBAC/JWT de usuário — a autenticação é o token de dispositivo verificado
   * em handleConnection(); todo handler de mensagem subsequente confia na
   * conexão já autenticada (client.data.edgeAgentId), não em uma permissão
   * de usuário (RG-008: Edge Agent é ator técnico, não usuário do sistema).
   */
  @Public()
  @SubscribeMessage('heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket): Promise<void> {
    const edgeAgentId = client.data.edgeAgentId as string | undefined;
    if (!edgeAgentId) return;
    await this.edgeAgentAdminService.touchHeartbeat(edgeAgentId);
  }

  /** RNF-PER-003: telemetria por dispositivo a cada 60s. @Public(): ver nota em handleHeartbeat(). */
  @Public()
  @SubscribeMessage('telemetry')
  async handleTelemetry(@ConnectedSocket() client: Socket, @MessageBody() data: TelemetryMessage): Promise<void> {
    const warehouseId = client.data.warehouseId as string | undefined;
    if (!warehouseId) return;

    const previous = await this.peripheralDeviceService.findByCode(data.device_code).catch(() => null);
    const updated = await this.peripheralDeviceService.applyTelemetry(data.device_code, data.status, data.detail ?? null);
    if (!updated) return;

    const enteringErrorState = previous && previous.status !== data.status && (data.status === 'ERRO' || data.status === 'OFFLINE');
    if (enteringErrorState) {
      await this.db.transactionAsWorker(async (client2) => {
        await this.eventsService.publishInTransaction(client2, {
          event_type: 'perifericos.dispositivo_erro',
          tenant_id: null,
          warehouse_id: warehouseId,
          payload: { peripheral_device_id: updated.id, device_code: data.device_code, status: data.status, detail: data.detail ?? null },
        });
      });
    }
  }

  /** RNF-PER-002: resposta do agent a um job — estados EXECUTANDO/CONCLUIDO/FALHA. @Public(): ver nota em handleHeartbeat(). */
  @Public()
  @SubscribeMessage('job_result')
  async handleJobResult(@MessageBody() data: JobResultMessage): Promise<void> {
    await this.peripheralJobService.applyAgentResult({
      jobId: data.job_id,
      status: data.status,
      result: data.result,
      errorCode: data.error_code,
    });
  }

  /** RNF-PER-060: leitura LPR normalizada, empurrada pelo agent (push HTTP local à câmera OU polling — transparente aqui). @Public(): ver nota em handleHeartbeat(). */
  @Public()
  @SubscribeMessage('lpr_reading')
  async handleLprReading(@ConnectedSocket() client: Socket, @MessageBody() data: LprPushMessage): Promise<void> {
    const warehouseId = client.data.warehouseId as string | undefined;
    if (!warehouseId) return;
    const device = await this.peripheralDeviceService.findByCode(data.device_code).catch(() => null);
    if (!device) {
      this.logger.warn(`LPR reading from unknown device_code ${data.device_code}`);
      return;
    }
    await this.lprService.receiveReading({
      warehouseId,
      peripheralDeviceId: device.id,
      plate: data.plate,
      confidence: data.confidence,
      lane: data.lane ?? null,
      capturedAt: data.captured_at,
      imageRef: data.image_ref ?? null,
    });
  }

  private async publishAgentConnectionEvent(edgeAgentId: string, warehouseId: string, eventType: 'perifericos.agent_online' | 'perifericos.agent_offline'): Promise<void> {
    await this.db.transactionAsWorker(async (client) => {
      await this.eventsService.publishInTransaction(client, {
        event_type: eventType,
        tenant_id: null,
        warehouse_id: warehouseId,
        payload: { edge_agent_id: edgeAgentId },
      });
    });
  }
}
