# PROMPT — SESSÃO 8B: FISCAL — MOTOR DE EMISSÃO NF-e

## Pré-condição

**Não abrir esta sessão antes da 8A estar commitada.** Prazo de
regularização (RN-FIS-010), ordem de consumo (RN-FIS-030) e CFOP/naturezas
(RN-FIS-050) deixaram de ser uma homologação única a esperar — são parâmetro
de cadastro por cliente×armazém (decisão de 2026-08-23, registrada no topo
de `docs/PROMPT-SESSAO-8A-fiscal-estoque.md`), com os valores do DOC-08 como
seed/padrão de instalação. Confirme no relatório da 8A que isso está
implementado como reconfigurável de verdade. `FIS.AMBIENTE` (por emitente)
continua existindo e **DEVE** default para `HOMOLOGACAO` — mas isso agora é
sobre CADA emitente/cliente entrar em produção só depois de cadastrado
corretamente (parâmetros fiscais dele revisados + certificado A1 real dele),
não sobre esperar uma validação nacional única.

## Especificação de Execução

| Metadado | Valor |
|---|---|
| Sessão | 8B (parte 2 de 2 — motor de emissão; consome o ciclo de estoque fiscal da 8A) |
| Módulo | DOC-08 (Fiscal) §4.7, §4.9, §5.1; DOC-01 §4.7 (padrão já usado pelo Edge Agent para integração externa sem serviço real disponível) |
| Dependência de | Sessão 8A ✓ (`fiscal_document`, `FiscalConsumptionService`, `StorageReturnInvoiceService`), DOC-01 (outbox transacional, RNF-ARQ-003 perfis api/worker/scheduler), DOC-11 ✓ (Edge Agent — modelo de referência para o simulador desta sessão), DOC-12 (certificados cifrados, RNF-ARQ-100) |
| Modelo | Sonnet Premium (protocolo externo denso, máquina de estados crítica, criptografia de certificado) |
| Data de Abertura | — (abrir após 8A commitada e a confirmação de homologação) |
| Stack | NestJS + PostgreSQL 16 + Redis (fila do worker fiscal), dentro de `apps/backend/src/modules/fiscal/`. **Nenhum SDK/biblioteca de terceiros para SEFAZ sem antes verificar se já há alguma na stack congelada (DOC-00 §2.2) — se não houver, implemente o protocolo (SOAP/REST conforme o webservice da UF) diretamente ou registre a necessidade de uma lib como `[DEBITO]`, nunca adicione dependência nova sem checar DOC-00 §2.2 primeiro.** |
| Alvo | Worker de emissão (RNF-FIS-060), contingência SVC (RNF-FIS-061), cancelamento/CCe (RNF-FIS-062), certificados e guarda de XML (RNF-FIS-063), DANFE (RF-FIS-064) |
| Posição no Plano | Fecha a Posição 2 do roteiro (Fiscal). Antes de **DOC-07** (Logística Reversa), que depende de RN-FIS-041 (recomposição — método já existe da 8A, o gatilho é do DOC-07). |

---

## 1. ESTADO REAL DO BACKEND (levantar no início desta sessão — a 8A ainda não rodou no momento em que este prompt foi escrito)

**Antes de codar, releia `docs/relatorios/SESSAO-8A-relatorio.md` e os arquivos reais que ela criou** — a lista abaixo é a EXPECTATIVA baseada no prompt da 8A, não uma leitura direta do código (que ainda não existe nesta data). Trate como hipótese a confirmar, não como fato:

- `wms.fiscal_document`/`fiscal_document_item` devem existir com estado `DRAFT` (e um estado "registrado" para documentos que entram prontos) — esta sessão adiciona as transições `SIGNED`/`TRANSMITTED`/`AUTHORIZED`/`REJECTED`/`DENIED`/`CANCELLED` reais (DOC-08 §5.1 completo).
- `StorageReturnInvoiceService` (8A) deve ter um método de "autorização" chamável manualmente/testável — **esta sessão substitui esse disparo pelo retorno real da SEFAZ** (ou do simulador desta sessão), sem quebrar a lógica de consumo já testada na 8A (reaproveite o método, não duplique a lógica de RN-FIS-040).
- `DispatchService.confirmFiscalDocuments()` (DOC-06) já deve estar chamando o serviço da 8A para `EMISSAO_PROPRIA`/`HIBRIDO` — confirme que continua funcionando quando a "autorização" passa a vir do motor real.
- Catálogo de permissões `FIS.CANCELAR`/`FIS.INUTILIZAR`/`FIS.CERTIFICADO` já deve existir (criado na 8A, sem uso ainda) — esta sessão é quem primeiro exercita essas rotas.
- Exceção `FIS.CANCELAMENTO_NFE` (2 passos, 4h) — **não estava no catálogo da 8A** (documentado lá como "fica para a 8B, só faz sentido com nota AUTHORIZED de verdade") — criar nesta sessão.

