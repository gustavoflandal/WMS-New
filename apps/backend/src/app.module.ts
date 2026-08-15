// RNF-ARQ-001: Module structure per specification
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

// Core modules (infrastructure)
import { CoreModule } from './core/core.module';

// Business modules (RNF-ARQ-001)
import { PortariaModule } from './modules/portaria/portaria.module';
import { RecebimentoModule } from './modules/recebimento/recebimento.module';
import { EstoqueModule } from './modules/estoque/estoque.module';
import { ExpedicaoModule } from './modules/expedicao/expedicao.module';
import { FiscalModule } from './modules/fiscal/fiscal.module';
import { FaturamentoModule } from './modules/faturamento/faturamento.module';
import { PaineisModule } from './modules/paineis/paineis.module';
import { PerifericosModule } from './modules/perifericos/perifericos.module';
import { SegurancaModule } from './modules/seguranca/seguranca.module';
import { IntegracoesModule } from './modules/integracoes/integracoes.module';

// Health check module
import { HealthModule } from './core/health/health.module';

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
