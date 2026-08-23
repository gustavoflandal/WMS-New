# PROMPT — SESSÃO COL-1: PLATAFORMA PWA DE COLETOR (ONLINE)
## Especificação de Execução

| Metadado | Valor |
|---|---|
| Sessão | COL-1 |
| Módulo | DOC-15 (Operação em Campo — PWA), §10 (posição no plano) |
| Dependência de | DOC-00 v1.4.0 (§2.2 stack congelada), DOC-01 (RNF-ARQ-050/RF-ARQ-051/052/RN-ARQ-053/RNF-ARQ-054 — referenciados, não redefinidos), DOC-02, DOC-05 §4.7 (Sessão 5C ✓), DOC-11 (Sessão 8 ✓), DOC-12 (RF-SEG-004) |
| Modelo | Sonnet (médio — UI Next.js, IndexedDB mínimo, integração multi-módulo) |
| Data de Abertura | 2026-08-23 |
| Stack | Next.js 14 (App Router) + Tailwind + `@wms/ui` + TypeScript — dentro de `apps/frontend/` (DOC-00 §2.2 `[INVIOLÁVEL]`). **Nenhum app/framework novo.** |
| Alvo | Área `field` do PWA: registro de dispositivo, leitura de código (wedge + câmera), validador universal, sessão com PIN, telas **T1 (Minhas Tarefas)**, **T7 (Consulta)**, **T8 (Sincronização)** — todas ONLINE |
| Posição no Plano | COL-1, após Sessão 5C ✓ (motor de inventário) e Sessão 8 ✓ (DOC-11). Antes de **COL-2** (offline: T2–T6, Pacote de Turno, fila, RN-ARQ-053). |

---

## 1. CONTEXTO E CORREÇÃO DE ESCOPO

Um rascunho anterior deste prompt (a) propunha React Native/Expo — violava DOC-00 §2.2 (`[INVIOLÁVEL]`: "É PROIBIDO introduzir outras linguagens, frameworks de UI... sem alteração formal deste documento") e o próprio DOC-15 (título: "PWA para Coletores e Smartphones Android"; §8 lista "Aplicativo nativo Android/iOS" como FORA DE ESCOPO); e (b) listava T1=Putaway, T7=Consulta, T8=LPN, T5=Contagem — um catálogo que não existe no DOC-15.

**DOC-15 §4.5 define um catálogo FECHADO de 8 telas** ("É PROIBIDO criar telas fora deste catálogo sem nova versão deste documento"):

| # | Tela | Offline? (RNF-ARQ-050) |
|---|---|---|
| T1 | Minhas Tarefas — fila do operador, auto-atribuição | sim (do Pacote de Turno) |
| T2 | Putaway (RF-REC-042) | sim |
| T3 | Picking (RF-EXP-031) | sim |
| T4 | Conferência (RF-REC-021) | sim |
| T5 | Contagem de Inventário (motor 5C, §4.7) | sim |
| T6 | Transferência/Reposição (RF-EST-050/042) | sim |
| **T7** | **Consulta** — leitura de LPN/endereço/EAN, somente leitura | **NÃO (exige conexão)** |
| **T8** | **Sincronização** — fila local por estado, decisões recebidas, reenvio | — |

**DOC-15 §10 (posição no plano) já define a divisão entre sessões**, e este prompt a segue à risca:

> "Sessão COL-1 (**plataforma**: registro de dispositivo, wedge+câmera, validador universal, sessão/PIN, **T1/T7/T8, online**) → Sessão COL-2 (**offline**: Pacote de Turno, fila, RN-ARQ-053 no servidor, **T2–T6 offline**, atualização controlada)."

