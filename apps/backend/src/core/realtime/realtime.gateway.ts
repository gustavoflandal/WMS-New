// RF-ARQ-040..043: Real-time gateway with Socket.IO
// WebSocket with Redis adapter, fallback to SSE
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WsException,
} from '@nestjs/websockets';
import { Logger, Inject, BadRequestException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import { STANDARD_TOPICS } from '@wms/contracts';
import { JwtService } from '../auth/jwt.service.js';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator.js';

// RF-ARQ-041: Standard topic catalog — re-exported for existing importers.
export { STANDARD_TOPICS };

export interface RealtimeMessage {
  topic: string;
  event_id: string;
  data: Record<string, any>;
  timestamp: string;
}

@WebSocketGateway({
  namespace: '/realtime',
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private server: Server;
  private fanoutSubscriber?: RedisClientType;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject('AUTHORIZATION_PROVIDER') private authProvider?: any
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.logger.log('Real-time gateway initialized');

    // TODO: Setup Redis adapter for multi-process scalability
    // This requires proper Socket.IO 4.x API integration
    // For now, using memory adapter (single instance mode)

    // DOC-10 RF-PAI-003 (achado desta sessão): nada no código assinava os
    // canais Pub/Sub que realtime-fanout.worker.impl.ts publica — broadcast()
    // existia mas nunca era chamado, então nenhum evento chegava de fato a
    // um cliente WebSocket real (só aos testes que assinam o Redis cru
    // diretamente, mesmo padrão da 1.5). PSUBSCRIBE em 'rt:*': o nome do
    // canal Pub/Sub JÁ É o nome da room Socket.IO (mesmo formato de 3
    // segmentos usado em handleSubscribe, corrigido abaixo) — repassa
    // literalmente, sem re-derivar tenant/tópico.
    void this.subscribeToFanout();
  }

  private async subscribeToFanout(): Promise<void> {
    const redisUrl = this.configService.get('REDIS_URL', 'redis://localhost:6379/0');
    this.fanoutSubscriber = createClient({ url: redisUrl });
    this.fanoutSubscriber.on('error', (err) => this.logger.error('Fanout subscriber error', err));
    await this.fanoutSubscriber.connect();
    await this.fanoutSubscriber.pSubscribe('rt:*', (message, channel) => {
      try {
        this.server.to(channel).emit('message', JSON.parse(message));
      } catch (error) {
        this.logger.warn(`Failed to forward message on ${channel}: ${(error as Error).message}`);
      }
    });
    this.logger.log('Subscribed to fanout channel pattern rt:*');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.fanoutSubscriber?.isOpen) {
      await this.fanoutSubscriber.quit();
    }
  }

  handleConnection(client: Socket): void {
    this.logger.debug(`Client connected: ${client.id}`);

    // DOC-12: substitui a checagem "token truthy" por verificação real do
    // JWT (mesmo emissor/segredo usado pelo REST — jwt.service.ts).
    const token = client.handshake.auth.token;
    if (!token) {
      this.logger.warn('Connection rejected: no auth token');
      client.disconnect(true);
      return;
    }

    let claims;
    try {
      claims = this.jwtService.verifyAccessToken(token);
    } catch {
      this.logger.warn('Connection rejected: invalid or expired token');
      client.disconnect(true);
      return;
    }

    // Store context on socket — user_id vem do token verificado, não mais
    // de um valor arbitrário enviado pelo cliente. tenant_id/warehouse_id
    // continuam vindo do handshake (RD-SEG-061: WS não tem RLS própria; a
    // checagem de permissão por tópico — agora escopo WAREHOUSE,
    // SEG.REALTIME_SUBSCRIBE/RESYNC — é feita em
    // canSubscribe/RealtimeAuthorizationProvider, usando este warehouse_id).
    client.data.tenant_id = client.handshake.auth.tenant_id;
    client.data.warehouse_id = client.handshake.auth.warehouse_id;
    client.data.user_id = claims.sub;
    client.data.authenticated_at = new Date();

    // Send connection success
    client.emit('connected', {
      client_id: client.id,
      server_time: new Date().toISOString(),
    });

    // Heartbeat every 15 seconds (RNF-ARQ-061)
    const heartbeatInterval = setInterval(() => {
      if (client.connected) {
        client.emit('heartbeat', { timestamp: new Date().toISOString() });
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 15000);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Subscribe to topic with authorization
   * RF-ARQ-041: Standard topics registered as constants
   */
  @RequirePermission('SEG.REALTIME_SUBSCRIBE')
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { topic: string }
  ): Promise<void> {
    if (!data.topic) {
      throw new WsException('topic is required');
    }

    // DOC-12 RN-SEG-012: deny por omissão — AUTHORIZATION_PROVIDER é
    // sempre RealtimeAuthorizationProvider (real RBAC), nunca mais `null`.
    const canSub = await this.authProvider.canSubscribe(client.data.user_id, data.topic, client.data.warehouse_id);
    if (!canSub) {
      this.logger.warn(`User ${client.data.user_id} denied subscription to ${data.topic} (SEG.REALTIME_SUBSCRIBE)`);
      throw new WsException('Unauthorized');
    }

    // Room key DEVE bater exatamente com o canal Pub/Sub publicado por
    // realtime-fanout.worker.impl.ts (rt:{tenant}:{warehouse}:{topico}) —
    // achado desta sessão: esta linha usava só 2 segmentos
    // (rt:{tenant}:{topico}), então nenhuma mensagem do fanout jamais
    // alcançava um cliente WebSocket real (ver subscribeToFanout() acima).
    const tenantSegment = client.data.tenant_id || 'global';
    const warehouseSegment = client.data.warehouse_id || 'global';
    const scopedTopic = `rt:${tenantSegment}:${warehouseSegment}:${data.topic}`;
    client.join(scopedTopic);

    this.logger.debug(`Client ${client.id} subscribed to ${scopedTopic}`);

    client.emit('subscribed', {
      topic: data.topic,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast message to topic. Not called by the fanout worker anymore —
   * subscribeToFanout() above forwards Pub/Sub messages directly by channel
   * name (no re-derivation needed, worker and gateway agree on the format).
   * Kept as a direct-call API for anything that wants to push to a room
   * without going through Redis Pub/Sub; room key format kept consistent
   * with subscribeToFanout()/handleSubscribe() (3 segments).
   */
  async broadcast(tenantId: string, warehouseId: string, topic: string, message: RealtimeMessage): Promise<void> {
    const room = `rt:${tenantId}:${warehouseId}:${topic}`;
    this.server.to(room).emit('message', message);
    this.logger.debug(`Broadcast to ${room}: ${message.event_id}`);
  }

  /**
   * Request event history (last N from Redis Streams)
   * RF-ARQ-043: Recovery for interruptions < 15 min
   */
  @RequirePermission('SEG.REALTIME_RESYNC')
  @SubscribeMessage('resync')
  async handleResync(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { topic: string }
  ): Promise<void> {
    // [LACUNA: Redis Streams XREADGROUP implementation - Session 1.5]
    this.logger.debug(`Resync requested for topic ${data.topic}`);

    client.emit('resync_response', {
      topic: data.topic,
      events: [],  // Placeholder
      timestamp: new Date().toISOString(),
    });
  }
}
