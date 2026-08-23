# PROMPT — SESSÃO 8A: FISCAL — CICLO DO ESTOQUE FISCAL (RG-014)

## ⚠️ PAUSA OBRIGATÓRIA ANTES DE COMEÇAR

DOC-08 marca três regras como **[VALIDAR CONTABILIDADE]** — posição padrão adotada, mas pendente de homologação contábil real do operador antes de produção (`docs/relatorios/ROTEIRO-DESENVOLVIMENTO.md` §"Posição 2" as chama de "pré-requisito externo obrigatório": **"Emitir com CFOP errado é caro de desfazer"**). Situação em `docs/relatorios/ESTADO-E-ROTEIRO.md` §4 (2026-08-16):

| Item | Regra | Status |
|---|---|---|
| Ordem de consumo fiscal | RN-FIS-030 (FIFO por emissão) | ✅ Confirmado pelo contador em 2026-08-16 — pode implementar |
| Prazo de regularização | RN-FIS-010 (10 dias corridos) | ❌ Pendente |
| CFOPs/naturezas | RN-FIS-050 (5905/6905, 5906/6906) | ❌ Pendente |

**Antes de implementar RN-FIS-010 e RN-FIS-050 com valor real de produção**, pare e confirme com o Gustavo se a homologação contábil já aconteceu. Se a resposta for "ainda não": implemente as DUAS regras normalmente com a posição padrão do DOC-08 (são os valores que o próprio documento já define como padrão — o sistema não fica bloqueado esperando), mas:
1. Grave `[VALIDAR CONTABILIDADE]` no comentário do código/migration exatamente onde o valor entra (parâmetro `FIS.PRAZO_ENTRADA_DIAS`, tabela `operation_nature`);
2. Não trate isso como lacuna de especificação (a regra já está definida, com posição padrão) — é um valor de PRODUÇÃO pendente de validação externa, não uma decisão técnica sua;
3. Registre no relatório final, em destaque, que a ida a produção com emissão real (Sessão 8B) depende dessa confirmação.

Se a resposta for "já homologado": registre os valores confirmados (podem diferir do padrão) e remova o marcador.

**Isto não é um motivo para não fazer a sessão** — é o mesmo padrão já usado para RN-FIS-030 (que tinha o mesmo marcador e já foi confirmado). Só não commite a Sessão 8B (motor de emissão real) sem essa confirmação.

---

## Especificação de Execução

| Metadado | Valor |
|---|---|
| Sessão | 8A (parte 1 de 2 — ciclo do estoque fiscal; 8B é o motor de emissão NF-e que consome o que esta sessão constrói) |
| Módulo | DOC-08 (Fiscal) §4.1–§4.6, §4.8; DOC-00 RG-014 [INVIOLÁVEL] |
| Dependência de | DOC-00 v1.2.0, DOC-01, DOC-02 (`wms.fiscal_stock_balance`, migration 0014, já existe), DOC-04 (recebimento — NF de entrada), DOC-05 (descarte/ajuste — RN-FIS-070), DOC-06 ✓ (`DispatchService.confirmFiscalDocuments`, já tem o gancho pronto e bloqueando), DOC-07 (reversa — RN-FIS-041, ainda não implementado — ver §5 fora de escopo) |
| Modelo | Sonnet Premium (regras financeiras densas, múltiplas máquinas de estado, RG-014 é a regra mais rígida do sistema depois de RG-001/RG-004) |
| Data de Abertura | — (abrir após confirmar a pausa acima) |
| Stack | NestJS + PostgreSQL 16, dentro de `apps/backend/src/modules/fiscal/` (hoje só um `fiscal.module.ts` vazio, placeholder — DOC-00 §2.2 `[INVIOLÁVEL]`). **Nenhum serviço externo novo nesta sessão** — a fila/worker que fala com a SEFAZ é da 8B. |
| Alvo | Modos fiscais (RN-FIS-001), NF de entrada + prazo (RN-FIS-010), Nota de Armazenagem + crédito (RF-FIS-020/RN-FIS-021), ordem de consumo (RN-FIS-030), Nota de Devolução de Armazenagem — montagem e lógica de consumo-na-autorização (RN-FIS-040), recomposição por reversa (RN-FIS-041, só o método — o gatilho real é DOC-07, fora de escopo), naturezas/CFOP (RN-FIS-050), pendências documentais de descarte/ajuste (RN-FIS-070) |
| Posição no Plano | Posição 2 do roteiro, logo após COL-2 (✓ commits `0fee971`/`e865e3f`/`488d244`). Antes de **8B** (motor de emissão real). |

