# SESSÃO 8B — Fiscal: motor de emissão NF-e (DOC-08 §4.7/§4.9/§5.1)

| Metadado | Valor |
|---|---|
| Sessão | 8B (parte 2 de 2 — fecha o DOC-08 junto com a 8A) |
| Módulo | DOC-08 §4.7, §4.9, §5.1; DOC-01 §4.7/§4.11 (RNF-ARQ-100); DOC-11 (Edge Agent — referência de simulador) |
| Data | 2026-08-24/25 |
| Prompt | `docs/PROMPT-SESSAO-8B-fiscal-emissao.md` |
| Migration | `infra/postgres/migrations/0070-fiscal-emissao.sql` |
| Plano | `C:\Users\gusta\.claude\plans\harmonic-swinging-clock.md` (aprovado antes da implementação) |

---

## 1. Escopo entregue

Motor de emissão real (RNF-FIS-060): ciclo `DRAFT→SIGNED→TRANSMITTED→AUTHORIZED/
REJECTED/DENIED`, numeração sequencial-sem-lacunas por emitente×série com
reserva atômica, montagem de XML (subconjunto representativo do leiaute 4.00),
assinatura (RSA-SHA256 via certificado A1 decifrado em memória — ver §5 sobre
a limitação de canonicalização), simulador SEFAZ determinístico (usado pelos
testes) + adaptador SOAP real (estruturalmente completo, não exercitado por
integração — mesma decisão já usada pelo Edge Agent). Contingência SVC
(RNF-FIS-061): 3 falhas de transporte → `CONTINGENCIA_SVC`, monitor de
disponibilidade a cada 5 min reverte. Cancelamento e CCe (RNF-FIS-062):
`FIS.PRAZO_CANCELAMENTO_H` (24h), bloqueio por GATE_OUT, exceção
`FIS.CANCELAMENTO_NFE` (2 passos), reaproveita `reverseConsumption()` da 8A;
CCe até 20 eventos/nota. Certificados A1 cifrados (RNF-FIS-063, AES-256-GCM —
primeiro utilitário de cifragem do projeto) e guarda de XML no MinIO (sem
object-lock real — ver débito §7). DANFE (RF-FIS-064) via `pdf-lib`. Inutilização
mensal de número pulado (documentos `DENIED`). `DispatchService.
confirmFiscalDocuments` redesenhado para não mais autorizar sincronamente —
só monta e deixa o worker assíncrono assumir.

---

## 2. Matriz requisito → arquivo → teste

| Requisito | Arquivo(s) principal(is) | Teste |
|---|---|---|
| RNF-FIS-060 (ciclo de emissão, numeração) | `emission/fiscal-emission.service.ts`, `emission/fiscal-issuer.service.ts::reserveNextNumber`, `emission/nfe-xml-builder.util.ts` | `fiscal-emissao.integration.spec.ts` — "assemble()+processDocument()->AUTHORIZED" |
| RNF-FIS-060 (REJECTED→DRAFT mesmo número) | `dispatch.service.ts::confirmFiscalDocuments` | describe "idempotência 8B" — "REJECTED -> ... reaproveitando o nNF" |
| RNF-FIS-060 (inutilização mensal) | `workers/fiscal-number-inutilizacao.worker.impl.ts` | "worker mensal inutiliza o nNF de um documento DENIED" |
| RNF-FIS-061 (contingência SVC) | `fiscal-emission.service.ts::handleTransportFailure`, `workers/fiscal-sefaz-availability.worker.impl.ts` | "3 falhas de transporte consecutivas -> CONTINGENCIA_SVC ... reverte" |
| RNF-FIS-062 (cancelamento) | `storage-return-invoice.service.ts::cancel` | describe "cancelamento e CCe" — cancela dentro do prazo + bloqueio GATE_OUT |
| RNF-FIS-062 (CCe) | `storage-return-invoice.service.ts::registerCce` | "CCe: aceita até 20 eventos ... 21º é rejeitado" |
| RNF-FIS-063 (certificado cifrado) | `core/security/secret-cipher.service.ts`, `emission/fiscal-issuer.service.ts` | exercitado em todo teste (upload real de PFX autoassinado + decrypt na assinatura) |
| RNF-FIS-063 (guarda de XML) | `emission/fiscal-emission.service.ts` (upload via `FileStorageService`) | asserção `fileStorageService.exists(xml_storage_key)` no teste do ciclo completo |
| RF-FIS-064 (DANFE) | `emission/danfe.service.ts` | exercitado dentro do teste do ciclo completo (chamado por `handleAuthorized`) |
| §5.1 (Consumo só efetiva na autorização, cStat 539) | `fiscal-emission.service.ts::handleRejected` | cenário Gherkin normativo — "rejeição cStat 539" |
| §5.1 (DENIED bloqueia o pedido) | `dispatch.service.ts::confirmFiscalDocuments` | "DENIED (cStat 110) -> ... FISCAL_NFE_DENIED_BLOCKED" |
| Contrato de permissões (tabelas novas) | `grants-contract.integration.spec.ts` (`fiscal_issuer`, `fiscal_document_event`) | o próprio teste |
| RN-SEG-012 (rotas com permissão declarada) | `emission/fiscal-issuer.controller.ts`, `storage-return-invoice.controller.ts` | boot real via `docker compose up` — `RouteAuditService` log |

