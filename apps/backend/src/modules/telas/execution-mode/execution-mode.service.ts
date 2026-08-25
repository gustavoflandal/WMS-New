// DOC-17 §6 — RN-TEL-010 [INVIOLÁVEL] (Modo de Execução) e RN-TEL-012
// (controles compensatórios). Ver docs/PROMPT-SESSAO-10E-doc17-execucao-por-tela.md.
//
// Este service é uma GUARDA, não um caminho de execução: quem executa
// continua sendo o serviço de domínio de cada módulo (RN-TEL-011). Ele
// responde a duas perguntas antes de qualquer efeito:
//   1. este canal pode executar neste armazém? (RN-TEL-010, 1ª parte)
//   2. esta tarefa já foi iniciada por outro canal? (RN-TEL-010, 2ª parte)
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService, TenantContext } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';
import { RbacService } from '../../../core/rbac/rbac.service.js';
import { ExecutionChannel, ExecutionMode, EXECUTION_MODES, isChannelAllowed, isSameChannelContinuation, parseExecutionMode } from './execution-mode.util.js';

/** Tabelas de tarefa que carregam `execution_channel` (RD-TEL-004, migration 0079). */
const CHANNEL_TABLES = new Set(['putaway_task', 'picking_task', 'replenishment_task', 'checking', 'package', 'loading', 'inventory_count_round']);