---

## 1. ESTADO REAL DO BACKEND (levantado nesta sessão — não presumir nada além disto)

- **`apps/backend/src/modules/fiscal/fiscal.module.ts` existe mas está VAZIO** (`@Module({ controllers: [], providers: [] })`) — placeholder do scaffold inicial, nenhum service/controller real. Esta sessão começa do zero dentro dele.
- **`wms.fiscal_stock_balance` já existe** (migration `0014-stock-balances.sql`): `id, tenant_id, warehouse_id, product_id, storage_remittance_invoice_id (UUID, SEM FK ainda), qty_credited, qty_consumed`, com `CHECK (qty_consumed <= qty_credited)` e `UNIQUE (tenant_id, warehouse_id, product_id, storage_remittance_invoice_id)`. RLS já habilitado e FORCE. **Falta**: a FK real de `storage_remittance_invoice_id` para a tabela que esta sessão cria (`fiscal_document`), e a coluna `qty_pending_writeoff` (RD-FIS-005, RN-FIS-070) com o CHECK `consumed + pending_writeoff <= credited`.
- **`wms.client_warehouse_settings.fiscal_mode` já existe** (migration `0009`), `CHECK IN ('EMISSAO_PROPRIA', 'INTEGRADO_ERP', 'HIBRIDO')`, hoje só lido (nunca escrito por regra de negócio nova) — RN-FIS-001 exige o comportamento por modo, incluindo a trava de imutabilidade "com documentos fiscais em aberto" (que só existe DEPOIS que `fiscal_document` existir).
- **`DispatchService.confirmFiscalDocuments()` (DOC-06, `apps/backend/src/modules/expedicao/dispatch/dispatch.service.ts:51-73`) já é o PONTO DE INTEGRAÇÃO real e já está no código, bloqueando de propósito**: para `fiscal_mode !== 'INTEGRADO_ERP'` (ou seja, `EMISSAO_PROPRIA`/`HIBRIDO`), lança `FISCAL_DOCUMENT_INTEGRATION_PENDING` com `[LACUNA: DOC-08]` explícito no detalhe, e grava esse detalhe em `outbound_order.fiscal_rejection_detail`. **Esta sessão substitui esse bloqueio pela chamada real** ao serviço que monta a Nota de Devolução de Armazenagem (RN-FIS-040) quando `fiscal_mode` exigir emissão própria — NÃO toque no ramo `INTEGRADO_ERP` (continua sendo confirmação manual, DOC-13 ainda não integra de verdade). O método `resolveFiscalMode()` (linha ~128) já lê `client_warehouse_settings.fiscal_mode` corretamente — reaproveite, não duplique.
- **Nenhuma tabela `fiscal_document`/`fiscal_document_item`/`fiscal_allocation`/`operation_nature`/`fiscal_pending_document` existe ainda** — todas as 5 (RD-FIS-001/002/003/006, mais a ALTER em `fiscal_stock_balance`) são desta sessão.
- **`DocumentNumberingService` (`apps/backend/src/modules/cadastro/document-numbering/`) já existe** com prefixos fechados por `documentType` (`OUTBOUND_ORDER: 'PED'`, `TRANSFER: 'TRF'`, `INVENTORY: 'INV'`) — **decisão explícita do DOC-08 §4.7 (RNF-FIS-060): a numeração de NOTA FISCAL segue série própria por emitente×armazém (`FIS.SERIE`), sequencial SEM lacunas, DIFERENTE da máscara `PREFIXO-ARMAZEM-SEQUENCIAL8` do `DocumentNumberingService`** (que é para documentos internos, não para o número de NF-e que a SEFAZ exige em formato próprio). Não reaproveite `DocumentNumberingService` para o número da NF-e em si — mas PODE reaproveitá-lo, se fizer sentido, para o número interno da Nota de Armazenagem/Nota de Devolução como documento do sistema (decida e documente). A numeração fiscal sequencial-sem-lacunas de verdade (com inutilização de número pulado) é RNF-FIS-060/§4.7 completo — **é da Sessão 8B**, porque depende do motor de emissão. Nesta sessão, o "número" da Nota de Devolução pode ser um identificador interno (UUID + campo `document_number` textual gerado por `DocumentNumberingService` com um novo `documentType: 'FISCAL_DOCUMENT'`), com o número DE NF-e real (`nNF`, sequencial da série) ficando `NULL` até a 8B processar.
- **`OperationalExceptionService`/`ApprovalAuthorityService` (DOC-12) já existem e são o motor genérico de workflow** — reaproveite para as 3 exceções do catálogo `FIS.*` (§3 do DOC-08), mesmo padrão de todo o resto do sistema (`exception_type` + `INSERT`, sem inventar mecanismo novo).
- **`RG.EST-070`/descarte**: `apps/backend/src/modules/estoque/blocking/stock-reclassification.service.ts` e as migrations `0044`-`0046` já implementam descarte de saldo físico (`EST.DESCARTE_SALDO`) — **RN-FIS-070 exige que o descarte aprovado, quando o produto tem Estoque Fiscal, também gere a pendência documental e trave `qty_pending_writeoff`**. Leia `stock-reclassification.service.ts` (o método de descarte) para encontrar o ponto exato de gancho — não duplique a lógica de descarte físico, só ADICIONE o efeito fiscal quando aplicável (produto do cliente tem `fiscal_stock_balance` com saldo).
- **Ajuste negativo de inventário**: `apps/backend/src/modules/estoque/inventory/inventory-count-execution.service.ts::decideAdjustment()` (Sessão 5C) já aplica `AJUSTE_INVENTARIO_NEG` via `StockMovementService` quando a divergência é aprovada — **mesmo gancho de RN-FIS-070**: ajuste negativo aprovado em produto com Estoque Fiscal também trava `qty_pending_writeoff`. Ver o método `decideAdjustment` para o ponto exato.
- **RN-FIS-041 (recomposição por reversa) — o GATILHO real é do DOC-07 (Logística Reversa), que ainda NÃO existe** (posição 3 do roteiro, depois desta sessão e da 8B). Esta sessão implementa o MÉTODO de recomposição (`FiscalConsumptionService.reverseConsumption()` ou equivalente — decida o nome), testável isoladamente, mas **sem gatilho automático conectado** (não há `DOC-07` chamando ainda). Documente isso como decisão de escopo, não como lacuna.

