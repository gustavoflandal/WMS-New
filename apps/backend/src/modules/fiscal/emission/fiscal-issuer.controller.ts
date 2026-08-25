// DOC-08 §3 — cadastro de emitente (FIS.CONFIG) e certificado A1 (FIS.CERTIFICADO).
import { Body, Controller, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { FiscalIssuerService } from './fiscal-issuer.service.js';
import { PermissionGuard, RequestPrincipal } from '../../../core/rbac/guards/permission.guard.js';
import { RequirePermission } from '../../../core/rbac/decorators/require-permission.decorator.js';
import { CurrentUser } from '../../../core/rbac/decorators/current-user.decorator.js';

interface RegisterIssuerBody {
  tenant_id: string;
  warehouse_id: string;
  cnpj: string;
  corporate_name: string;
  serie: number;
  ambiente?: 'HOMOLOGACAO' | 'PRODUCAO';
}

interface UploadCertificateBody {
  tenant_id: string;
  warehouse_id: string;
  /** PFX em base64 — payload JSON, sem multipart nesta sessão (escopo mínimo). */
  pfx_base64: string;
  password: string;
}

@Controller('fiscal/emitentes')
@UseGuards(PermissionGuard)
export class FiscalIssuerController {
  constructor(@Inject(FiscalIssuerService) private readonly fiscalIssuerService: FiscalIssuerService) {}

  @RequirePermission('FIS.CONFIG')
  @Post()
  register(@Body() body: RegisterIssuerBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fiscalIssuerService.register({
      tenantId: body.tenant_id,
      warehouseId: body.warehouse_id,
      cnpj: body.cnpj,
      corporateName: body.corporate_name,
      serie: body.serie,
      ambiente: body.ambiente,
      actorUserId: principal.userId,
    });
  }

  @RequirePermission('FIS.CERTIFICADO')
  @Post(':id/certificado')
  uploadCertificate(@Param('id') id: string, @Body() body: UploadCertificateBody, @CurrentUser() principal: RequestPrincipal) {
    return this.fiscalIssuerService.uploadCertificate(
      id,
      body.tenant_id,
      body.warehouse_id,
      Buffer.from(body.pfx_base64, 'base64'),
      body.password,
      principal.userId
    );
  }
}
