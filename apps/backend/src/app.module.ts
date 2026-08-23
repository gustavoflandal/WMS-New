// RNF-ARQ-001: Module structure per specification
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { rejectActorSpoofingMiddleware } from './core/rbac/middleware/reject-actor-spoofing.middleware.js';

// Core modules (infrastructure)
import { CoreModule } from './core/core.module.js';

// Business modules (RNF-ARQ-001)
import { PortariaModule } from './modules/portaria/portaria.module.js';
import { RecebimentoModule } from './modules/recebimento/recebimento.module.js';
import { EstoqueModule } from './modules/estoque/estoque.module.js';
import { ExpedicaoModule } from './modules/expedicao/expedicao.module.js';
import { FiscalModule } from './modules/fiscal/fiscal.module.js';
import { FaturamentoModule } from './modules/faturamento/faturamento.module.js';
import { PaineisModule } from './modules/paineis/paineis.module.js';
import { PerifericosModule } from './modules/perifericos/perifericos.module.js';
import { SegurancaModule } from './modules/seguranca/seguranca.module.js';
import { IntegracoesModule } from './modules/integracoes/integracoes.module.js';
import { CadastroModule } from './modules/cadastro/cadastro.module.js';
import { CampoModule } from './modules/campo/campo.module.js';

// Health check module
import { HealthModule } from './core/health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    CoreModule,
    HealthModule,
    // Business modules
    PortariaModule,
    RecebimentoModule,
    EstoqueModule,
    ExpedicaoModule,
    FiscalModule,
    FaturamentoModule,
    PaineisModule,
    PerifericosModule,
    SegurancaModule,
    IntegracoesModule,
    CadastroModule,
    CampoModule,
  ],
})
export class AppModule implements NestModule {
  // DOC-12 RG-003 [INVIOLÁVEL]: registrado via NestModule.configure(), não
  // `app.use()` cru em main.ts — o Nest garante que middleware registrado
  // aqui roda DEPOIS do body-parser padrão e ANTES do roteamento de
  // controllers/guards, independente de timing. `app.use()` direto em
  // main.ts foi tentado antes/depois de app.init() nesta sessão e ambos
  // falharam (antes: req.body ainda não parseado; depois: rotas já
  // registradas antes do middleware, nunca alcançado) — bug real
  // encontrado e corrigido durante a validação desta correção.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(rejectActorSpoofingMiddleware).forRoutes('*');
  }
}
