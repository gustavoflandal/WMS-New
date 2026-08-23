// DOC-11 RD-PER-001/002 + RF-PER-004 (Estações). Tabelas GLOBAIS (§7) — sem
// contexto de tenant, mesmo padrão de warehouse/zone/location.
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../../core/database/database.service.js';
import { AuditService } from '../../../core/audit/audit.service.js';

const DRIVER_BY_FUNCTION: Record<string, string[]> = {
  IMPRESSORA_ETIQUETA: ['ZPL_TCP'],
  IMPRESSORA_DOCUMENTO: ['PDF_SPOOLER'],
  BALANCA: ['TOLEDO_P05', 'FILIZOLA_CS', 'GENERICO_CONTINUO'],
  CANCELA: ['RELE_IP', 'MODBUS_TCP'],
  CATRACA: ['RELE_IP', 'MODBUS_TCP'],
  LPR: ['LPR_PUSH', 'LPR_POLLING'],
};

const WORKSTATION_FUNCTIONS = ['IMPRESSORA_ETIQUETA', 'IMPRESSORA_DOCUMENTO', 'BALANCA', 'CANCELA', 'CATRACA'];

export interface RegisterDeviceInput {
  warehouseId: string;
  edgeAgentId: string;
  deviceCode: string;
  function: string;
  driverCode: string;
  connectionParams?: Record<string, unknown>;
  actorUserId: string;
}

@Injectable()
export class PeripheralDeviceService {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** RD-PER-001. `peripheral_device_function_driver_match` (migration 0061) também valida no banco — checado aqui primeiro para erro determinístico legível. */
  async registerDevice(input: RegisterDeviceInput) {
    if (!DRIVER_BY_FUNCTION[input.function]) {
      throw new BadRequestException({ error: 'INVALID_FUNCTION', detail: `RF-PER-004: função ${input.function} não existe no catálogo fechado` });
    }
    if (!DRIVER_BY_FUNCTION[input.function].includes(input.driverCode)) {
      throw new BadRequestException({
        error: 'DRIVER_FUNCTION_MISMATCH',
        detail: `DOC-11 §4: driver ${input.driverCode} não é compatível com a função ${input.function} (esperado: ${DRIVER_BY_FUNCTION[input.function].join(', ')})`,
      });
    }

    const result = await this.db.queryGlobal(
      `INSERT INTO wms.peripheral_device (warehouse_id, edge_agent_id, device_code, function, driver_code, connection_params, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.warehouseId, input.edgeAgentId, input.deviceCode, input.function, input.driverCode, JSON.stringify(input.connectionParams ?? {}), input.actorUserId]
    );
    const device = result.rows[0];

    await this.auditService.record({
      warehouseId: input.warehouseId,
      userId: input.actorUserId,
      origin: 'WEB',
      entity: 'peripheral_device',
      entityId: device.id,
      action: 'CREATE',
      requirementId: 'DOC-11 RD-PER-001',
      after: device,
    });

    return device;
  }

  async findByCode(deviceCode: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.peripheral_device WHERE device_code = $1`, [deviceCode]);
    const device = result.rows[0];
    if (!device) throw new NotFoundException(`peripheral_device ${deviceCode} not found`);
    return device;
  }

  /** Usado por portaria (cancela/catraca): DOC-11 não modela "workstation" para esses periféricos (fixos por local, não por sessão de usuário) — resolve pelo primeiro dispositivo da função cadastrado no armazém, mesmo critério de simplicidade já usado antes desta sessão (edge_agent ONLINE "qualquer um" em gate-in.service.ts). */
  async findFirstDeviceForWarehouse(warehouseId: string, fn: string) {
    const result = await this.db.queryGlobal(
      `SELECT * FROM wms.peripheral_device WHERE warehouse_id = $1 AND function = $2 ORDER BY created_at LIMIT 1`,
      [warehouseId, fn]
    );
    return result.rows[0] ?? null;
  }

  async findById(id: string) {
    const result = await this.db.queryGlobal(`SELECT * FROM wms.peripheral_device WHERE id = $1`, [id]);
    const device = result.rows[0];
    if (!device) throw new NotFoundException(`peripheral_device ${id} not found`);
    return device;
  }

  /** RNF-PER-003: telemetria a cada 60s — atualiza status/detalhe do dispositivo. */
  async applyTelemetry(deviceCode: string, status: 'ONLINE' | 'OFFLINE' | 'ERRO' | 'MANUTENCAO', statusDetail: string | null) {
    const result = await this.db.queryGlobal(
      `UPDATE wms.peripheral_device SET status = $2, status_detail = $3, last_telemetry_at = now(), updated_at = now()
       WHERE device_code = $1 RETURNING *, (SELECT status FROM wms.peripheral_device WHERE device_code = $1) AS previous_status`,
      [deviceCode, status, statusDetail]
    );
    return result.rows[0] ?? null;
  }

  async registerWorkstation(warehouseId: string, code: string, name: string, actorUserId: string) {
    const result = await this.db.queryGlobal(
      `INSERT INTO wms.workstation (warehouse_id, code, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [warehouseId, code, name, actorUserId]
    );
    return result.rows[0];
  }

  /** RF-PER-004: mapeia um dispositivo a uma função de uma Estação (1 por função). */
  async mapDeviceToWorkstation(workstationId: string, fn: string, peripheralDeviceId: string, actorUserId: string) {
    if (!WORKSTATION_FUNCTIONS.includes(fn)) {
      throw new BadRequestException({ error: 'INVALID_WORKSTATION_FUNCTION', detail: `RF-PER-004: LPR não é mapeado por Estação (câmera fixa por pista)` });
    }
    const result = await this.db.queryGlobal(
      `INSERT INTO wms.workstation_device (workstation_id, function, peripheral_device_id, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (workstation_id, function) DO UPDATE SET peripheral_device_id = EXCLUDED.peripheral_device_id, updated_at = now(), updated_by = EXCLUDED.created_by
       RETURNING *`,
      [workstationId, fn, peripheralDeviceId, actorUserId]
    );
    return result.rows[0];
  }

  /**
   * RF-PER-004 [determinístico]: resolve o dispositivo de uma função para a
   * Estação da sessão. Estação sem dispositivo da função = mensagem
   * determinística com instrução de configuração (não uma exceção genérica).
   */
  async resolveDeviceForWorkstation(workstationCode: string, warehouseId: string, fn: string) {
    const result = await this.db.queryGlobal(
      `SELECT pd.* FROM wms.workstation w
       JOIN wms.workstation_device wd ON wd.workstation_id = w.id AND wd.function = $3
       JOIN wms.peripheral_device pd ON pd.id = wd.peripheral_device_id
       WHERE w.code = $1 AND w.warehouse_id = $2`,
      [workstationCode, warehouseId, fn]
    );
    const device = result.rows[0];
    if (!device) {
      throw new BadRequestException({
        error: 'WORKSTATION_DEVICE_NOT_CONFIGURED',
        detail: `RF-PER-004: a Estação "${workstationCode}" não tem dispositivo da função ${fn} configurado — peça ao administrador para mapear um dispositivo em PER.GESTAO_DISPOSITIVOS`,
      });
    }
    return device;
  }
}
