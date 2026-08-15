// RNF-ARQ-001: Module structure per specification
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
  ],
})
export class AppModule {}
