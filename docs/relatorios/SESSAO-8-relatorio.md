# Relatório — Sessão 8: DOC-11 (Etiquetas e Periféricos — WMS Edge Agent)

**Data**: 2026-08-23
**Escopo**: protocolo do Edge Agent (RNF-PER-001/002/003), catálogo de dispositivos/estações (RD-PER-001/002), templates de etiqueta e conteúdo GS1 (RN-PER-010/020, RF-PER-021), drivers (impressora térmica/documento, balança, cancela/catraca, LPR), simulador de referência (`@wms/edge-agent`), e fechamento das lacunas `[LACUNA: DOC-11]` em recebimento/expedição/portaria.
**Contexto autorizado**: `docs/DOC-00-documento-mestre.md`, `docs/DOC-11-etiquetas-perifericos.md`, `docs/relatorios/MARCO-estado-do-sistema.md`.

---

## 1. Resumo executivo

Os 8 entregáveis da sessão foram implementados e verificados com Postgres/Redis reais e um **WebSocket real** (não simulado por chamada direta de service): a suíte dedicada de protocolo (`edge-agent-protocol.integration.spec.ts`) sobe uma aplicação Nest completa via `app.listen(0)` e conecta o simulador de referência (`EdgeAgentSimulator`, pacote `@wms/edge-agent`) como cliente Socket.IO de verdade contra o `EdgeAgentGateway` real.

- `pnpm build`: limpo (6 pacotes, incluindo o novo `@wms/edge-agent`).
- `pnpm test`: **193/193**.
- `pnpm test:integration`: **278/278**, em **2 execuções consecutivas idênticas**.
- `docker compose up -d --build`: `backend-api`/`backend-worker`/`backend-scheduler` saudáveis.
- `curl localhost:3000/health/ready`: `{"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}`.

Achados reais desta sessão (não hipotéticos — cada um travou a suíte real até ser corrigido):
1. `wms.edge_agent` (Sessão 1) tinha `tenant_id NOT NULL` + RLS, incompatível com RNF-PER-001 ("N agents por armazém", sem noção de agent "do cliente X") — corrigido na origem (migration 0063), não contornado por chamador.
2. `EdgeAgentAdminService.setStatus()`: parâmetro `$2` usado 2× com tipos diferentes (`wms.device_status` e comparação de texto) — Postgres rejeitava com "inconsistent types deduced for parameter $2"; corrigido com cast explícito em ambos os usos.
3. `PeripheralJobService`/`LprService` publicavam evento na mesma transação da escrita de negócio via `transactionGlobal` — `wms.event_outbox` tem RLS e essa combinação é sempre rejeitada para eventos cross-tenant; corrigido trocando para `transactionAsWorker` (ADR-006), com GRANT dedicado a `wms_worker` (migration 0065).
4. `LabelTemplateService`: os métodos de ciclo de vida auditavam sem `warehouse_id`, violando o CHECK de `audit_log` (RD-SEG-030 exige `warehouse_id` exceto LOGIN/LOGOUT) — corrigido threading `warehouseId` (só para rastreabilidade de auditoria; `PER.GESTAO_TEMPLATES` continua GLOBAL, sem restrição por armazém).
5. `EdgeAgentGateway`: os 4 handlers `@SubscribeMessage` não tinham declaração de permissão — o boot da aplicação é abortado por `RouteAuditService` (RN-SEG-012); corrigido com `@Public()` (o gateway não usa RBAC de usuário — autenticação é por token de dispositivo em `handleConnection`).
6. `apps/edge-agent`: o esqueleto da Sessão 1 tinha `tsconfig.json`/`package.json` com `outDir`/`main` apontando para caminhos incompatíveis entre si (nunca funcionaria como dependência de workspace) — corrigido para o padrão local (`dist/`) já usado por `@wms/contracts`/`@wms/ui`.
7. **Fora de DOC-11, achado ao validar `docker compose up --build` do zero**: 6 arquivos usavam `import { Response/Request/NextFunction } from 'express'` como VALOR em vez de `import type` — `express` é CommonJS e, dependendo da resolução de módulo do container, o Node não consegue extrair esses nomes como export nomeado (`SyntaxError: Named export 'Response' not found`), derrubando `backend-api`/`worker`/`scheduler` no boot. Corrigido nos 6 arquivos (`metrics.controller.ts`, `auth.controller.ts`, `reject-actor-spoofing.middleware.ts`, `rate-limit.guard.ts`, `audit.controller.ts`, `dashboard.controller.ts`) — todos usavam esses tipos só em anotação, nunca como valor.

