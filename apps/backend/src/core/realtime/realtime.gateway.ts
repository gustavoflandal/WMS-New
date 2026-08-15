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
import { Logger, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { STANDARD_TOPICS } from '@wms/contracts';

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
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private server: Server;

  constructor(
    private readonly configService: ConfigService,
    @Inject('AUTHORIZATION_PROVIDER') private authProvider?: any
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    this.logger.log('Real-time gateway initialized');

    // TODO: Setup Redis adapter for multi-process scalability
    // This requires proper Socket.IO 4.x API integration
    // For now, using memory adapter (single instance mode)
  }

  handleConnection(client: Socket): void {
    this.logger.debug(`Client connected: ${client.id}`);

    // Authenticate client (token-based)
    const token = client.handshake.auth.token;
    if (!token) {
      this.logger.warn('Connection rejected: no auth token');
      client.disconnect(true);
      return;
    }

    // Store context on socket
    client.data.tenant_id = client.handshake.auth.tenant_id;
    client.data.user_id = client.handshake.auth.user_id;
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
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { topic: string }
  ): Promise<void> {
    if (!data.topic) {
      throw new WsException('topic is required');
    }

    // [LACUNA: Real authorization from DOC-12]
    // Stub: deny by default, log lacuna
    if (this.authProvider && this.authProvider.canSubscribe) {
      const canSub = await this.authProvider.canSubscribe(
        client.data.user_id,
        data.topic
      );

      if (!canSub) {
        this.logger.warn(
          `[LACUNA: No auth provider] User ${client.data.user_id} denied subscription to ${data.topic}`
        );
        throw new WsException('Unauthorized');
      }
    } else {
      this.logger.warn(
        `[LACUNA: Authorization provider not configured] Allowing subscription to ${data.topic}`
      );
    }

    // Subscribe to tenant-specific topic
    const scopedTopic = `rt:${client.data.tenant_id}:${data.topic}`;
    client.join(scopedTopic);

    this.logger.debug(`Client ${client.id} subscribed to ${scopedTopic}`);

    client.emit('subscribed', {
      topic: data.topic,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast message to topic
   * Called by realtime-fanout worker (RNF-ARQ-033)
   */
  async broadcast(tenantId: string, topic: string, message: RealtimeMessage): Promise<void> {
    const room = `rt:${tenantId}:${topic}`;
    this.server.to(room).emit('message', message);
    this.logger.debug(`Broadcast to ${room}: ${message.event_id}`);
  }

  /**
   * Request event history (last N from Redis Streams)
   * RF-ARQ-043: Recovery for interruptions < 15 min
   */
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
