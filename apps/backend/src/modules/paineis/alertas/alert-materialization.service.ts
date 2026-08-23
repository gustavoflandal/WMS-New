// DOC-10 §4.2 RF-PAI-010 — consolida eventos de domínio já existentes em
// wms.alert. Fontes com sinal EVENT-DRIVEN limpo nesta base (as demais —
// Edge Agent offline, transbordo de armazém lógico, falha de integração —
// não têm nenhum serviço real emitindo o sinal ainda: DOC-11/DOC-13 são
// stubs, "armazém lógico transbordo pendente de retorno" não tem estado
// modelado em nenhum DOC implementado. [LACUNA] explícita, não fórmula
// adaptada — o catálogo (migration 0055) já tem os 3 tipos prontos para o
// dia em que esses módulos existirem).
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AlertService, AlertType } from './alert.service.js';

export interface AlertDomainEvent {
  event_id: string;
  event_type: string;
  tenant_id: string | null;
  warehouse_id: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class AlertMaterializationService {
  constructor(
    @Inject(AlertService) private readonly alertService: AlertService,
    @Inject(DatabaseService) private readonly db: DatabaseService
  ) {}

  async applyEvent(event: AlertDomainEvent): Promise<void> {
    switch (event.event_type) {
      case 'seguranca.excecao_criada':
      case 'seguranca.excecao_escalada':
        await this.alertService.create({
          tenantId: event.tenant_id,
          warehouseId: event.warehouse_id,
          severity: event.payload.status === 'ESCALATED' ? 'CRIT' : 'WARN',
          alertType: 'EXCECAO_AGUARDANDO',
          title: `Exceção ${event.payload.exception_type} aguardando decisão`,
          sourceEntity: 'operational_exception',
          sourceEntityId: String(event.payload.exception_id),
          sourceEventId: event.event_id,
        });
        return;

      case 'seguranca.excecao_aprovada':
      case 'seguranca.excecao_rejeitada':
        await this.alertService.resolveByOrigin('EXCECAO_AGUARDANDO', 'operational_exception', String(event.payload.exception_id));
        return;

      case 'estoque.lote_a_vencer':
        await this.alertService.create({
          tenantId: event.tenant_id,
          warehouseId: event.warehouse_id,
          severity: 'WARN',
          alertType: 'LOTE_A_VENCER',
          title: 'Lote a vencer',
          message: `Validade ${event.payload.expiration_date}`,
          sourceEntity: 'batch',
          sourceEntityId: String(event.payload.batch_id),
          sourceEventId: event.event_id,
        });
        return;

      case 'estoque.lote_vencido_bloqueado':
        // RN-EST-014: o lote que venceu sai da condição "a vencer" — resolve o WARN anterior antes de abrir o CRIT.
        await this.alertService.resolveByOrigin('LOTE_A_VENCER', 'batch', String(event.payload.batch_id));
        await this.alertService.create({
          tenantId: event.tenant_id,
          warehouseId: event.warehouse_id,
          severity: 'CRIT',
          alertType: 'LOTE_VENCIDO',
          title: 'Lote vencido e bloqueado automaticamente',
          sourceEntity: 'batch',
          sourceEntityId: String(event.payload.batch_id),
          sourceEventId: event.event_id,
        });
        return;

      case 'estoque.estoque_seguranca_violado':
        // [DÉBITO: 7A] nenhum evento "estoque_seguranca_restaurado" existe
        // nesta base (ReplenishmentAlertWorkerImpl só detecta violação, não
        // publica recuperação) — resolução automática (§5.2) não é possível
        // por evento hoje; alerta fica aberto até resolução manual (rota
        // genérica de resolve) ou sessão-alvo que adicionar esse evento.
        await this.alertService.create({
          tenantId: event.tenant_id,
          warehouseId: event.warehouse_id,
          severity: 'WARN',
          alertType: 'ESTOQUE_SEGURANCA_VIOLADO',
          title: 'Estoque de segurança violado',
          message: `Disponível ${event.payload.available_total} < mínimo ${event.payload.safety_stock_qty}`,
          sourceEntity: 'product',
          sourceEntityId: String(event.payload.product_id),
          sourceEventId: event.event_id,
        });
        return;

      case 'recebimento.crossdock_tempo_excedido':
        await this.alertService.create({
          tenantId: event.tenant_id,
          warehouseId: event.warehouse_id,
          severity: 'WARN',
          alertType: 'CROSSDOCK_TEMPO_EXCEDIDO',
          title: 'Cross-docking acima do tempo máximo',
          sourceEntity: 'crossdock_link',
          sourceEntityId: String(event.payload.crossdock_link_id),
          sourceEventId: event.event_id,
        });
        return;

      // DOC-15 RNF-COL-051 — dispositivo sem contato > 24h com fila > 0
      // (FieldDeviceService.checkOfflineWithPendingQueue(), Sessão COL-2A).
      // tenant_id sempre NULL: field_device é GLOBAL (infraestrutura do
      // armazém, mesmo raciocínio de peripheral_device), não pertence a um
      // tenant específico.
      case 'campo.dispositivo_sem_contato':
        await this.alertService.create({
          tenantId: null,
          warehouseId: event.warehouse_id,
          severity: 'WARN',
          alertType: 'DISPOSITIVO_CAMPO_OFFLINE',
          title: 'Dispositivo de campo sem contato com fila pendente',
          message: `Última sincronização há mais de 24h, fila com ${event.payload.queue_size} operação(ões) pendente(s)`,
          sourceEntity: 'field_device',
          sourceEntityId: String(event.payload.device_id),
          sourceEventId: event.event_id,
        });
        return;

      default:
        return; // RF-ARQ-041: event_type sem mapeamento não é erro.
    }
  }

  /**
   * RN-PAI-004/RF-PAI-010 "cartões atrasados" — mesma varredura de K-14
   * (kpi-computation-service.ts k14CartoesAtrasados), aqui materializada em
   * `alert` em vez de contada. Chamado pelo snapshot diário (não por
   * evento — natureza de condição-de-tempo, não de evento discreto).
   */
  async syncLateCards(warehouseId: string): Promise<void> {
    await this.db.transactionAsWorker(async (client) => {
      const slaResult = await client.query<{ value: string }>(
        `SELECT value FROM wms.app_parameter WHERE scope = 'WAREHOUSE' AND warehouse_id = $1 AND name = 'PAI.SLA_ETAPA_MIN'`,
        [warehouseId]
      );
      let slaMap: Record<string, number> = {};
      try {
        slaMap = slaResult.rows[0]?.value ? JSON.parse(slaResult.rows[0].value) : {};
      } catch {
        slaMap = {};
      }
      const stepCodes = Object.keys(slaMap);
      if (stepCodes.length === 0) return;

      const result = await client.query<{ flow_id: string; tenant_id: string | null; step_code: string; started_at: string }>(
        `SELECT of.id AS flow_id, of.tenant_id, fs.step_code, fs.started_at
         FROM wms.flow_step fs
         JOIN wms.operation_flow of ON of.id = fs.operation_flow_id
         WHERE of.warehouse_id = $1 AND fs.status = 'PENDING' AND fs.started_at IS NOT NULL AND fs.step_code = ANY($2::text[])`,
        [warehouseId, stepCodes]
      );

      const now = Date.now();
      for (const row of result.rows) {
        const minutesElapsed = (now - new Date(row.started_at).getTime()) / 60000;
        if (minutesElapsed <= slaMap[row.step_code]) continue;
        await this.alertService.create({
          tenantId: row.tenant_id,
          warehouseId,
          severity: 'WARN',
          alertType: 'CARTAO_ATRASADO' as AlertType,
          title: `Cartão atrasado na etapa ${row.step_code}`,
          sourceEntity: 'operation_flow',
          sourceEntityId: row.flow_id,
        });
      }
    });
  }
}
