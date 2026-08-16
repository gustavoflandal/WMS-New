// DOC-12 RN-SEG-012 [INVIOLÁVEL, a mais importante] — "Toda rota de API e
// todo handler de WebSocket DEVEM declarar a permissão exigida; rota sem
// declaração NÃO PODE ser registrada (falha no boot da aplicação)."
//
// Roda em onModuleInit() do RbacModule, que é importado por AppModule —
// portanto para TODOS os App roles (api/worker/scheduler), já que
// main.ts chama app.init() incondicionalmente antes de app.listen()
// (role api) ou de iniciar workers/scheduler. Uma rota sem declaração
// derruba o boot da aplicação inteira, não só do servidor HTTP.
import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { MESSAGE_MAPPING_METADATA } from '@nestjs/websockets/constants.js';
import { ROUTE_DECLARATION_KEY } from './decorators/require-permission.decorator.js';

@Injectable()
export class RouteAuditService implements OnModuleInit {
  private readonly logger = new Logger(RouteAuditService.name);

  // @Inject(...) explícito: o transform TS do Vitest (esbuild) não emite
  // `design:paramtypes` de forma confiável, e a resolução de DI do Nest
  // baseada só no tipo TS falha silenciosamente sob teste (mesma classe de
  // problema já contornado em DatabaseService/CacheService com
  // ConfigService opcional + fallback em process.env — aqui não há
  // fallback possível, então o token é declarado explicitamente).
  constructor(
    @Inject(DiscoveryService) private readonly discoveryService: DiscoveryService,
    @Inject(Reflector) private readonly reflector: Reflector
  ) {}

  onModuleInit(): void {
    const undeclared = this.findUndeclaredHandlers();
    if (undeclared.length > 0) {
      const message =
        `RN-SEG-012 [INVIOLÁVEL]: ${undeclared.length} rota(s)/handler(s) sem declaração de permissão ` +
        `(@RequirePermission/@Public/@Authenticated). O boot foi interrompido — corrija antes de subir a aplicação:\n` +
        undeclared.map((u) => `  - ${u}`).join('\n');
      this.logger.error(message);
      throw new Error(message);
    }
    this.logger.log('RN-SEG-012: todas as rotas REST e handlers WebSocket declaram permissão. Boot liberado.');
  }

  private findUndeclaredHandlers(): string[] {
    const undeclared: string[] = [];
    const wrappers = [...this.discoveryService.getControllers(), ...this.discoveryService.getProviders()];

    for (const wrapper of wrappers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance);
      if (!prototype || prototype === Object.prototype) continue;

      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === 'constructor') continue;
        // Object.getOwnPropertyDescriptor (não `prototype[methodName]`):
        // acessar a propriedade diretamente DISPARARIA qualquer getter
        // definido no protótipo (ex.: HttpAdapterHost.listen$ interno do
        // Nest), com `this` incorreto (o protótipo, não uma instância).
        const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
        const handler = descriptor?.value;
        if (typeof handler !== 'function') continue;

        const isHttpRoute = Reflect.getMetadata(PATH_METADATA, handler) !== undefined && Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
        const isWsHandler = Reflect.getMetadata(MESSAGE_MAPPING_METADATA, handler) !== undefined;

        if (!isHttpRoute && !isWsHandler) continue;

        const declaration = Reflect.getMetadata(ROUTE_DECLARATION_KEY, handler);
        if (!declaration) {
          const kind = isHttpRoute ? 'HTTP' : 'WebSocket';
          undeclared.push(`[${kind}] ${instance.constructor.name}.${methodName}()`);
        }
      }
    }

    return undeclared;
  }
}