---

## 3. Saída real dos comandos

### 3.1 Build e type-check

```
$ pnpm build (apps/backend)
> nest build
(sem erros)

$ pnpm type-check (apps/backend)
> tsc --noEmit
(sem erros)
```

### 3.2 Testes unitários (`pnpm test`)

```
Test Files  20 passed (20)
     Tests  199 passed (199)
```

(Inalterado em quantidade em relação à 8A — 8B não adicionou testes unitários
puros novos, só integração, já que a lógica nova é toda I/O-dependente:
assinatura, transmissão, cifragem.)

### 3.3 Testes de integração (`pnpm test:integration`, 2 execuções consecutivas)

```
$ pnpm test:integration   # execução 1
 Test Files  73 passed (73)
      Tests  318 passed (318)
   Duration  175.53s

$ pnpm test:integration   # execução 2 (consecutiva, mesmo estado de banco)
 Test Files  73 passed (73)
      Tests  318 passed (318)
   Duration  175.46s
```

318 testes (era 309 antes da sessão — +9: 8 do novo
`fiscal-emissao.integration.spec.ts`, +0 líquido nos demais arquivos, já que
`fiscal-estoque.integration.spec.ts` só teve `authorize()` renomeado para
`effectuateAuthorization()` nas 2 chamadas existentes, sem novo teste). Zero
skip, idênticos nas duas execuções.

### 3.4 Docker compose + health check

```
$ docker compose -f infra/docker-compose.yml up -d --build
 Container wms-postgres Healthy
 Container wms-redis Healthy
 Container wms-minio Healthy
 Container wms-backend-api Healthy
 Container wms-backend-worker Healthy
 Container wms-backend-scheduler Healthy
 Container wms-frontend Started

$ curl -s localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-25T01:16:15.835Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}
```

Log de boot (`backend-api`, `backend-worker`, `backend-scheduler`) confirma
`RouteAuditService`: "RN-SEG-012: todas as rotas REST e handlers WebSocket
declaram permissão. Boot liberado." — `FiscalIssuerController` e as rotas
novas de `StorageReturnInvoiceController` (cancelar/cce) não ficaram sem
`@RequirePermission`. `backend-worker` confirma `FiscalEmissionWorkerImpl`
iniciado; `backend-scheduler` confirma os 3 workers novos
(`FiscalSefazAvailabilityWorkerImpl`, `FiscalIssuerCertExpiryWorkerImpl`,
`FiscalNumberInutilizacaoWorkerImpl`) iniciados sem erro.

---

## 4. Achados reais durante a verificação (documentados, não escondidos)

### 4.1 `effectuateAuthorization()` (ex-`authorize()`) rejeitava o caminho real do motor

A 8A implementou `authorize()` esperando ser chamado sobre um documento
`DRAFT` (chamada síncrona logo após `assemble()`). O motor real da 8B avança
o documento por `SIGNED`→`TRANSMITTED` ANTES de chamar essa lógica (só na
resposta `cStat 100`) — a guarda antiga (`status !== 'DRAFT'` lança
`ConflictException`) rejeitava toda autorização real. Encontrado pelo
primeiro teste de ciclo completo falhando com `ConflictException` genérica.
Corrigido: a guarda agora aceita `DRAFT` OU `TRANSMITTED` (documentado no
código — 8A chama sobre DRAFT via `assembleAndAuthorizeForOrder`, uso de
teste; 8B chama sobre TRANSMITTED, caminho de produção).

### 4.2 `wms_worker` sem SELECT em `fiscal_document_event` — só apareceu via `docker compose up`