---

## 2. ENTREGÁVEIS DESTA SESSÃO

### 2.1 Migration

1. `wms.fiscal_document` + `wms.fiscal_document_item` (RD-FIS-001) — tipo fechado (`NF_ENTRADA`, `NOTA_ARMAZENAGEM`, `NOTA_DEVOLUCAO_ARMAZENAGEM`; os tipos `NF_TRANSFERENCIA`/`NF_DEVOLUCAO_RECEBIDA` do DOC-08 podem ficar reservados no CHECK sem uso ainda — documente), chave de acesso 44 dígitos `UNIQUE` (nullable até a 8B emitir de verdade), campo de referência ao XML no S3 (nullable — a 8B grava), estado conforme §5.1 do DOC-08 mas **restrito nesta sessão aos estados que não dependem de SEFAZ**: `DRAFT` (montado) e, para os tipos que ENTRAM no sistema já prontos (NF de entrada recebida, Nota de Armazenagem do cliente), um estado equivalente a "registrado" — decida a nomenclatura exata olhando a máquina completa do DOC-08 §5.1 e documente por que só um subconjunto é alcançável nesta sessão (o resto — `SIGNED`/`TRANSMITTED`/`AUTHORIZED`/`REJECTED`/`DENIED`/`CANCELLED` — é avanço de estado que só a 8B sabe fazer).
2. `wms.fiscal_allocation` (RD-FIS-002) — nota consumida, quantidade, estado `ALOCADA`/`CONSUMIDA`/`ESTORNADA`.
3. `wms.operation_nature` (RD-FIS-003, RN-FIS-050) — por cliente×armazém×tipo×âmbito, com os padrões de instalação da tabela do §4.6 do DOC-08 seedados via `INSERT`. **Aplique a pausa do topo deste prompt para os valores de CFOP.**
4. `wms.fiscal_pending_document` (RD-FIS-006).
5. `ALTER TABLE wms.fiscal_stock_balance`: FK real de `storage_remittance_invoice_id` para `fiscal_document(id)`; nova coluna `qty_pending_writeoff NUMERIC(18,6) NOT NULL DEFAULT 0`; novo CHECK `qty_consumed + qty_pending_writeoff <= qty_credited`.
6. Parâmetros novos: `FIS.PRAZO_ENTRADA_DIAS` (padrão `10`), `FIS.BLOQUEIO_RECEBIMENTO_PRAZO` (padrão `false`), `FIS.ORDEM_CONSUMO` (padrão `FIFO_EMISSAO`, por cliente×armazém — decida se vai em `client_warehouse_settings` como coluna nova ou em `app_parameter` escopo `CLIENT_WAREHOUSE`; documente a escolha), `FIS.RECOMPOSICAO_MODO` (padrão `ESTORNO`).
7. Catálogo de permissões `FIS.EMITIR`/`FIS.CANCELAR`/`FIS.CCE`/`FIS.INUTILIZAR`/`FIS.CONFIG`/`FIS.CERTIFICADO` (§3 do DOC-08) — **as sensíveis a emissão real (`CANCELAR`/`INUTILIZAR`/`CERTIFICADO`) só serão exercidas de fato na 8B, mas o catálogo inteiro entra aqui** (RN-SEG-012 exige toda rota declarar permissão desde o boot — se uma rota desta sessão usar `FIS.EMITIR`, o código precisa existir agora). Atribua a papéis coerentes com o ator `FISCAL`/`GESTOR_ARMAZEM` do §3 — se o papel `FISCAL` não existir ainda no catálogo de `wms.role`, crie-o (verifique primeiro; é provável que não exista, já que nenhuma sessão fiscal rodou).
8. Catálogo de exceções `FIS.PRAZO_ENTRADA_EXPIRADO` (2 passos, 24h), `FIS.CONSUMO_MANUAL` (1 passo, 8h) — `FIS.CANCELAMENTO_NFE` fica para a 8B (só faz sentido com nota `AUTHORIZED` de verdade).
9. Grants `wms_worker`/`wms_app` por consumidor real (ADR-006 — mesmo padrão de sempre, não especulativo).

