# PROMPT — SESSÃO COL-2B: TELAS DE EXECUÇÃO OFFLINE T2–T6 (FRONTEND)

## Especificação de Execução

| Metadado | Valor |
|---|---|
| Sessão | COL-2B (parte 2 de 2 — frontend; consome a API da COL-2A) |
| Módulo | DOC-15 (Operação em Campo), §4.5 (T2–T6), §4.6 (offline), §4.7 (T5 detalhado), §10 |
| Dependência de | DOC-00 v1.4.0 (§2.2 stack congelada), Sessão COL-1 ✓ (plataforma, `useWedgeScanner`/`useCameraScanner`/`scanner.ts`/`field-api.ts`), Sessão COL-2A (endpoints `/campo/pacote-turno` e `/campo/sincronizacao` — **abrir esta sessão só depois da COL-2A estar commitada**) |
| Modelo | Sonnet (médio — UI Next.js + IndexedDB, sem algoritmo novo: a lógica de negócio já está nos services do backend) |
| Data de Abertura | — (abrir após COL-2A) |
| Stack | Next.js 14 (App Router) + Tailwind + `@wms/ui` + `idb` (IndexedDB), dentro de `apps/frontend/` (DOC-00 §2.2 `[INVIOLÁVEL]`). **Nenhum app/framework novo.** |
| Alvo | IndexedDB do Pacote de Turno e da fila local, telas **T2 (Putaway)**, **T3 (Picking)**, **T4 (Conferência)**, **T5 (Contagem)**, **T6 (Transferência/Reposição)**, sincronização oportunista, bloqueios client-side (fila e versão) |
| Posição no Plano | COL-2B, após COL-2A. Fecha o débito "PWA — Session 3" citado nas auditorias (DOC-15 §10). |

---

## 1. ESTADO REAL DO FRONTEND (herdado da COL-1 — reaproveitar, não duplicar)

- **`useWedgeScanner(onScan, enabled)`** (`src/lib/field/use-wedge-scanner.ts`) — listener global de teclado sem campo focado, já testado (5 testes). Reutilizar em TODAS as telas de execução.
- **`useCameraScanner()`** (`src/lib/field/use-camera-scanner.ts`) — fallback via `BarcodeDetector`. Reutilizar.
- **`classifyCode`/`validateSsccCheckDigit`/`validateExpectedType`/`computeGs1CheckDigit`** (`src/lib/field/scanner.ts`) — validador universal (RN-COL-012), já testado (12 testes). Toda leitura em T2–T6 passa por `validateExpectedType` antes de aceitar.
- **`fieldApi`** (`src/lib/field/field-api.ts`) — cliente HTTP da área `field`; precisa de dois métodos novos: buscar o Pacote de Turno (`GET /campo/pacote-turno`) e enviar a fila de sincronização (`POST /campo/sincronizacao`) — endpoints da COL-2A.
- **`getOrCreateFieldDeviceId()`** (`src/lib/field/device-id.ts`) — device_id já persistido em IndexedDB via `idb`; a fila local desta sessão usa o MESMO banco IndexedDB (não crie um segundo).
- **`app/field/layout.tsx`** já tem: registro de dispositivo, overlay de PIN por inatividade, nav inferior. Precisa ganhar o "estado permanente visível no topo" (RNF-COL-020: operador, armazém, zona/estação, conexão, tamanho da fila) — hoje só mostra o device_id.
- **`app/field/page.tsx` (T1 Minhas Tarefas)** hoje só LISTA — precisa navegar para a tela de execução correta ao tocar num cartão (rota por tipo de tarefa: putaway → T2, picking → T3 etc.).

## 2. ESTADO REAL DO BACKEND (produzido pela COL-2A — não redesenhar, consumir)