Os testes de integração (schema recriado do zero a cada execução) não
pegaram isto porque a declaração em `DECLARED_GRANTS` e o GRANT real da
migration estavam consistentes ENTRE SI (ambos diziam "nenhum acesso"),
mesmo sem ser SUFICIENTE para o código — o teste de contrato garante
declarado == real, não declarado == necessário. Só apareceu ao rodar
`docker compose up` de verdade: `FiscalNumberInutilizacaoWorkerImpl` faz um
`NOT EXISTS` contra `fiscal_document_event` DENTRO do scan cross-tenant
(`transactionAsWorker`, papel `wms_worker`) para decidir quais documentos já
têm evento de inutilização — mesmo sendo só leitura, Postgres exige GRANT
para a subquery. Corrigido: `GRANT SELECT ON wms.fiscal_document_event TO
wms_worker` adicionado à migration 0070 e a `DECLARED_GRANTS` atualizada;
como o volume de desenvolvimento já tinha a migration 70 registrada (sem o
GRANT novo), apliquei o GRANT faltante diretamente nesse Postgres via
`docker exec ... psql` antes de reiniciar os containers — um ambiente NOVO
roda a migration corrigida de uma vez, sem passo manual. Depois de corrigir,
adicionei um teste de integração dedicado ao `FiscalNumberInutilizacaoWorkerImpl`
(não existia antes) — a lacuna de cobertura que deixou esse bug passar
despercebido pelos testes está fechada.

### 4.3 `setTimeout` com o default de 30 dias do worker mensal excedia o limite de 32 bits

Só apareceu nos logs do `docker compose up` (`TimeoutOverflowWarning: ...
does not fit into a 32-bit signed integer. Timeout duration was set to 1.`) —
`pollIntervalMs` default de `FiscalNumberInutilizacaoWorkerImpl`
(30×24×60×60×1000 = 2.592.000.000 ms) excede o máximo de `setTimeout`
(2³¹-1 ≈ 2.147.483.647 ms, ~24,8 dias); o Node grampeia silenciosamente para
1 ms, transformando o "worker mensal" num loop apertado. Os testes de
integração não bateram nisso porque instanciam o worker sempre com
`pollIntervalMs` explícito (curto). Corrigido: `sleep()` agora encadeia
esperas em blocos ≤ 2³¹-1 ms até completar o total pedido — reutilizável
para qualquer worker futuro com cadência longa.

### 4.4 Ambiente de desenvolvimento sem `MINIO_ENDPOINT`/`SECRET_ENCRYPTION_KEY` nos containers de backend

Achado ao planejar (não ao executar): `infra/docker-compose.yml` nunca
declarou `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/
`MINIO_BUCKET_NAME` nos serviços `backend-api`/`backend-worker`/
`backend-scheduler` — `FileStorageService` caía no default
`http://localhost:9000`, que dentro do container aponta para o próprio
container, não para `wms-minio`. Bug pré-existente do DOC-04 (upload de foto
de avaria), nunca exercitado ponta a ponta via `docker compose` antes desta
sessão. Corrigido nos 3 serviços, apontando para `http://wms-minio:9000`
(nome do serviço na rede docker). `SECRET_ENCRYPTION_KEY` (novo, desta
sessão) adicionado nos mesmos 3 serviços e em `.env`/`.env.test`/
`.env.example`/`.env.test.example`.

---

## 5. Decisões tomadas, com justificativa

1. **Novas dependências `pdf-lib` e `node-forge`** — aprovadas explicitamente
   pelo usuário antes de codar (nenhuma lib de PDF nem de PKCS12/crypto
   existia no projeto; DOC-00 §2.2 exige pausa antes de adicionar dependência
   à stack congelada). `pdf-lib`: geração do DANFE. `node-forge`: parsing de
   certificado A1 (PKCS12) e chave privada para assinatura.

2. **`SefazSimulatorAdapter` roteia pela chave de acesso embutida em
   `<simKey>`** — mesmo espírito do simulador do Edge Agent (DOC-11): um
   adaptador real, não um mock, que os testes de integração exercitam
   diretamente. Como o nNF só é conhecido depois da reserva atômica (dentro
   do próprio `processDocument()`), os testes que precisam de uma resposta
   forçada (rejeição/denegação específica) usam `processWithForcedResponse`
   (substitui `transmit()` temporariamente) em vez de tentar prever a chave.

3. **`fiscal_issuer` com RLS por `tenant_id`**, apesar de RD-FIS-004 marcar
   escopo "GLOBAL" — interpretado como "não é parâmetro do dia a dia", não
   "sem tenant". Certificado cifrado é dado sensível por cliente; manter RLS
   é a leitura mais segura e consistente com toda tabela de tenant do
   projeto. Documentado explicitamente na migration.

