# SESSÃO 3: DOC-12 — SEGURANÇA, PERMISSÕES E AUDITORIA
> Modelo recomendado: MÉDIO (Sonnet). Segurança: erro aqui é caro.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-12-seguranca-permissoes-auditoria.md`, `docs/relatorios/SESSAO-2B-relatorio.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Implementar o DOC-12 completo: autenticação real (JWT + refresh), RBAC
multi-dimensional (papel × cliente × armazém), alçadas, trilha de auditoria
imutável e o motor genérico de Workflow de Aprovação. Fecha a Fase 1.

## REGRAS
- Cite o §/ID do DOC-12 ao definir CADA tabela, coluna, enum e código de
  permissão. Não invente: use `[LACUNA: ...]`.
- `[DEBITO: descrição + sessão-alvo]` para dificuldade técnica; débito que
  bloqueia o Definition of Done não pode ser adiado.
- É PROIBIDO: `USING(true)` em policy; optional chaining para esconder DI;
  `.skip`; mock de Postgres/Redis em teste de integração; enfraquecer regra
  `[INVIOLÁVEL]` para fazer teste passar; declarar ✅ sem saída de comando real.
- É PROIBIDO remover, mover ou renomear arquivos fora do escopo desta
  sessão. Qualquer exclusão exige confirmação explícita do usuário.
- Não refatore código que já passa nos testes, exceto onde o item exigir.

## ENTREGÁVEIS

### 1. Autenticação real (§4.1) — substitui o provider de desenvolvimento
Senhas com Argon2id (RF-SEG-002); política de senha por `app_parameter`
(`SEG.PASSWORD_*`): 10 chars, 3 classes, bloqueio 15 min após 5 falhas,
histórico das últimas 5, troca no primeiro acesso.
JWT access 15 min com `user_id`, `assignments_hash`, `area`
(`INTERNAL`|`CLIENT_PORTAL`); refresh rotativo (8h interno / 24h portal)
vinculado ao dispositivo e revogável (RF-SEG-003).
Mudança de atribuição invalida tokens ativos via `assignments_hash`.
RF-SEG-006: endpoints separados por área; token de portal NÃO acessa rota
interna e vice-versa.
RF-SEG-004 (PIN de coletor) e RF-SEG-005 (MFA TOTP obrigatório para papéis
com permissão GLOBAL): implemente se couber no escopo; caso contrário,
`[DEBITO: ... + sessão do PWA/DOC-11]` com justificativa.

### 2. RBAC multi-dimensional (§4.2) [INVIOLÁVEL]
Tabelas `permission`, `role`, `role_permission`, `user_role_assignment`
(RD-SEG-010), com os escopos `GLOBAL|WAREHOUSE|CLIENT_WAREHOUSE`.
RN-SEG-011: resolução exata conforme a condição lógica do documento. Sem
curinga: acesso a N clientes = N atribuições.
RN-SEG-012 [a mais importante]: deny por omissão COM FALHA NO BOOT — toda
rota REST e todo handler WebSocket declara a permissão exigida; rota sem
declaração impede a aplicação de subir, com mensagem apontando a rota.
`app.tenant_ids` da RLS passa a ser derivado EXCLUSIVAMENTE das atribuições
vigentes (RNF-ARQ-010 + RN-ARQ-013): substitua o provider de dev.
Catálogo inicial de permissões transversais (RD-SEG-014) + as já declaradas
pelos módulos implementados (`DAD.*`). Papéis semente (RF-SEG-013).
Substitua os `[LACUNA: RBAC DOC-12]` deixados nas sessões 2A/2B.

### 3. Alçadas (§4.3)
`approval_authority` (RD-SEG-020) e RN-SEG-021: validação de alçada por
`exception_type` × armazém, com escalonamento automático a
`GESTOR_ARMAZEM` quando a exceção excede todas as alçadas configuradas.

### 4. Trilha de auditoria (§4.4) [INVIOLÁVEL]
`audit_log` particionada mensal (RD-SEG-030) com TODOS os campos do
documento, incluindo `requirement_id`, before/after e `correlation_id`.
RN-SEG-031: imutável — `wms_app` possui APENAS INSERT e SELECT nesta
tabela; UPDATE/DELETE revogados no banco. Teste provando a negação.
RN-SEG-032: cobertura obrigatória (escritas de negócio, mudanças de estado,
overrides, aprovações, login/logout e falhas, exportação, impressão).
Implemente como interceptor/decorator reutilizável para os módulos futuros.
RF-SEG-033: consulta com filtros do documento + exportação CSV (a
exportação é ela própria auditada).
Registre a partição de `audit_log` no job de particionamento já existente
(criado na 2B).

### 5. Motor de Workflow de Aprovação (§4.5)
`exception_type` (catálogo GLOBAL) e `operational_exception` (RD-SEG-041),
com a máquina de estados do §5.1 (PENDING/ESCALATED/APPROVED/REJECTED/EXPIRED).
RN-SEG-042 (efeito suspensivo): enquanto PENDING/ESCALATED, a operação de
origem fica bloqueada; aprovação libera com desvio autorizado; rejeição
devolve ao estado anterior; expiração = rejeição automática.
RN-SEG-043: solicitante não aprova a própria exceção; fluxo de 2 passos
exige aprovadores distintos entre si e do solicitante.
RF-SEG-044: notificação em tempo real no tópico `alertas` (use o fanout já
implementado).
Expiração automática pelo scheduler (`auto_expire_hours`).

### 6. LGPD (§4.6)
RD-SEG-050 (inventário), RN-SEG-051 (mascaramento de CPF/CNH por padrão;
exibição completa exige permissão e gera auditoria; retenção configurável
com anonimização pelo scheduler), RF-SEG-052 (relatório/retificação/
anonimização por titular). Se algum item não couber,
`[DEBITO: ... + sessão-alvo]`.

### 7. Testes de integração (cenários do DOC-12 §6 — todos, contra containers reais)
Resolução multi-dimensional (3 casos do documento); deny por omissão
derrubando o boot; solicitante não aprova a própria exceção; escalonamento
por alçada insuficiente; efeito suspensivo; imutabilidade da auditoria
(UPDATE/DELETE negados pelo banco); mascaramento de CPF com auditoria da
exibição completa; invalidação de token após mudança de atribuição.
Teste de regressão: as suítes das sessões 1.5/2A/2B continuam verdes com o
RBAC real substituindo o provider de dev.

## DEFINITION OF DONE
```bash
docker compose up -d
pnpm build && pnpm test && pnpm test:integration   # TODAS as suítes, zero skip
curl localhost:3000/health/ready
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-3-relatorio.md` com
matriz requisito → arquivo → teste, lacunas, débitos, e a lista dos
`[LACUNA: RBAC DOC-12]` que foram substituídos.

## FORA DE ESCOPO
SSO/OIDC, SCIM, permissões por registro individual, workflow configurável
pelo usuário final, assinatura digital, biometria, detecção de fraude
(DOC-12 §8). Qualquer regra de negócio operacional (DOC-03 em diante).