### 2.2 `FiscalModeService` (RN-FIS-001)

Leitura/gravação de `fiscal_mode` com a trava de imutabilidade ("modo é imutável com documentos fiscais em aberto — troca exige zerar pendências", verificando `fiscal_document` em estados não-terminais e `fiscal_pending_document` em aberto).

### 2.3 `InboundInvoiceService` (RF de entrada + RN-FIS-010)

Registro da NF de entrada (vínculo com `inbound_order` do DOC-04 — decida o ponto de entrada: automático ao concluir o recebimento, ou registro manual/upload; DOC-08 não detalha o gatilho exato de ENTRADA da informação, só o ciclo — se for lacuna real de origem do dado, marque `[LACUNA: DOC-08]` explicitamente, não invente). Contagem de prazo a partir do gate-in (DOC-03, já existe), alertas em 50/80/100% (worker `scheduler`, mesmo padrão de `ExpirationAlertWorkerImpl`/`FieldDeviceOfflineWorkerImpl` — eleição de líder via lock Redis), e o efeito de bloqueio de RF-EXP-002 item 2 (**ache o ponto exato em `apps/backend/src/modules/expedicao/order/outbound-order.service.ts` ou onde a liberação valida saldo fiscal hoje — se HOJE não há validação nenhuma de saldo fiscal na liberação, porque RG-014 nunca foi implementada, esse é um ponto de integração NOVO desta sessão, não um ajuste**).