Ou seja: **T2 (Putaway), T3 (Picking), T4 (Conferência), T5 (Contagem) e T6 (Transferência) — todas as telas de EXECUÇÃO — são objeto da Sessão COL-2**, porque dependem da infraestrutura offline (Pacote de Turno, `sync_operation`/fila, resolução de conflitos RN-ARQ-053) que ainda não existe. A Sessão COL-1 entrega a **plataforma** (o que as 5 telas de execução vão usar depois) mais as **3 telas que fazem sentido sem offline**: T1 (lista — não executa nada), T7 (exige conexão por definição do próprio DOC-15) e T8 (mostra o estado da fila — hoje sempre vazia, já que a fila offline real é da COL-2, mas a tela e o endpoint de status devem existir).

**Por que isso importa de verdade, não é só formalismo:** implementar T2/T5 (execução) sem a infraestrutura offline da COL-2 either (a) finge que são telas online-only, contradizendo RNF-ARQ-050 (que classifica putaway/picking/conferência/contagem como as tarefas que DEVEM funcionar offline), ou (b) implementa só a metade online e deixa a promessa de campo (operação sem sinal, comum em armazém) sem sustentação — melhor entregar a plataforma sólida agora e as 5 telas de execução completas (online E offline) na COL-2.

---

## 2. ESTADO REAL DO BACKEND (levantado nesta sessão — não presumir nada além disto)

- **`wms.sync_operation`** (RD-ARQ-002) — existe desde a migration 0006, mas é **só schema**: nenhum service/controller a usa. A fila real (RF-ARQ-052) é da COL-2.
- **`wms.field_device`** (RD-COL-001) — **não existe**. Novo nesta sessão.
- **RF-SEG-004 (PIN de coletor)** — só texto no DOC-12; **nada implementado** (sem campo de PIN em `wms.user`, sem endpoint, sem lógica de inatividade). Novo nesta sessão.
- **Permissões `COL.*`** — nenhuma existe. Novas: `COL.OPERAR` (WAREHOUSE), `COL.DISPOSITIVO_GERIR` (WAREHOUSE, sensível), `COL.CONSULTA_SALDO` (CLIENT_WAREHOUSE).
- **T1 (Minhas Tarefas)**: `PutawayTaskService.listQueue()`/`ReplenishmentTaskService.listQueue()` existem mas são a fila INTEIRA do armazém (não filtrada por `assigned_to_user_id`), e `PickingTaskService` não tem list por operador (só por `outbound_order_id`). **Não existe hoje nenhuma consulta cross-módulo "minhas tarefas"** — é nova.
- **T7 (Consulta)**: **nenhum endpoint GET de busca de saldo existe** em `modules/estoque/` (confirmado: nenhum controller expõe `stock_balance` para busca por SKU/código). Novo.
- **`apps/frontend`**: só tem a área `(internal)` (DOC-10); nenhum manifest/service-worker/dependência de PWA existe ainda. Área `field` é nova, mas **dentro do mesmo app Next.js**.

---

## 3. ENTREGÁVEIS DESTA SESSÃO

### 3.1 Backend — `apps/backend/src/modules/campo/` (novo módulo, prefixo `COL`)