---

## 2. Decisões de arquitetura e desvios documentados

### 2.1 `peripheral_device`/`workstation`/`workstation_device`/`label_template`/`lpr_reading`/`peripheral_job` são GLOBAL (sem RLS)

DOC-11 §7 classifica as 5 estruturas de dado como GLOBAL. Seguido literalmente (mesmo padrão de `warehouse`/`zone`/`location`, migration 0008): sem `tenant_id`, `queryGlobal()`/`transactionGlobal()` diretos, GRANT só a `wms_app`. Periféricos são infraestrutura do ARMAZÉM (operador), não dado de cliente — um mesmo dispositivo físico atende N clientes.

### 2.2 `wms.edge_agent` migrado de TENANT+RLS para GLOBAL (`[CONFLITO]` resolvido)

A Sessão 1 (migration 0007, anterior ao DOC-11 existir) deu a `edge_agent` `tenant_id NOT NULL` + RLS por tenant. RNF-PER-001 é explícito: "Um armazém PODE ter N agents" — não há noção de agent "do cliente X". Corrigido na migration 0063 (`DROP POLICY` + `DISABLE ROW LEVEL SECURITY` + `DROP COLUMN tenant_id`), mesmo princípio de `[[wms-root-cause-not-callers]]`: corrigir a regra de acesso na origem, não em cada chamador. Nenhum dado de produção existia para este recurso.

### 2.3 `wms.edge_agent_job` (Sessão 1) foi DROPADA e substituída por `wms.peripheral_job`

A tabela antiga tinha estados (`EM_PROGRESSO`/`COMPLETADO`/`ERRO`) que não batem com o protocolo exato de RNF-PER-002 (`ENVIADO`/`EXECUTANDO`/`CONCLUIDO`/`FALHA`/`EXPIRADO`) e nunca teve um consumidor real (só 2 `INSERT`s em SQL cru, sem worker, sem service). Sem dado de produção, migrar para o schema correto (particionado, com `print_entity`/`reprint_seq`, catálogo fechado de `error_code`) custou menos do que carregar dois modelos de fila divergentes para sempre.

### 2.4 Token de dispositivo: hash SHA-256, não Argon2

RNF-PER-001 pede "hash em `edge_agent`" (RD-ARQ-003). A tabela armazenava o token em TEXTO PLANO (nenhum agent real pareado até hoje). Corrigido: token de 32 bytes aleatórios gerado em Node, hash SHA-256 armazenado (`token_hash`). Argon2 (usado para senha de usuário, `PasswordService`) é para resistir a força bruta sobre senhas de BAIXA entropia — um token de API-key de alta entropia não precisa de hash lento.

### 2.5 Sem "workstation" para CANCELA/BALANCA em portaria/expedição

RF-PER-004 modela Estação × dispositivo para 5 funções, mas portaria (cancela) e a pesagem de packing não têm hoje um conceito de "Estação da sessão do usuário" na camada HTTP (nenhuma sessão anterior implementou isso). Resolvido pragmaticamente com `PeripheralDeviceService.findFirstDeviceForWarehouse(warehouseId, function)` — mesmo critério de simplicidade que o código ANTERIOR já usava (`edge_agent` "qualquer um ONLINE" em `gate-in.service.ts`). `[DÉBITO]` uma Estação de verdade (RF-PER-004 completo) fica para quando a UI de portaria/packing existir.

### 2.6 `PeripheralJobService.createAndAwaitJob`: polling, não waiter por evento

A primeira implementação usava um `Map` de "waiters" resolvidos por `applyAgentResult()`. Achado ao escrever o teste com um socket fake síncrono: havia uma corrida real entre "a resposta chega antes do waiter existir" (quando o transporte é local/rápido) e "chega depois" (rede real) — o waiter nunca era criado a tempo e o job só resolvia pelo timeout de 15-17s. Substituído por polling simples (50 ms) sobre `wms.peripheral_job`, que é sempre a fonte da verdade e não tem essa corrida, com o mesmo custo desprezível (jobs WEIGH/GATE_OPEN são baixa frequência).

### 2.7 PDF (RNF-PER-031) fora de escopo de renderização

`CONTEUDO_PALETE` (template opcional, A4/PDF) foi registrado em `label_template` com os campos documentados, mas em `DRAFT` — não existe biblioteca de geração de PDF no projeto. RNF-PER-031 já prevê que o CHAMADOR forneça o PDF pronto (base64/URL) para o job `PRINT_PDF`; nenhum código de negócio depende deste registro para funcionar. `[LACUNA: DOC-11 não define motor de geração de PDF]`.

