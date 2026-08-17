# SESSÃO 4A: DOC-04 — RECEBIMENTO E DOCAS (SEM O MOTOR DE PUTAWAY)
> Modelo recomendado: MÉDIO (Sonnet). O motor de putaway fica para a 4B (PREMIUM).
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-04-recebimento-docas.md`, `docs/relatorios/SESSAO-4-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar o DOC-04 exceto o motor de putaway: docas, Ordem de Recebimento
(ASN/XML/manual), conferência cega com recontagem, as 5 divergências com seus
workflows, etiquetagem/LPN, quarentena por espécie e cross-docking.

## REGRAS
- Cite o §/ID do DOC-04 ao definir CADA tabela, coluna, enum, permissão,
  exceção e evento. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]` para dificuldade técnica; débito que
  bloqueia o Definition of Done não pode ser adiado.
- É PROIBIDO: `USING(true)`; optional chaining para esconder DI; `.skip`;
  mock de Postgres/Redis em integração; enfraquecer regra [INVIOLÁVEL] para
  fazer teste passar; declarar ✅ sem saída de comando real.
- **É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.**
- **Herde os padrões já estabelecidos**: `actor_user_id` sempre do JWT;
  `@Audited()`/`AuditService.record()` com `before`+`after` em toda escrita;
  toda rota declara permissão (RN-SEG-012); máquina de estados explícita, sem
  `setStatus()` livre; eventos publicados via outbox transacional.
- Não refatore código que já passa nos testes (exceto item 0).

## ENTREGÁVEIS

### 0. Isolar a infraestrutura de teste [PRIMEIRO — débito da Sessão 4]
A contenção entre containers Docker e a suíte de testes pelo mesmo
Postgres/Redis já produziu falha fantasma. Separe: banco e Redis dedicados
aos testes (instância ou porta própria, `.env.test`), com limpeza determinística
entre suítes. Critério: `pnpm test:integration` roda com o Docker Compose de
desenvolvimento ATIVO, sem interferência, duas execuções seguidas verdes.

### 1. Catálogos centrais (antes do código)
- 6 permissões `REC.*` (§3) com escopos exatos, atribuídas aos papéis semente
  (`CONFERENTE`, `LIDER_TURNO`, `OPERADOR_EMPILHADEIRA`, qualidade).
- 6 tipos de exceção `REC.*` (§3) em `exception_type` com passos, motivo e
  expiração conforme a tabela.
- 11 eventos `recebimento.*` (§4.7) no catálogo tipado + mapeamento
  evento→tópico para o fanout.

### 2. Migrations (§7 — RD-REC-001..006)
`inbound_order` + `inbound_order_item`, `inbound_invoice`, `checking` +
`checking_item`, `discrepancy`, `putaway_task` (estrutura; a geração é 4B),
`crossdock_link`. RLS nas de tenant (padrão ADR-RLS-003/004); enums como CHECK
com os valores exatos da §5.1; `putaway_task` particionada conforme
RNF-ARQ-090 (o job de partições já existe).

### 3. Docas (§4.1)
RN-REC-001 (máquina de estados `FREE→RESERVED→OCCUPIED→FREE`; atracar em doca
não reservada é PROIBIDO), RF-REC-002 (atracação, validação de compatibilidade
doca × sentido × tipo de veículo, conferência de lacres de entrada integrando
com `POR.DIVERGENCIA_LACRE` do DOC-03), RF-REC-003 (sugestão de doca por
sentido → tipo de veículo → menor distância média até as zonas preferenciais,
parâmetro `REC.MAPA_DISTANCIA_DOCA_ZONA`; empate = menor código).

### 4. Ordem de Recebimento e ASN (§4.2)
RF-REC-010 (três origens: XML de NF-e com extração de itens/lotes/emitente/
chave; integração ERP fica `[LACUNA: DOC-13]`; digitação manual — as duas
disponíveis DEVEM funcionar), numeração `REC` pelo serviço da 2B,
RN-REC-011 (registrar `inbound_invoice` e iniciar o prazo da RG-014; o
controle do prazo em si é `[LACUNA: DOC-08]` — apenas registre a data-limite),
RN-REC-012 (item sem cadastro → `REC.PRODUTO_SEM_CADASTRO`, bloqueia SÓ o
item; demais seguem).

### 5. Fluxo Operacional do recebimento (§4.3) [RG-002]
RF-REC-020: instanciar `operation_flow`/`flow_step` com
`Chegada → Doca → Descarga → Conferência → [Divergências] → Etiquetagem →
Putaway → Fim`, etapa `Divergências` intercalada dinamicamente quando houver.
Navegação e bloqueios conforme RG-002 (inclusive via API:
`FLOW_STEP_ORDER_VIOLATION`).

### 6. Conferência e divergências (§4.3)
RF-REC-021 (modo cego por `client_warehouse_settings.blind_checking`; troca
pontual exige permissão + motivo),
**RN-REC-022 [INVIOLÁVEL]** (recontagem por conferente DIFERENTE quando houver
outro disponível; quantidade final = recontagem; tipificação FALTA/SOBRA/
TROCA/AVARIA; AVARIA exige ≥1 foto no S3),
**RN-REC-023 [INVIOLÁVEL]** (efeitos por decisão conforme a tabela: FALTA
ajusta e gera carta de divergência em PDF; SOBRA recebe como `qty_blocked` OU
recusa no ato, à escolha do aprovador; AVARIA em `qty_damaged` na zona
`DAMAGED` OU recusa; TROCA como par falta+sobra vinculado; rejeição volta para
recontagem), `REC.RECUSA_TOTAL` com 2 aprovadores,
RF-REC-024 (encerramento congela quantidades e habilita a Etiquetagem).

### 7. Etiquetagem e quarentena (§4.4)
RF-REC-030 (formação de paletes, LPN pelo serviço da 2B, job de impressão
enfileirado — driver ZPL é `[LACUNA: DOC-11]`; sugestão de paletização por
`ballast × layers`; palete misto por parâmetro),
RN-REC-031 (quarentena por espécie: lote nasce `QUARANTINE`; liberação por
`REC.LIBERAR_QUARENTENA` com motivo gera tarefas de transferência).

### 8. Cross-docking (§4.6)
RN-REC-050 (elegibilidade por vínculo a pedido aberto antes da conferência,
parcial permitido), RF-REC-051 (conferência normal obrigatória; saldo nasce em
zona `CROSS_DOCKING` já reservado ao pedido; cancelamento do pedido desfaz a
reserva e devolve ao putaway padrão — a geração da tarefa fica `[DEBITO: 4B]`),
RNF-REC-052 (alerta de permanência acima de `REC.CROSSDOCK_TEMPO_MAX_H`).

### 9. Testes de integração (cenários do DOC-04 §6, exceto os 2 de putaway)
Conferência cega com falta; falta aprovada ajusta a ordem; sobra recebida como
bloqueada; avaria exige foto; medicamento em quarentena; cross-docking pula o
picking; cancelamento do pedido desfaz o cross-docking.
+ Regressão: todas as suítes anteriores verdes.

## DEFINITION OF DONE
```bash
docker compose up -d --build
pnpm build && pnpm test && pnpm test:integration   # 2 execuções seguidas verdes
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-4A-relatorio.md` com
matriz requisito → arquivo → teste, lacunas e débitos.

## FORA DE ESCOPO
**Motor de putaway RN-REC-040/041/042 (Fase 1 filtros + Fase 2 ranqueamento) —
é a Sessão 4B.** Também fora: regras de saldo e políticas de giro (DOC-05),
prazo fiscal e NF-e (DOC-08), drivers de impressora (DOC-11), integração ERP
(DOC-13), e tudo do DOC-04 §8 (RFID, LIMS, task interleaving, cubagem).