1. **Migration**: catálogo `COL.OPERAR`/`COL.DISPOSITIVO_GERIR`/`COL.CONSULTA_SALDO`; `wms.field_device` (RD-COL-001: `device_id` UUID único, `warehouse_id`, `user_agent`, `app_version`, `last_seen_at`, `last_sync_at`, `status` ACTIVE/BLOCKED — GLOBAL, mesmo padrão de `peripheral_device`); coluna de PIN em `wms.user` (`pin_hash`, hash Argon2 — reaproveita `PasswordService`) + parâmetros `COL.SCAN_TERMINADOR`, `COL.VERSAO_MINIMA`, `COL.FEEDBACK_SONORO`.
2. **`FieldDeviceService`/`FieldDeviceController`** (RNF-COL-003): `POST /campo/dispositivos` (registra `device_id` no primeiro login), `POST /campo/dispositivos/:id/bloquear` (`COL.DISPOSITIVO_GERIR`).
3. **PIN (RF-SEG-004/RF-COL-030)**: endpoint para definir PIN pessoal; endpoint de re-autenticação por PIN (bloqueio após 3 falhas → exige login completo). Reaproveita `JwtService`/`PasswordService`, não duplica o fluxo de login completo.
4. **T1 — `MyTasksController`** (`GET /campo/minhas-tarefas`, `COL.OPERAR`): agrega `putaway_task` + `replenishment_task` (ambos já têm `assigned_to_user_id`) filtrados pelo usuário autenticado; `picking_task` fica de fora nesta sessão **`[LACUNA: PickingTaskService não tem coluna/consulta por operador nem lista cross-order — exigiria mudança no módulo de expedição, fora do escopo de COL-1]`** — documentar, não inventar.
5. **T7 — `StockSearchController`** (`GET /campo/consulta?codigo=...`, `COL.CONSULTA_SALDO`): busca por SKU/barcode/LPN, retorna saldo por endereço/lote/validade; endereço em `INVENTORY` aparece com aviso, sem `qty_available` (RF-COL-062/DOC-05 RN-EST-061).
6. **T8 — `SyncStatusController`** (`GET /campo/sincronizacao`, `COL.OPERAR`): lê `wms.sync_operation` por `device_id` (hoje sempre vazio — schema existe, produtor não; a tela deve refletir a realidade, não simular fila).

### 3.2 Frontend — `apps/frontend/src/app/(field)/`

Novo route group `(field)`, mesmo padrão do `(internal)` já existente (não é um projeto novo — é uma área dentro do MESMO Next.js). Rotas: `/field/login`, `/field` (T1), `/field/consulta` (T7), `/field/sincronizacao` (T8).

- `manifest.json` + ícone (RNF-COL-002: `display: standalone`, orientação retrato).
- Service worker mínimo (precache de shell estático) — **sem** fila offline de ações (isso é COL-2; um service worker que finge sincronizar sem produtor real seria pior que não ter nenhum).
- `device_id` gerado na primeira execução (UUID v7), persistido em IndexedDB, enviado no login (RNF-COL-003).
- Listener global de teclado para leitura wedge (RNF-COL-010 `[INVIOLÁVEL]`: SEM depender de campo focado, terminador configurável) + fallback de câmera via `BarcodeDetector` (RNF-COL-011).
- Validador universal de leitura (RN-COL-012 `[INVIOLÁVEL]`): identifica tipo do código lido (LPN via dígito SSCC — reaproveita `validateSsccCheckDigit` de `gs1.util.ts`; endereço via padrão RN-DAD-011; EAN/DUN por comprimento) e rejeita tipo inesperado para o passo atual.
- UX (RNF-COL-020 `[INVIOLÁVEL]`): alvos de toque ≥48dp, tipografia ≥16sp, tema de alto brilho/alto contraste, teclado numérico nativo para quantidade, uma decisão por tela.
- Feedback <100ms (RF-COL-013): som de sucesso≠erro, vibração, flash de borda verde/vermelho.
- Sessão com PIN (RF-COL-030): tela de bloqueio após 5 min de inatividade, PIN de 6 dígitos, 3 falhas → login completo (a fila offline "preservada" não se aplica ainda, pois não há fila real em COL-1).
- Interrupção/retomada (RF-COL-021): não há tarefa em execução em COL-1 (isso é T2-T6), mas a sessão/PIN deve sobreviver a troca de tela.

### 3.3 Fora de escopo desta sessão (fica para COL-2, citar no relatório, não implementar)

T2 (Putaway), T3 (Picking), T4 (Conferência), T5 (Contagem — mesmo com o motor 5C pronto no servidor), T6 (Transferência); Pacote de Turno (RF-ARQ-051); fila de sincronização real e RN-ARQ-053 (decisões do servidor); RNF-ARQ-054 (limite de 500 operações/8h); telemetria RNF-COL-051; atualização controlada RNF-COL-050 (v. mínima bloqueando execução — sem telas de execução em COL-1, não há o que bloquear ainda).

