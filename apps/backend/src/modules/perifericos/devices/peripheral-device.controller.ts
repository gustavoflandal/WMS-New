// DOC-11 RF-PER-004/RNF-PER-001 — administração de Edge Agents,
// dispositivos e Estações. PER.GESTAO_DISPOSITIVOS (WAREHOUSE, sensível).
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { EdgeAgentAdminService } from './edge-agent-admin.service.js';
import { PeripheralDeviceService } from './peripheral-device.service.js';
import { PermissionGuard } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';
import type { RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';

interface RegisterAgentBody {
  warehouse_id: string;
  device_name: string;
  device_type?: string;
  serial_number?: string;
}

interface RegisterDeviceBody {
  warehouse_id: string;
  edge_agent_id: string;
  device_code: string;
  function: string;
  driver_code: string;
  connection_params?: Record<string, unknown>;
}

interface RegisterWorkstationBody {
  warehouse_id: string;
  code: string;
  name: string;
}

interface MapDeviceBody {
  warehouse_id: string;
  function: string;
  peripheral_device_id: string;
}

@Controller('perifericos')
@UseGuards(PermissionGuard)
export class PeripheralDeviceController {
  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(EdgeAgentAdminService) private readonly edgeAgentAdminService: EdgeAgentAdminService,
    @Inject(PeripheralDeviceService) private readonly peripheralDeviceService: PeripheralDeviceService
  ) {}

  /** RNF-PER-001: pareamento — o token retornado aqui é a ÚNICA vez em que aparece em texto plano. */
  @RequirePermission('PER.GESTAO_DISPOSITIVOS')
  @Post('agentes')
  registerAgent(@Body() body: RegisterAgentBody, @CurrentUser() principal: RequestPrincipal) {
    return this.edgeAgentAdminService.registerAgent({
      warehouseId: body.warehouse_id,
      deviceName: body.device_name,
      deviceType: body.device_type,
      serialNumber: body.serial_number,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('PER.GESTAO_DISPOSITIVOS')
  @Post('dispositivos')
  registerDevice(@Body() body: RegisterDeviceBody, @CurrentUser() principal: RequestPrincipal) {
    return this.peripheralDeviceService.registerDevice({
      warehouseId: body.warehouse_id,
      edgeAgentId: body.edge_agent_id,
      deviceCode: body.device_code,
      function: body.function,
      driverCode: body.driver_code,
      connectionParams: body.connection_params,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('PER.GESTAO_DISPOSITIVOS')
  @Post('estacoes')
  registerWorkstation(@Body() body: RegisterWorkstationBody, @CurrentUser() principal: RequestPrincipal) {
    return this.peripheralDeviceService.registerWorkstation(body.warehouse_id, body.code, body.name, principal.userId);
  }

  @RequirePermission('PER.GESTAO_DISPOSITIVOS')
  @Post('estacoes/:id/dispositivos')
  mapDevice(@Param('id') workstationId: string, @Body() body: MapDeviceBody, @CurrentUser() principal: RequestPrincipal) {
    return this.peripheralDeviceService.mapDeviceToWorkstation(workstationId, body.function, body.peripheral_device_id, principal.userId);
  }
}
