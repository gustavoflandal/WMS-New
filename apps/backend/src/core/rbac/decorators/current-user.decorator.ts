// Extrai o principal (setado por PermissionGuard) da requisição.
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestPrincipal } from '../guards/permission.guard.js';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestPrincipal => {
  const request = ctx.switchToHttp().getRequest();
  return request.principal;
});