---

## 4. CENÁRIOS GHERKIN (DOC-15 §6 — só os aplicáveis a T1/T7/T8/plataforma)

```gherkin
Cenário: Leitura wedge sem campo focado (RNF-COL-010)
  Dado a tela de Consulta (T7) aberta, nenhum campo com foco
  Quando o leitor físico disparar "7891000100103" + terminador
  Então a leitura deve ser capturada e validada
  E o feedback de sucesso deve ocorrer em menos de 100 ms

Cenário: Tipo de código inesperado é rejeitado (RN-COL-012)
  Dado a Consulta aguardando um código de produto (EAN/LPN)
  Quando o operador ler um código de ENDEREÇO (A1-012-03-02)
  Então a leitura deve ser rejeitada com som e vibração de erro

Cenário: LPN com dígito verificador inválido (RN-PER-010)
  Quando qualquer origem ler "129000000000012345"
  Então a leitura deve ser rejeitada por falha na verificação SSCC

Cenário: Consulta exige conexão (T7, DOC-15 §4.5)
  Dado o dispositivo offline
  Quando o operador abrir a tela de Consulta
  Então a tela deve indicar indisponibilidade offline, sem erro técnico

Cenário: Registro de dispositivo na primeira execução (RNF-COL-003)
  Dado um navegador sem device_id local
  Quando o PWA carregar pela primeira vez
  Então um device_id (UUID v7) deve ser gerado e persistido em IndexedDB
  E enviado ao servidor no login, criando um field_device ACTIVE

Cenário: Bloqueio por PIN após inatividade (RF-COL-030/RF-SEG-004)
  Dado sessão ativa há 5 minutos sem interação
  Quando o operador tentar continuar
  Então a tela deve exigir o PIN de 6 dígitos
  E 3 falhas consecutivas devem exigir login completo

Cenário: Endereço em inventário aparece na Consulta com aviso (T7)
  Dado endereço A1-010-02-01 em status INVENTORY
  Quando o operador consultar esse endereço
  Então a tela deve exibir "Endereço em contagem", sem qty_available
```

---

## 5. TESTES

- **Backend**: integração real (Postgres) para `FieldDeviceService`, PIN (definir + validar + 3 falhas), `MyTasksController` (agrega putaway+replenishment por `assigned_to_user_id`, RLS por armazém), `StockSearchController` (retorna saldo, oculta `qty_available` em endereço `INVENTORY`), `SyncStatusController`. 2 execuções consecutivas.
- **Frontend**: teste do validador universal de leitura (unitário, puro) cobrindo os 3 cenários de rejeição/aceitação de tipo; teste do listener de wedge (sem campo focado); manifest/PWA instalável verificado manualmente (`docker compose` + `curl`/checagem de headers, já que não há Chrome real neste ambiente de CI).

---

## 6. DEFINITION OF DONE

```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções
curl localhost:3000/health/ready
git commit && git push   # inclui este prompt
```

Relatório em `docs/relatorios/SESSAO-COL1-relatorio.md`: matriz requisito → arquivo → teste, saída real dos comandos, lacunas/débitos (citar explicitamente o adiamento de T2–T6 para COL-2 e a lacuna de `picking_task` em "Minhas Tarefas"), decisões tomadas com justificativa.

---

## 7. PRÓXIMO PASSO

Após COL-1: **Sessão COL-2** — Pacote de Turno (RF-ARQ-051), fila de sincronização real sobre `wms.sync_operation` (RF-ARQ-052), resolução determinística de conflitos no servidor (RN-ARQ-053, as 4 decisões), limite de fila (RNF-ARQ-054), e as 5 telas de execução T2–T6 (online E offline), incluindo T5 finalmente ligada ao motor de inventário da Sessão 5C.