@Injectable()
export class ExecutionModeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(RbacService) private readonly rbacService: RbacService
  ) {}

  /**
   * RN-TEL-010 — resolve o modo do armazém, opcionalmente por tipo de
   * operação ("e, opcionalmente, por tipo de operação"). A chave específica
   * `TEL.MODO_EXECUCAO.<OPERACAO>` vence a genérica quando existir.
   */
  async resolveMode(ctx: TenantContext, operation?: string): Promise<ExecutionMode> {
    if (operation) {
      const specific = await this.readParameter(ctx, `TEL.MODO_EXECUCAO.${operation}`);
      if (specific) return parseExecutionMode(specific);
    }
    return parseExecutionMode(await this.readParameter(ctx, 'TEL.MODO_EXECUCAO'));
  }

  /**
   * Guarda completa de RN-TEL-010 + RN-TEL-012 item 4, a ser chamada ANTES
   * de qualquer efeito pela rota de execução por tela.
   */
  async assertCanExecute(input: {
    ctx: TenantContext;
    channel: ExecutionChannel;
    operation?: string;
    taskEntity?: string;
    taskId?: string;
    actorUserId: string;
  }): Promise<void> {
    const { ctx, channel, operation, taskEntity, taskId, actorUserId } = input;

    // RN-TEL-012 item 4 — "permissão própria, concedida deliberadamente".
    // Só para o canal TELA: coletor e papel têm as suas próprias.
    if (channel === 'TELA') {
      const allowed = await this.rbacService.hasPermission(actorUserId, 'TEL.EXECUCAO_TELA', {
        clientId: ctx.tenant_id,
        warehouseId: ctx.warehouse_id as string,
      });
      if (!allowed) {
        throw new ForbiddenException({
          error: 'SCREEN_EXECUTION_NOT_PERMITTED',
          detail: 'DOC-17 RN-TEL-012 item 4: execução por tela exige a permissão TEL.EXECUCAO_TELA, concedida deliberadamente',
        });
      }
    }

    // RN-TEL-010, 1ª parte — o canal é compatível com o modo do armazém?
    const mode = await this.resolveMode(ctx, operation);
    if (!isChannelAllowed(mode, channel)) {
      throw new ForbiddenException({
        error: 'EXECUTION_CHANNEL_NOT_ALLOWED',
        detail: `DOC-17 RN-TEL-010: o armazém opera em modo ${mode}${operation ? ` para ${operation}` : ''} — o canal ${channel} não é permitido`,
        mode,
        channel,
      });
    }

    // RN-TEL-010, 2ª parte — trava de dupla contagem.
    if (taskEntity && taskId) {
      await this.assertNoCrossChannelSwitch(ctx, taskEntity, taskId, channel);
    }
  }

  /**
   * RN-TEL-010 [INVIOLÁVEL]: "uma tarefa já iniciada em um modo NÃO pode ser
   * concluída no outro — evita dupla contagem. A troca exige devolução/
   * cancelamento da execução em curso."
   */
  async assertNoCrossChannelSwitch(ctx: TenantContext, taskEntity: string, taskId: string, channel: ExecutionChannel): Promise<void> {
    if (!CHANNEL_TABLES.has(taskEntity)) {
      throw new BadRequestException({ error: 'UNSUPPORTED_TASK_ENTITY', detail: `RD-TEL-004: ${taskEntity} não tem execution_channel` });
    }
    // Identificador validado contra a lista fechada acima — nunca vem cru do
    // usuário para dentro do SQL.
    const result = await this.db.query<{ execution_channel: string; status: string }>(ctx, `SELECT execution_channel, status FROM wms.${taskEntity} WHERE id = $1`, [taskId]);
    const task = result.rows[0];
    if (!task) throw new NotFoundException(`${taskEntity} ${taskId} not found`);

    // Só trava quando a tarefa JÁ FOI iniciada: enquanto ela está no estado
    // inicial, o canal gravado é só o default e qualquer um pode assumir.
    const started = !['CREATED', 'PENDING', 'OPEN'].includes(task.status);
    const startedChannel = started ? (task.execution_channel as ExecutionChannel) : null;

    if (!isSameChannelContinuation(startedChannel, channel)) {
      throw new ConflictException({
        error: 'EXECUTION_CHANNEL_SWITCH_DENIED',
        detail:
          `DOC-17 RN-TEL-010: a tarefa foi iniciada no canal ${startedChannel} e não pode ser concluída no canal ${channel} ` +
          `(evita dupla contagem). Devolva ou cancele a execução em curso antes de trocar de modo.`,
        started_channel: startedChannel,
        attempted_channel: channel,
      });
    }
  }

  /** RD-TEL-004 — grava o canal na tarefa. Chamado pelo serviço de domínio ao iniciar/concluir. */
  async stampChannel(ctx: TenantContext, taskEntity: string, taskId: string, channel: ExecutionChannel): Promise<void> {
    if (!CHANNEL_TABLES.has(taskEntity)) {
      throw new BadRequestException({ error: 'UNSUPPORTED_TASK_ENTITY', detail: `RD-TEL-004: ${taskEntity} não tem execution_channel` });
    }
    await this.db.query(ctx, `UPDATE wms.${taskEntity} SET execution_channel = $2 WHERE id = $1`, [taskId, channel]);
  }

  /** RN-TEL-010 — configuração do modo (permissão TEL.MODO_EXECUCAO_CONFIGURAR, verificada na rota). */
  async setMode(ctx: TenantContext, mode: string, operation: string | null, actorUserId: string) {
    if (!(EXECUTION_MODES as string[]).includes(mode)) {
      throw new BadRequestException({ error: 'INVALID_EXECUTION_MODE', detail: `RN-TEL-010: modo deve ser um de ${EXECUTION_MODES.join(', ')}` });
    }
    const name = operation ? `TEL.MODO_EXECUCAO.${operation}` : 'TEL.MODO_EXECUCAO';
    const before = await this.readParameter(ctx, name);

    // A chave única de app_parameter é (scope, name, warehouse_id, client_id)
    // — criada na migration 0079 desta sessão; antes dela a tabela não tinha
    // unicidade alguma (ver comentário lá).
    await this.db.query(
      ctx,
      `INSERT INTO wms.app_parameter (scope, name, value, warehouse_id)
       VALUES ('WAREHOUSE', $1, $2, $3)
       ON CONFLICT (scope, name, warehouse_id, client_id)
       DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [name, mode, ctx.warehouse_id]
    );

    await this.auditService.record({
      tenantId: ctx.tenant_id,
      warehouseId: ctx.warehouse_id as string,
      userId: actorUserId,
      origin: 'WEB',
      entity: 'app_parameter',
      entityId: name,
      action: 'UPDATE',
      requirementId: 'DOC-17 RN-TEL-010',
      before: { name, value: before },
      after: { name, value: mode },
    });

    return { name, value: mode };
  }

  private async readParameter(ctx: TenantContext, name: string): Promise<string | null> {
    const result = await this.db.query<{ value: string }>(
      ctx,
      `SELECT value FROM wms.app_parameter
       WHERE name = $1 AND (scope = 'GLOBAL' OR (scope = 'WAREHOUSE' AND warehouse_id = $2))
       ORDER BY CASE scope WHEN 'WAREHOUSE' THEN 0 ELSE 1 END
       LIMIT 1`,
      [name, ctx.warehouse_id]
    );
    return result.rows[0]?.value ?? null;
  }
}