- `GET /campo/pacote-turno` devolve tarefas de todos os tipos executáveis offline + dados de produto/endereço/LPN, respeitando `COL.PACOTE_TURNO_MAX`.
- `POST /campo/sincronizacao` recebe um lote de operações (FIFO), devolve por operação uma das 4 decisões da RN-ARQ-053 (`APLICADA`/`DESCARTADA_DUPLICIDADE`/`REJEITADA_TAREFA_INVALIDA`/`REJEITADA_REGRA`) com linguagem simples para exibir ao operador (DOC-15 RN-COL-040).
- Cada execução exige um `operationId` (UUID v7) gerado no dispositivo — é a chave de idempotência; gere um por confirmação, nunca reaproveite.
- Gate de versão mínima devolve um sinal de bloqueio de novas execuções (não de sincronização) — consumir esse sinal, não reimplementar a comparação de versão no cliente.

---

## 3. ENTREGÁVEIS DESTA SESSÃO

### 3.1 IndexedDB — Pacote de Turno e fila local (RF-ARQ-051/052)

- Ao login (ou pull-to-refresh manual), buscar `GET /campo/pacote-turno` e persistir em IndexedDB (tarefas + dados de referência), com marca d'água de versão do pacote.
- Cada confirmação de tarefa (online OU offline) grava um registro local com `operationId` (UUID v7), tipo de tarefa, payload de leituras/medições, timestamp do dispositivo, estado local (`LOCAL_PENDENTE` → `ENVIANDO` → estado final da COL-2A). A interface exibe permanentemente o estado da conexão e o tamanho da fila (RF-ARQ-052, RNF-COL-020).
- **RF-COL-021 (interrupção e retomada) `[obrigatório]`**: o passo atual de uma tarefa em andamento (ex.: já leu endereço, aguardando LPN) é persistido localmente a cada passo — fechar/reabrir o app retoma EXATAMENTE nesse passo, nunca do zero.

### 3.2 Sincronização oportunista (RF-COL-041)

Ao evento `online` do navegador, iniciar automaticamente o envio FIFO por dispositivo das operações `LOCAL_PENDENTE`/que falharam por rede, com progresso visível, sem bloquear a execução de novas tarefas já aprovisionadas. Aplicar as decisões recebidas com a linguagem simples da RN-COL-040 diretamente na T8 (Sincronização, já existente da COL-1 — estender, não recriar).

### 3.3 Bloqueios client-side

- **RNF-ARQ-054**: fila local > 500 operações OU > 8h desde a última sincronização bem-sucedida → bloquear novas execuções com aviso claro e destacar o botão de sincronizar (a fila em si nunca é descartada).
- **RNF-COL-050**: quando o backend sinalizar versão abaixo da mínima, bloquear novas execuções com aviso de atualização, mas permitir a sincronização da fila existente.

### 3.4 Telas de execução (reaproveitando os services já existentes — nenhuma regra nova aqui)

Cada tela segue RNF-COL-020 (uma decisão por tela, alvo ≥48dp, texto ≥16, ações na metade inferior, teclado numérico nativo) e RF-COL-013 (feedback <100ms: som, vibração, flash de borda).

- **T2 Putaway** (`POST` equivalente a `PutawayTaskService.executeTask`): ler LPN → ler endereço → confirmar (dupla leitura, RF-REC-042).
- **T3 Picking** (`PickingTaskService.executeTask`): ler endereço → ler produto/LPN → confirmar quantidade (teclado numérico), corte tratado pela RN-EXP-032 já implementada no servidor.
- **T4 Conferência** (`CheckingService.countFirstRound`/`recount`/`registerAvaria`/`registerTroca`): produto → lote/validade (quando exigido, RN-DAD-020) → embalagem → quantidade.
- **T5 Contagem** (`InventoryCountExecutionService.submitRound`) — **[INVIOLÁVEL] RN-COL-061**: NUNCA exibir saldo do sistema, rodada anterior ou indicação de divergência durante a contagem; fluxo por endereço (RF-COL-062): ler etiqueta do endereço → por item: ler produto/LPN, lote/validade se exigido, quantidade na embalagem lida com conversão exibida ("2 CX12 = 24 UN", RN-DAD-021) → repetir para itens adicionais (lista do já contado NESTA rodada fica visível — não é saldo do sistema) → encerrar com confirmação explícita. **RN-COL-063 [INVIOLÁVEL]**: endereço vazio exige a ação explícita "endereço vazio" — é PROIBIDO tratar ausência de leitura como zero implícito. **RN-COL-064**: avisar antecipadamente quando o operador logado for o mesmo da 1ª rodada daquele endereço. Ao encerrar o endereço, envia o TOTAL agregado para `submitRound` (o item-a-item é só UX local — o servidor já opera por total, não por item).
- **T6 Transferência/Reposição** (`ReplenishmentTaskService.executeTask` para reposição, `StockTransferService.*` para transferência): dupla leitura endereço origem → endereço destino (RF-EST-050/042).