---

## 3. Matriz requisito → arquivo → teste

| Requisito | Arquivo(s) | Teste |
|---|---|---|
| RNF-PER-001 (registro, heartbeat, token hash) | `devices/edge-agent-admin.service.ts`, `gateway/edge-agent.gateway.ts` | `edge-agent-protocol...spec.ts` (conexão real via simulador em todos os cenários); `sweepStaleHeartbeats` — watchdog de 2 heartbeats perdidos |
| RNF-PER-002 [INVIOLÁVEL] (envelope, máquina de estados, idempotência) | `jobs/peripheral-job.service.ts` | "Job idempotente no reenvio" (executionCountFor==1 após reenvio do mesmo job_id) |
| RNF-PER-003 (telemetria, alerta OFFLINE/ERRO) | `gateway/edge-agent.gateway.ts` (`handleTelemetry`), `devices/peripheral-device.service.ts` (`applyTelemetry`) | Coberto indiretamente (evento `perifericos.dispositivo_erro`); telemetria automática a cada 60s não testada isoladamente (mecanismo idêntico ao heartbeat, já testado) |
| RF-PER-004 (Estações) | `devices/peripheral-device.service.ts` (`resolveDeviceForWorkstation`, `mapDeviceToWorkstation`) | `[DÉBITO]` sem teste de integração dedicado (nenhum caller usa Estação real ainda — ver §2.5) |
| RN-PER-010 [INVIOLÁVEL] (GS1: 1 conteúdo, 2 simbologias) | `gs1/gs1.util.ts` | `gs1.util.spec.ts` (13 testes, unitário — exemplo normativo LPN 129000000000012346); `edge-agent-protocol...spec.ts` "Conteúdo GS1 do LPN" (integração — element string idêntica 2× no ZPL renderizado) |
| RN-PER-020 [INVIOLÁVEL] (versionamento, porta de ativação) | `labels/label-template.service.ts`, `labels/label-render.util.ts` | "ativação de nova versão exige impressão de teste APROVADA" (rejeita ativar sem aprovar, rejeita aprovar sem job CONCLUIDO, ativa e retira a versão anterior) |
| RF-PER-021 (fila 30 min, reimpressão RE1/RE2) | `jobs/peripheral-job.service.ts` (`sweepExpiredJobs`, `nextReprintSeq`), `labels/label-template.controller.ts` (`reimprimir`) | "3 jobs ficam PENDENTE em ordem, executados na ordem ao reconectar"; "expira com alerta"; "Reimpressão marcada e auditada" (RE1 + `audit_log` PRINT) |
| RNF-PER-030 (impressora térmica ZPL) | migration 0061 (catálogo `driver_code`/`function` fechado + CHECK de correspondência) | Coberto pelos testes de impressão (device_code `ZBR-DOC11-01`, driver `ZPL_TCP`) |
| RNF-PER-031 (documentos PRINT_PDF) | — | `[LACUNA]` ver §2.7 |
| RNF-PER-040 [INVIOLÁVEL] (balança: só Peso Estável, device_code+raw_frame) | `expedicao/packing/package.service.ts` (`weighFromScale`), migration 0064 | "Peso gravado com evidência" e "Peso apenas estável" (`picking-packing-carregamento...spec.ts`) |
| RNF-PER-050 (cancela/catraca, sem retry) | `portaria/gate-in/gate-in.service.ts`, `gate-out/gate-out.service.ts` (`triggerCancelaJob`) | `gate-in-within-window...spec.ts` (fallback DEVICE_OFFLINE); "Cancela sem retry automático" (`edge-agent-protocol...spec.ts`) |
| RNF-PER-060 (LPR: push, normalização, confiança mínima) | `lpr/lpr.service.ts`, `gateway/edge-agent.gateway.ts` (`handleLprReading`), `portaria/gate-in/gate-in.service.ts` (`lpr_reading_id` opcional) | "LPR abaixo da confiança não confirma sozinho" |
| §5.1 [INVIOLÁVEL] Retry assimétrico (só PRINT_*, máx. 3) | `jobs/peripheral-job.service.ts` (`applyAgentResult`), CHECK `peripheral_job_no_auto_retry_weigh_gate` | "Retry assimétrico: PRINT_ZPL falha 2x e tenta de novo até CONCLUIDO"; "Cancela sem retry automático" |
| RD-PER-001..005 (schema) | migrations 0061/0062/0063 | `grants-contract.integration.spec.ts` (declaração de grants de todas as 6 tabelas novas) |
| Entregável 6 — lacunas fechadas | `recebimento/labeling/labeling.service.ts` (RF-REC-030, print job LPN_PALETE); `expedicao/packing/package.service.ts` (RF-EXP-050, `weighFromScale`); `portaria/gate-in`+`gate-out` (RF-POR-014, cancela real); `portaria/gate-in` (RF-POR-010, `lpr_reading_id`) | Ver linhas WEIGH/CANCELA acima; impressão de LPN coberta indiretamente (mesmo `PeripheralJobService.createLabelPrintJob` já testado) |
| Entregável 7 — simulador de referência | `apps/edge-agent/src/simulator.ts` (`EdgeAgentSimulator`) | Usado por TODOS os testes de `edge-agent-protocol...spec.ts` — conexão WebSocket real, não chamada direta de service |
| Entregável 8 — testes de integração do §6 | `perifericos/__tests__/edge-agent-protocol.integration.spec.ts` (9 testes), `expedicao/__tests__/picking-packing-carregamento...spec.ts` (+2), regressão completa | Ver §1 |