## 2. DECISÃO DE ARQUITETURA A TOMAR NO INÍCIO: SIMULADOR DE SEFAZ

Este ambiente de desenvolvimento **não tem acesso real ao webservice da SEFAZ** (nem em homologação — exigiria certificado A1 real de uma empresa real). O projeto já tem precedente EXATO para isso: **DOC-11/Sessão 8 (periféricos) construiu um simulador de referência para o Edge Agent** (protocolo real implementado, mas testável sem hardware físico — ver `apps/backend/src/modules/perifericos/` e a sessão que o criou, `docs/relatorios/SESSAO-8-relatorio.md`, "8" sendo o número antigo de sessão, não confundir com esta "8B" do fiscal). **Siga o mesmo padrão**:

1. Implemente o cliente SEFAZ real (montagem do envelope, assinatura XML-DSig, endpoint por UF/ambiente) por trás de uma INTERFACE (`SefazClientPort` ou nome equivalente).
2. Implemente um **adaptador simulador** (`SefazSimulatorAdapter`) que responde determinística e configuravelmente (cStat 100 para o caminho feliz, códigos de rejeição/denegação parametrizáveis por teste, latência simulável para testar timeout/contingência) — é o que os testes de integração REAIS usam (nunca mock de framework: um adaptador real, só que apontando para um simulador em vez da rede, mesmo espírito de "container real" que os testes de integração já exigem para Postgres/Redis).
3. O adaptador de produção (`SefazSoapClientAdapter` ou equivalente) fica implementado e testável isoladamente (unitário, sem rede), mas **não é o que os testes de integração exercitam** — documente isso explicitamente, não é lacuna, é a mesma decisão já tomada para o Edge Agent.
4. `FIS.AMBIENTE` (por emitente, RD-FIS-004) decide qual adaptador o worker usa em cada ambiente real (`homologacao`/`producao`) — em `docker-compose.yml`/testes, sempre o simulador.

---

## 3. ENTREGÁVEIS DESTA SESSÃO

### 3.1 Migration

1. `wms.fiscal_issuer` (RD-FIS-004) — CNPJ, série (`FIS.SERIE`), ambiente, certificado cifrado (AES-256-GCM — reaproveite o padrão de segredo já usado no projeto para outros dados sensíveis, DOC-12 RNF-ARQ-100; se não houver um "cofre de segredo" genérico no código ainda, esta sessão cria o primeiro — documente a decisão).
2. Coluna de número de série real (`nNF` sequencial sem lacunas) em `fiscal_document`, com o mecanismo de reserva atômica do próximo número (lock/sequence dedicada por emitente×série — RNF-FIS-060 é explícito: "sequencial sem lacunas", número pulado por falha é inutilizado, nunca reaproveitado).
3. Tabela ou coluna para eventos de nota (cancelamento, CCe, inutilização) — RNF-FIS-062, com o XML do evento.
4. Grants por consumidor real.

### 3.2 `FiscalEmissionWorkerImpl` (RNF-FIS-060, perfil `scheduler` ou `worker` — decida seguindo o critério já usado no projeto: fila com processamento assíncrono e retry = `worker`; verificação periódica de estado = `scheduler`; RNF-FIS-060 descreve uma FILA, o padrão mais próximo já existente é `OutboundPublisherWorkerImpl`, não os workers de alerta)

Ciclo: monta o XML (leiaute 4.00) a partir de `fiscal_document`/`fiscal_document_item` já validados pela 8A → assina (certificado do emitente, decifrado só em memória, nunca logado) → transmite (via `SefazClientPort`) → trata o retorno (`AUTHORIZED`/`REJECTED`/`DENIED`) → em `AUTHORIZED`, chama o método de consumo real da 8A (efetiva `qty_consumed`) e gera evento `fiscal.nota_autorizada` + DANFE.

### 3.3 Contingência (RNF-FIS-061)

Detecção de indisponibilidade (3 tentativas com backoff), alternância automática para SVC (`tpEmis` correspondente à UF), monitor de disponibilidade a cada 5 min para retomar o modo normal.