### 2.4 `StorageInvoiceService` (Nota de Armazenagem — RF-FIS-020/RN-FIS-021)

Registro (upload XML/manual — mesma decisão de origem do dado acima, documentada), validação completa (emitente/destinatário/natureza/referência/quantidade ≤ recebido-não-coberto), crédito do Estoque Fiscal.

### 2.5 `FiscalConsumptionService` (ordem de consumo — RN-FIS-030 — `[VALIDAR CONTABILIDADE]` já confirmado, pode implementar)

Seleção de notas por `FIFO_EMISSAO`/`LIFO_EMISSAO`/`MANUAL` (com exceção `FIS.CONSUMO_MANUAL`), reaproveitando o mesmo estilo de `stock-selection.util.ts` (DOC-05) — função pura de seleção + service de I/O, mesma separação já estabelecida no projeto.

### 2.6 `StorageReturnInvoiceService` (Nota de Devolução — RN-FIS-040)

Montagem com uma linha por (produto × nota consumida), dupla checagem de saldo (montagem + "autorização" — nesta sessão, "autorização" é um método explícito chamável — a 8B substitui o disparo manual pelo disparo real via SEFAZ), rejeição determinística com o texto exato do exemplo normativo ("saldo fiscal disponível: 1.000"). **Este é o serviço que `DispatchService.confirmFiscalDocuments()` passa a chamar** para `fiscal_mode IN ('EMISSAO_PROPRIA', 'HIBRIDO')`.

`reverseConsumption()` (RN-FIS-041) — método isolado, sem gatilho automático (DOC-07 não existe ainda), testável diretamente.

### 2.7 `WriteOffPendingService` (RN-FIS-070)

Ganchos em `stock-reclassification.service.ts` (descarte) e `inventory-count-execution.service.ts::decideAdjustment` (ajuste negativo): quando o produto tem `fiscal_stock_balance`, cria `fiscal_pending_document` e incrementa `qty_pending_writeoff`.

### 2.8 Fora de escopo desta sessão (fica para 8B ou DOC-07, citar no relatório, não implementar)

Motor de emissão real (montagem de XML NF-e leiaute 4.00, assinatura, transmissão SEFAZ, contingência SVC, cancelamento, CCe, inutilização, certificados A1, DANFE) — tudo de §4.7 do DOC-08 (RNF-FIS-060/061/062/063, RF-FIS-064); gatilho automático de RN-FIS-041 pela Logística Reversa (DOC-07); numeração sequencial-sem-lacunas real da NF-e.

---

## 3. CENÁRIOS GHERKIN (DOC-08 §6 — só os aplicáveis a esta sessão, sem SEFAZ)

