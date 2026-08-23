// DOC-11 RNF-PER-001/002 — registro de conexões WebSocket outbound ativas
// de Edge Agents. Serviço standalone (sem dependência do gateway) para
// quebrar o ciclo Gateway <-> PeripheralJobService: o Gateway REGISTRA
// conexões aqui; PeripheralJobService ENVIA através daqui, sem conhecer o
// Gateway.
import { Injectable, Logger } from '@nestjs/common';

export interface AgentSocketLike {
  connected: boolean;
  emit(event: string, payload: unknown): void;
}

@Injectable()
export class EdgeAgentConnectionRegistry {
  private readonly logger = new Logger(EdgeAgentConnectionRegistry.name);
  private readonly sockets = new Map<string, AgentSocketLike>();

  register(edgeAgentId: string, socket: AgentSocketLike): void {
    this.sockets.set(edgeAgentId, socket);
  }

  unregister(edgeAgentId: string): void {
    this.sockets.delete(edgeAgentId);
  }

  isOnline(edgeAgentId: string): boolean {
    const socket = this.sockets.get(edgeAgentId);
    return !!socket?.connected;
  }

  /** RNF-PER-002: envia o envelope de job ao agent. Retorna false se não há conexão ativa (chamador decide: fila/erro). */
  send(edgeAgentId: string, event: string, payload: unknown): boolean {
    const socket = this.sockets.get(edgeAgentId);
    if (!socket?.connected) {
      this.logger.debug(`Agent ${edgeAgentId} not connected — cannot send ${event}`);
      return false;
    }
    socket.emit(event, payload);
    return true;
  }
}