### 3.5 Fora de escopo desta sessão

Qualquer regra de negócio nova (todas já existem nos services do backend — esta sessão só liga UI+offline a elas); Modo Quiosque/MDM completo (DOC-15 §8, fora de escopo permanente); voice picking/wearables (§8); qualquer tela fora do catálogo fechado de 8 do DOC-15 §4.5.

---

## 4. CENÁRIOS GHERKIN (DOC-15 §6/§4.7 — aplicáveis ao cliente)

```gherkin
Cenário: Interrupção preserva o passo
  Dado picking com endereço já lido e produto pendente
  Quando o app for fechado e reaberto
  Então a tarefa deve retomar exatamente no passo "ler produto"

Cenário: Contagem cega não expõe saldo (RN-COL-061)
  Dado inventário em 1ª rodada no endereço A1-010-02-01 com saldo de sistema 100 UN
  Quando o operador abrir a contagem do endereço no coletor
  Então nenhum saldo, contagem anterior ou indicação de divergência deve ser exibido

Cenário: Endereço vazio exige declaração ativa (RN-COL-063)
  Dado a contagem do endereço B2-001-01-01 sem nenhuma leitura registrada
  Quando o operador tentar encerrar o endereço
  Então o encerramento deve ser rejeitado
  E somente a ação explícita "endereço vazio" com confirmação deve concluir com contagem zero

Cenário: Aviso de recontagem pelo mesmo operador (RN-COL-064)
  Dado João executou a 1ª contagem do endereço A1-010-02-01
  Quando João abrir esse endereço na T5 para a 2ª rodada
  Então o coletor deve avisar que a recontagem exige operador diferente

Cenário: Conversão exibida na contagem
  Dado produto com embalagem CX12 (fator 12)
  Quando o operador contar 2 CX12
  Então a tela deve exibir "2 CX12 = 24 UN"

Cenário: Limite de fila bloqueia com clareza (RNF-ARQ-054)
  Dado 500 operações na fila local sem sincronização
  Quando o operador tentar confirmar a 501ª
  Então a execução deve ser bloqueada e a tela deve destacar a ação de sincronizar

Cenário: Sincronização oportunista
  Dado 3 operações LOCAL_PENDENTE e o dispositivo estava offline
  Quando a conexão retornar
  Então a sincronização deve iniciar automaticamente, em FIFO, sem ação do operador
```

---

## 5. TESTES

- **Backend**: nenhum novo (coberto pela COL-2A).
- **Frontend**: unitário/puro para a lógica de retomada de passo (persistência local do estado do passo atual) e para o gate de bloqueio por limite de fila/versão (funções puras, sem DOM); teste de componente para a T5 confirmando que NENHUM saldo/rodada anterior é renderizado em nenhum estado da tela (RN-COL-061, o mais crítico dos `[INVIOLÁVEL]` desta sessão); build limpo (`pnpm --filter @wms/frontend build`) cobre as demais telas por tipagem.
Salve as telas em screenshots.

---

## 6. DEFINITION OF DONE

```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções
curl localhost:3000/health/ready
git commit && git push   # inclui este prompt
```

Relatório em `docs/relatorios/SESSAO-COL2B-relatorio.md`: matriz requisito → arquivo → teste, saída real dos comandos, lacunas/débitos (citar explicitamente Modo Quiosque e telemetria de UI além do mínimo, se ficarem parciais).

---

## 7. PRÓXIMO PASSO

Com COL-2A + COL-2B, o DOC-15 fica fechado por completo (catálogo de 8 telas, offline-first, PIN, resolução de conflitos). Próximo módulo pendente conforme `docs/relatorios/MARCO-estado-do-sistema.md`/`ROTEIRO-DESENVOLVIMENTO.md`.