---

## 4. Lacunas e débitos

- `[LACUNA]` RNF-PER-031 (PRINT_PDF): nenhum motor de geração de PDF no projeto — ver §2.7.
- `[DÉBITO]` RF-PER-004 (Estações): nenhum caller real usa `resolveDeviceForWorkstation()` ainda — portaria/packing resolvem por "primeiro dispositivo da função no armazém" (§2.5). Migrar para Estação real quando a UI correspondente existir.
- `[DÉBITO]` RNF-PER-003 (telemetria automática do simulador a cada 60s): mecanismo implementado e idêntico ao heartbeat (já testado), mas sem teste de integração dedicado ao ciclo automático de 60s (testado via envio manual/`sendTelemetry`, não pelo timer).
- `[DÉBITO]` Nenhum controller HTTP para `LprService`/consulta de sugestão de placa por pista (RF-POR-010) — a integração é só a nível de service (gate-in aceita `lpr_reading_id` opcional); a tela de portaria que consumiria isso é de uma sessão futura de frontend.
- `[DÉBITO]` `PeripheralDeviceController`/`LabelTemplateController` não têm teste de integração HTTP dedicado (cobertos indiretamente pelo boot real da suite de protocolo, que valida `RouteAuditService`, e pelos services por trás deles, exercitados diretamente).
- Achados de infraestrutura fora do escopo estrito de DOC-11 (mas necessários para o DoD real, ver §1 item 7): 6 imports `import { Tipo } from 'express'` corrigidos para `import type`.

---

## 5. Evidência

### 5.1 Build

```
$ pnpm build
Tasks: 6 successful, 6 total   # inclui @wms/edge-agent (novo)
```

### 5.2 Testes unitários

```
$ pnpm test
@wms/backend:test — Tests 193 passed (193)
@wms/ui:test — Tests 19 passed (19)
@wms/frontend:test — Tests 1 passed (1)
```

### 5.3 Testes de integração — 2 execuções consecutivas

```
$ pnpm --filter @wms/backend test:integration   # execução 1
Test Files  69 passed (69)
     Tests  278 passed (278)
   Duration  162.70s

$ pnpm --filter @wms/backend test:integration   # execução 2
Test Files  69 passed (69)
     Tests  278 passed (278)
   Duration  162.61s
```

### 5.4 Docker + health check

```
$ docker compose -f infra/docker-compose.yml up -d --build
 Image infra-backend-api Built
 Image infra-backend-scheduler Built
 Image infra-backend-worker Built
 Container wms-backend-api      Started
 Container wms-backend-worker   Started
 Container wms-backend-scheduler Started

$ curl localhost:3000/health/ready
{"status":"ok","timestamp":"2026-08-23T14:08:08.188Z","service":"wms-api","checks":{"postgresql":"ok","redis":"ok"},"version":"0.0.1"}

$ docker compose ps
wms-backend-api         Up (healthy)
wms-backend-scheduler   Up (healthy)
wms-backend-worker      Up (healthy)
```

---

## 6. Commit

Este relatório e `docs/PROMPT-SESSAO-8-doc11-perifericos.md` fazem parte do commit desta sessão. `CLAUDE.md` e `docs/relatorios/ESTADO-E-ROTEIRO.md`/`ROTEIRO-DESENVOLVIMENTO.md` — não produzidos por esta sessão de DOC-11, mas incluídos no mesmo commit a pedido do usuário.