4. **Cada etapa do motor de emissão é uma transação própria** (claim→assina,
   transmite, trata retorno), nunca uma transação única cruzando a chamada de
   rede à SEFAZ — não se seguraria conexão/lock de Postgres através de I/O
   externo lento. O claim inicial (`UPDATE ... WHERE status='DRAFT'`) é a
   guarda otimista contra duas instâncias do worker processarem o mesmo
   documento simultaneamente — não precisou de `FOR UPDATE SKIP LOCKED`
   cross-processo porque a reserva de número só acontece DEPOIS do claim ter
   sucesso.

5. **`confirmFiscalDocuments()` reformulado**: só `assemble()` (não mais
   `assembleAndAuthorizeForOrder()`), com idempotência estendida por status
   do `fiscal_document` (`DRAFT/SIGNED/TRANSMITTED` = ainda processando;
   `REJECTED` = reabre o MESMO documento para `DRAFT`, reaproveitando o
   número; `DENIED` = bloqueia com erro explícito, `[LACUNA: DOC-08]` — sem
   workflow de recuperação definido pela especificação). `assembleAndAuthorizeForOrder`
   foi MANTIDO (não removido) como utilitário de teste da 8A — só deixou de
   ser chamado pelo `DispatchService`. `attemptCompleteDispatchStep()`
   (o gate real da etapa Expedição) não precisou de nenhuma mudança: já
   dependia só de `fiscal_documents_authorized_at` estar preenchido, não de
   COMO foi preenchido.

6. **Quem grava `outbound_order.fiscal_documents_authorized_at`**: o próprio
   `FiscalEmissionService`, via `DatabaseService` com o `TenantContext`
   reconstruído a partir do `fiscal_document` (mesmo pool `wms_app`, contexto
   de tenant normal) — não via `DispatchService`, para não inverter a direção
   de dependência entre os módulos `fiscal`/`expedicao` (que hoje só vai de
   `expedicao` para `fiscal`).

7. **Rota HTTP de "autorizar" manualmente (existente na 8A) foi REMOVIDA** —
   deixá-la exposta seria um bypass real do motor de emissão agora que ele
   existe. `effectuateAuthorization()` só é chamado internamente pelo worker.

8. **Cancelamento/CCe ficam em `StorageReturnInvoiceService`**, não num novo
   arquivo em `emission/` — esse serviço já é dono do ciclo de vida da Nota
   de Devolução e já tinha `reverseConsumption()` pronto para reaproveitar.
   `emission/` ficou só com o pipeline de transmissão.

9. **Bloqueio de cancelamento por circulação** checa
   `outbound_order.status IN ('GATE_OUT', 'COMPLETED')` — a spec só cita
   "GATE_OUT" textualmente, mas `COMPLETED` é estritamente posterior no
   fluxo (mercadoria já circulou de qualquer forma), incluído por coerência.

10. **`total_value` da Nota de Devolução permanece 0** — `RD-FIS-001`
    (`fiscal_document_item`, herdado da 8A) não modela preço unitário, só
    quantidade; RG-014 trata o Estoque Fiscal em quantidade, não valor.
    Documentado no código, não uma omissão silenciosa.

---

## 6. Eventos de domínio publicados nesta sessão

`fiscal.nota_rejeitada`, `fiscal.contingencia_ativada`, `fiscal.nota_cancelada`,
`fiscal.cce_registrada`. (`fiscal.nota_autorizada`/`fiscal.consumo_efetivado`
já existiam da 8A, publicados por `effectuateAuthorization()` sem mudança.)
Não publicado: um evento dedicado de denegação — o catálogo do DOC-08 §4.9
não lista um evento específico para DENIED, então não foi inventado um.

---

## 7. Lacunas e débitos

**Em aberto:**

- **`[LACUNA: DOC-08]`** recuperação de nota `DENIED` — §5.1 diz "número
  consumido, pedido bloqueado p/ tratamento", sem definir o workflow de
  desbloqueio. `confirmFiscalDocuments()` bloqueia explicitamente
  (`FISCAL_NFE_DENIED_BLOCKED`) em vez de inventar um fluxo não especificado.