### 3.4 Cancelamento e CCe (RNF-FIS-062)

`FIS.PRAZO_CANCELAMENTO_H` (24h), bloqueio se `outbound_order` já `GATE_OUT` (reaproveitar o estado do fluxo operacional do DOC-06/DOC-03, não duplicar verificação), exceção `FIS.CANCELAMENTO_NFE`, estorno do Consumo Fiscal ao cancelar (reaproveitando `reverseConsumption()` da 8A). CCe até 20 eventos por nota, sem alterar valores/quantidades/impostos (validação explícita do que É permitido corrigir).

### 3.5 Certificados e guarda de XML (RNF-FIS-063)

Upload/cadastro de certificado A1 cifrado, alerta de expiração 30/15/7 dias (worker `scheduler`, mesmo padrão de todo alerta já existente no projeto). Guarda de TODOS os XML (emitidos, recebidos, eventos) no MinIO com object-lock ≥ 5 anos — reaproveite `FileStorageService` (já existe, usado em `InboundOrderService`/outros) e confirme se ele já suporta object-lock do MinIO ou se esta sessão precisa estender.

### 3.6 DANFE (RF-FIS-064)

Geração de PDF a partir da nota autorizada, disponível para impressão via Edge Agent (DOC-11 — reaproveite o protocolo de impressão já existente, não invente um canal novo) e download.

### 3.7 Fora de escopo desta sessão

CT-e, MDF-e, NFS-e, escrituração fiscal (SPED), cálculo tributário avançado (ST/DIFAL), manifestação do destinatário — todos explicitamente fora de escopo permanente do DOC-08 §8, não desta sessão especificamente.

---

## 4. CENÁRIOS GHERKIN (DOC-08 §6 — os que dependem do motor real/simulado)

```gherkin
Cenário: Consumo só efetiva na autorização
  Dado Nota de Devolução transmitida e REJEITADA pela SEFAZ (cStat 539)
  Quando o retorno for processado
  Então qty_consumed das notas de armazenagem não deve ser alterado
  E a etapa Expedição deve permanecer vermelha exibindo o código 539

Cenário: Contingência automática
  Dado 3 falhas consecutivas de comunicação com a SEFAZ (simulador configurado para falhar)
  Quando a próxima emissão for processada
  Então ela deve ser transmitida via SVC com tpEmis de contingência
  E ao normalizar o monitor o modo normal deve ser retomado

Cenário: Recomposição fiscal na reversa (RN-FIS-041, chamada direta — DOC-07 ainda não existe)
  Dado pedido expedido com consumo de 100 UN da nota 3216544 (saldo restante 300)
  E devolução de 40 UN com destinação REINTEGRAR e FIS.RECOMPOSICAO_MODO = ESTORNO
  Quando reverseConsumption() for chamado diretamente (simulando o gatilho que o DOC-07 fará)
  Então qty_consumed da nota 3216544 deve reduzir em 40
  E o saldo fiscal disponível da nota deve ser 340
```

---

## 5. TESTES

Integração real (Postgres + Redis + o simulador SEFAZ desta sessão, que É "real" no sentido do CLAUDE.md — roda como um serviço de verdade, não um mock de framework), 2 execuções consecutivas: ciclo completo DRAFT→AUTHORIZED com DANFE gerado, rejeição não consome, contingência SVC ativando e desativando, cancelamento dentro/fora do prazo, CCe, inutilização de número pulado. Teste de contrato de permissões atualizado.

---

## 6. DEFINITION OF DONE

```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções
curl localhost:3000/health/ready
git commit && git push   # inclui este prompt
```

Relatório em `docs/relatorios/SESSAO-8B-relatorio.md`: matriz requisito → arquivo → teste, saída real dos comandos, decisão do simulador SEFAZ documentada, lacunas/débitos.

---

## 7. PRÓXIMO PASSO

Com 8A + 8B, o DOC-08 fecha por completo — `DispatchService.confirmFiscalDocuments()` conclui de verdade para `EMISSAO_PROPRIA`/`HIBRIDO`, não só `INTEGRADO_ERP`. Próximo do roteiro: **DOC-07 (Logística Reversa)**, posição 3 — depende de RN-FIS-041 (o gatilho real que esta sessão deixou testável mas desconectado) e reutiliza portaria/doca/conferência/putaway já prontos. Considere também, antes de seguir, a "janela de piloto real" já registrada em `ROTEIRO-DESENVOLVIMENTO.md` §4 — é uma recomendação, não bloqueio.