```gherkin
Cenário: Consumo FIFO por emissão (exemplo normativo RN-FIS-030 / RG-014)
  Dado notas de armazenagem 1000234 (2026-05-01, 500), 2356899 (2026-06-10, 100), 3216544 (2026-07-02, 400)
  E ordem de consumo FIFO_EMISSAO
  Quando a Nota de Devolução de 700 UN do produto X for montada
  Então ela deve conter 3 linhas: 500 ref 1000234, 100 ref 2356899, 100 ref 3216544
  E cada linha deve citar a nota referenciada no item

Cenário: Emissão acima do saldo fiscal é rejeitada
  Dado saldo fiscal total de 1000 UN do produto X
  Quando a montagem de Nota de Devolução de 1001 UN for solicitada
  Então o sistema deve rejeitar com "saldo fiscal disponível: 1.000"
  E nenhum consumo deve ocorrer

Cenário: Nota de armazenagem não excede o recebido
  Dado 800 UN do produto X recebidas e conferidas e 500 UN já cobertas por nota anterior
  Quando o cliente registrar Nota de Armazenagem com 400 UN do produto X
  Então o registro deve ser rejeitado informando cobertura restante de 300 UN

Cenário: Prazo expirado bloqueia liberação de saída
  Dado NF de entrada com prazo expirado sem Nota de Armazenagem
  Quando um pedido do cliente contendo o produto descoberto for liberado
  Então a validação deve rejeitar o item com mensagem de prazo expirado (RN-FIS-010)
  E o recebimento físico de novas cargas do cliente deve permanecer permitido

Cenário: Descarte trava o lastro imediatamente
  Dado 50 UN descartadas de produto com estoque fiscal
  Quando o descarte for efetivado sem documento de baixa do cliente
  Então qty_pending_writeoff deve registrar 50
  E o saldo fiscal disponível para consumo deve reduzir em 50
  E a pendência documental deve constar registrada
```

---

## 4. TESTES

Integração real (Postgres), 2 execuções consecutivas: o exemplo normativo completo de RG-014/RN-FIS-030 (1.000/1.001, os 3 saldos finais 0/0/300), rejeição de Nota de Armazenagem acima do recebido, prazo expirado bloqueando liberação (reaproveite a fixture de pedido já existente em `expedicao/__tests__`), descarte e ajuste negativo travando `qty_pending_writeoff`, `reverseConsumption()` isolado (sem gatilho de reversa real). Teste de contrato de permissões (`grants-contract.integration.spec.ts`) atualizado com as tabelas novas.

---

## 5. DEFINITION OF DONE

```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções
curl localhost:3000/health/ready
git commit && git push   # inclui este prompt
```

Relatório em `docs/relatorios/SESSAO-8A-relatorio.md`: matriz requisito → arquivo → teste, saída real dos comandos, lacunas/débitos, **e em destaque separado**: o status da homologação contábil (RN-FIS-010/RN-FIS-050) confirmado nesta sessão, porque isso determina se a 8B pode ir para valores de PRODUÇÃO ou só ambiente de homologação SEFAZ.

---

## 6. PRÓXIMO PASSO

**Sessão 8B** — motor de emissão NF-e real: fila/worker dedicado, montagem do XML leiaute 4.00, assinatura com certificado A1 (cifrado), transmissão à SEFAZ (ou a um **simulador**, seguindo o mesmo precedente já usado no projeto para integrações externas sem hardware/serviço real disponível em ambiente de desenvolvimento — ver `apps/backend/src/modules/perifericos/` e o Edge Agent simulador do DOC-11/COL-1), contingência SVC, cancelamento, CCe, inutilização, DANFE, guarda de XML no MinIO com object-lock. 8B substitui o estado "autorização manual/testável" desta sessão pelo fluxo real DRAFT→SIGNED→TRANSMITTED→AUTHORIZED/REJECTED/DENIED→CANCELLED completo do DOC-08 §5.1, e é o que finalmente libera `DispatchService.confirmFiscalDocuments()` para `EMISSAO_PROPRIA`/`HIBRIDO` em produção de verdade.
