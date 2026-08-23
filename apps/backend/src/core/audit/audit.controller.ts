// DOC-12 RF-SEG-033 — consulta de auditoria com filtros + exportação CSV
// (a própria exportação é auditada). Requer SEG.CONSULTA_AUDITORIA.
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService, AuditAction } from './audit.service.js';
import { PermissionGuard } from '../rbac/guards/permission.guard.js';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../rbac/decorators/current-user.decorator.js';
import { RequestPrincipal } from '../rbac/guards/permission.guard.js';

@Controller('audit')
@UseGuards(PermissionGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @RequirePermission('SEG.CONSULTA_AUDITORIA')
  @Get()
  async query(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('user_id') userId?: string,
    @Query('entity') entity?: string,
    @Query('action') action?: AuditAction,
    @Query('warehouse_id') warehouseId?: string,
    @Query('tenant_id') tenantId?: string,
    @Query('correlation_id') correlationId?: string
  ) {
    return this.auditService.query({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      userId,
      entity,
      action,
      warehouseId,
      tenantId,
      correlationId,
    });
  }

  @RequirePermission('SEG.CONSULTA_AUDITORIA')
  @Get('export.csv')
  async exportCsv(
    @CurrentUser() principal: RequestPrincipal,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('user_id') userId?: string,
    @Query('entity') entity?: string,
    @Query('action') action?: AuditAction,
    @Query('warehouse_id') warehouseId?: string,
    @Query('tenant_id') tenantId?: string,
    @Query('correlation_id') correlationId?: string
  ) {
    const filters = {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      userId,
      entity,
      action,
      warehouseId,
      tenantId,
      correlationId,
    };
    const rows = await this.auditService.query(filters);
    const csv = this.auditService.toCsv(rows);

    // RF-SEG-033: "a própria exportação é auditada".
    await this.auditService.record({
      tenantId: tenantId ?? null,
      warehouseId: warehouseId ?? null,
      userId: principal.userId,
      origin: 'WEB',
      entity: 'audit_log',
      entityId: 'export',
      action: 'EXPORT',
      after: { row_count: rows.length, filters },
    });

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="audit-export.csv"');
    res.send(csv);
  }
}
