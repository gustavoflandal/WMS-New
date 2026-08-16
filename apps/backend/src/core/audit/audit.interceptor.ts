// DOC-12 RN-SEG-032 — interceptor genérico e reutilizável: qualquer
// handler marcado com @Audited(entity, action) gera automaticamente uma
// linha em audit_log após a resposta bem-sucedida, capturando `after` =
// retorno do handler. `before`/`reason`/`requirement_id` mais ricos
// continuam podendo ser gravados explicitamente via AuditService.record()
// dentro do próprio service quando o caso exigir (ex.: workflow de
// aprovação, login/logout — ver auth.service.ts, operational-exception
// service).
import { CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service.js';
import { AUDITED_KEY, AuditedOptions } from './decorators/audited.decorator.js';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável sob teste.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditedOptions | undefined>(AUDITED_KEY, context.getHandler());
    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const principal = request.principal as { userId: string } | undefined;

    return next.handle().pipe(
      tap((result: any) => {
        const entityId = result?.id ?? request.params?.id ?? request.body?.id ?? 'unknown';
        const tenantId = result?.tenant_id ?? request.body?.tenant_id ?? request.query?.tenant_id ?? null;
        const warehouseId = result?.warehouse_id ?? request.body?.warehouse_id ?? request.query?.warehouse_id ?? null;

        this.auditService
          .record({
            tenantId,
            warehouseId,
            userId: principal?.userId ?? 'SYSTEM',
            origin: options.origin ?? 'WEB',
            entity: options.entity,
            entityId: String(entityId),
            action: options.action,
            requirementId: options.requirementId ?? null,
            after: result ?? null,
            correlationId: (request.headers?.['x-correlation-id'] as string) ?? undefined,
          })
          .catch((error) => this.logger.error('Failed to write audit_log entry', error));
      })
    );
  }
}