- **`[DEBITO: 8B]`** assinatura XML-DSig sem canonicalização C14N —
  `xml-dsig.util.ts` assina SHA-256/RSA do XML bruto, não o C14N exigido pelo
  padrão real da SEFAZ. Nenhuma lib de canonicalização foi aprovada nesta
  sessão (só `node-forge`, para PKCS12+RSA). Só afeta `SefazSoapClientAdapter`
  (produção, não exercitado pelos testes) — o simulador não precisa de
  assinatura válida.
- **`[DEBITO: 8B]`** `SefazSoapClientAdapter` tem só 1 UF cadastrada (SP) na
  tabela de endpoints — completar com a tabela oficial de webservices por
  UF/SVC antes de qualquer uso real.
- **`[DEBITO: 8B]`** guarda de XML/DANFE no MinIO SEM object-lock real nem
  retenção mínima de 5 anos (RNF-FIS-063/RNF-ARQ-092) — `FileStorageService`
  não foi estendido com retenção, e o bucket não foi criado com object-lock
  habilitado (não é retroativo). É persistência simples, sem trava de
  exclusão. Fechar exige mudança de infraestrutura (recriar bucket com
  object-lock) fora do escopo desta sessão.
- **`[DEBITO: 8B]`** sem teste de integração para o adaptador
  `SefazSoapClientAdapter` real (unitário, sem rede) — só o simulador é
  exercitado por integração, decisão de escopo já explicada no prompt §2.3,
  mas nenhum teste unitário isolado foi escrito para o adaptador real nesta
  sessão.

**Fechados nesta sessão**: os 4 achados de §4 (guarda de status em
`effectuateAuthorization()`, grant de `fiscal_document_event` para
`wms_worker`, overflow de `setTimeout` no worker mensal, variáveis de
ambiente MinIO/SECRET_ENCRYPTION_KEY ausentes nos containers de backend).

---

## 8. Confirmação da pré-condição do prompt (topo do `PROMPT-SESSAO-8B`)

Confirmado no relatório da 8A (§6): prazo de regularização
(`FIS.PRAZO_ENTRADA_DIAS`), ordem de consumo (`FIS.ORDEM_CONSUMO`) e
CFOP/naturezas (`operation_nature`) já eram, antes desta sessão, parâmetro de
cadastro reconfigurável por cliente×armazém via `app_parameter`/
`operation_nature`, com fallback GLOBAL — não uma homologação nacional única
a esperar. `FIS.AMBIENTE` (nesta sessão modelado como coluna
`fiscal_issuer.ambiente`, não `app_parameter`) tem default `HOMOLOGACAO`
(`fiscal-issuer.service.ts::register`), confirmando a pré-condição.

---

## 9. Arquivos desta sessão

Migration: `infra/postgres/migrations/0070-fiscal-emissao.sql`.

Módulo novo: `apps/backend/src/modules/fiscal/emission/**` (sefaz-client.port.ts,
sefaz-simulator.adapter.ts, sefaz-soap-client.adapter.ts, xml-dsig.util.ts,
nfe-xml-builder.util.ts, fiscal-issuer.service.ts, fiscal-issuer.controller.ts,
danfe.service.ts, fiscal-emission.service.ts, `__tests__/fiscal-emissao.integration.spec.ts`).

Core novo: `apps/backend/src/core/security/secret-cipher.service.ts` +
`security.module.ts`.

Workers novos: `fiscal-emission.worker.impl.ts`,
`fiscal-sefaz-availability.worker.impl.ts`,
`fiscal-issuer-cert-expiry.worker.impl.ts`,
`fiscal-number-inutilizacao.worker.impl.ts`.

Modificados: `storage-return-invoice.service.ts` (rename `authorize`→
`effectuateAuthorization`, +`cancel`/+`registerCce`), `storage-return-invoice.controller.ts`
(rotas cancelar/cce, rota autorizar removida), `dispatch.service.ts`
(`confirmFiscalDocuments` reformulado), `fiscal.module.ts` (wiring),
`main.ts` (wiring dos 4 workers), `alert.service.ts` (+`CERTIFICADO_FISCAL_EXPIRANDO`),
`file-storage.service.ts` (+`download`), `grants-contract.integration.spec.ts`
(+`fiscal_issuer`, +`fiscal_document_event`), `fiscal-estoque.integration.spec.ts`
(rename de chamadas), `package.json` (+`pdf-lib`, +`node-forge`, +`@types/node-forge`),
`infra/docker-compose.yml` (+MinIO/`SECRET_ENCRYPTION_KEY` em backend-api/worker/scheduler),
`.env`/`.env.example`/`.env.test`/`.env.test.example` (+`SECRET_ENCRYPTION_KEY`).
