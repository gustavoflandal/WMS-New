# SESSÃO 4: DOC-03 — PORTARIA E PÁTIO
> Modelo recomendado: MÉDIO (Sonnet). Primeiro módulo operacional.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-03-portaria-patio.md`, `docs/relatorios/SESSAO-3-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar o DOC-03 completo: agendamento, gate-in/gate-out de veículos e
pessoas, pátio com fila priorizada, chamada para doca. Primeiro módulo de
negócio — o padrão que ele estabelecer será copiado pelos demais.

## REGRAS
- Cite o §/ID do DOC-03 ao definir CADA tabela, coluna, enum, permissão,
  exceção e evento. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]` para dificuldade técnica; débito que
  bloqueia o Definition of Done não pode ser adiado.
- É PROIBIDO: `USING(true)` em policy; optional chaining para esconder DI;
  `.skip`; mock de Postgres/Redis em teste de integração; enfraquecer regra
  [INVIOLÁVEL] para fazer teste passar; declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- **Herde os padrões da Sessão 3**: `actor_user_id` SEMPRE do JWT (nunca do
  body/query — o middleware global cobre, mas não crie DTO que o aceite);
  `@Audited()`/`AuditService.record()` com `before`+`after` em TODA escrita;
  toda rota declara permissão (RN-SEG-012, o boot falha sem isso).
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Registro nos catálogos centrais (fazer PRIMEIRO)
- 8 permissões `POR.*` (§3) em `permission`, com os escopos exatos, e
  atribuição aos papéis semente pertinentes (`PORTEIRO`, `LIDER_TURNO`,
  `GESTOR_ARMAZEM`, `CLIENTE_OPERACAO`).
- 4 tipos de exceção `POR.*` (§3) em `exception_type` com `default_steps`,
  `requires_reason` e `auto_expire_hours` conforme a tabela.
- 11 tipos de evento `portaria.*` (§4.6) no catálogo tipado de
  `packages/contracts`, com mapeamento evento→tópico (`patio`, `docas`,
  `alertas`) para o fanout.

### 2. Migrations (§7 — RD-POR-001..007)
`appointment`, `driver` (GLOBAL, CPF UNIQUE), `vehicle` (GLOBAL, placa UNIQUE),
`visitor` + `person_visit` (GLOBAL), `vehicle_visit` (TENANT, RLS),
`yard_queue_entry` (TENANT, RLS), `appointment_window_config` (GLOBAL).
RLS nas de tenant no padrão ADR-RLS-003/004. Enums como CHECK com os valores
exatos das máquinas de estado §5.1/§5.2. Parâmetros do §7 em `app_parameter`.

### 3. Agendamento (§4.1)
RF-POR-001 (criação com máscara `AGD`, usando o serviço de numeração da 2B),
RN-POR-002 (capacidade da janela, sem overbooking, sugerindo as 5 próximas
janelas com vaga), RF-POR-003 (remarcação/cancelamento com motivo),
RN-POR-004 (no-show pelo scheduler, liberando capacidade e notificando).

### 4. Gate-in (§4.2)
RF-POR-010 (identificação por placa: padrões Mercosul `AAA9A99` e antigo
`AAA9999`; LPR fica `[LACUNA: DOC-11]` — a entrada manual deve funcionar),
RF-POR-011 (registro completo: motorista com CPF validado por dígito, CNH,
transportadora, chaves NF-e de 44 dígitos validadas, lacres, KM),
RN-POR-012 (validação contra agendamento: dentro da janela; fora → exceção
`POR.FORA_DA_JANELA`; sem agendamento → `POR.VEICULO_SEM_AGENDAMENTO` com
veículo em `AGUARDANDO_AUTORIZACAO`, sem ocupar vaga, e agendamento retroativo
`SEM_AGENDA` após aprovação),
**RN-POR-013 [INVIOLÁVEL]** (HAZMAT: espécies INFLAMAVEL/COMBUSTIVEL/
QUIMICO_CONTROLADO exigem checklist e vaga `HAZMAT`; sem vaga o veículo NÃO
entra),
RF-POR-014 (cancela via Edge Agent — o job é criado e enfileirado conforme
RNF-ARQ-061; driver real é `[LACUNA: DOC-11]`; fallback manual auditado como
`OVERRIDE`).

### 5. Pátio e fila (§4.3)
RF-POR-020 (alocação de vaga compatível, painel em tempo real no tópico
`patio`),
**RN-POR-021** (pontuação determinística: `P1*no_horario + P2*perecivel +
P3*hazmat + P4*prioridade_manual`, pesos parametrizáveis, desempate por
gate-in mais antigo; a pontuação e seus componentes são PERSISTIDOS para
auditoria; recalcular a cada mudança de estado),
RF-POR-022 (chamada para doca: sugestão automática do primeiro da fila,
confirmação HUMANA obrigatória — não existe chamada automática; doca vai a
`RESERVED`).

### 6. Pessoas (§4.4) e gate-out (§4.5)
RF-POR-030/031 (visitante com áreas autorizadas e validade; painel de
presentes com tempo de permanência e alerta de validade excedida),
**RN-POR-040 [INVIOLÁVEL]** (gate-out valida: etapas do fluxo pendentes,
lacres quando exigidos, exceções pendentes; bloqueio lista as pendências
exatas; forçar exige `POR.SAIDA_COM_PENDENCIA` com 2 aprovadores distintos —
use o motor de exceções do DOC-12),
RF-POR-041 (conferência de lacres; divergência abre `POR.DIVERGENCIA_LACRE` e
bloqueia), RNF-POR-042 (timestamps de todos os marcos para os KPIs do DOC-10).

### 7. Máquina de estados (§5.1)
`vehicle_visit` implementada como máquina de estados explícita, com a tabela
de transições do documento (origem, evento, guarda, destino, efeitos).
Transição não prevista no diagrama DEVE ser rejeitada com erro determinístico
— não implemente `setStatus()` livre.

### 8. Testes de integração (todos os 8 cenários do DOC-03 §6, contra containers reais)
Gate-in na janela; fora da janela com tolerância excedida; veículo sem
agendamento recusado; HAZMAT sem vaga; **ordem determinística da fila
(exemplo normativo: C=12, A=7, B=2 — valor de regressão permanente, não
altere)**; bloqueio de gate-out com pendência; divergência de lacre; no-show
liberando capacidade.
+ Regressão: as suítes das sessões anteriores continuam verdes.

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # TODAS as suítes, zero skip
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-4-relatorio.md` com matriz
requisito → arquivo → teste, lacunas e débitos.

## FORA DE ESCOPO (DOC-03 §8)
Balança rodoviária, gestão de frota, integração com agendamento de terceiros,
biometria/reconhecimento facial, cobrança de estadia, EPI/segurança do
trabalho. Também fora: drivers reais de cancela/LPR (DOC-11), operação dentro
da doca (DOC-04), qualquer regra de estoque.
