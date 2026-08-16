# SESSÃO 2A: DOC-02 PARTE 1 — ORGANIZAÇÃO E ESTRUTURA FÍSICA
> Modelo recomendado: ECONÔMICO (Haiku). DDL a partir de dicionário de dados pronto.
> Contexto a carregar: `docs/DOC-00-documento-mestre.md`,
> `docs/DOC-02-modelo-dados-cadastros.md`, `docs/relatorios/DOC-01-cobertura.md`.
> NÃO carregue outros documentos.

---

## MISSÃO
Criar as migrations e os módulos de cadastro das entidades de ORGANIZAÇÃO e
ESTRUTURA FÍSICA do DOC-02 (§5.1 e §5.2), com RLS aplicado conforme a
classificação RN-DAD-004. Sem produtos, sem saldos, sem numeração — isso é 2B.

## REGRAS
- Cite o §/ID do DOC-02 ao definir CADA tabela, coluna e enum. Se o documento
  não define algo, use `[LACUNA: ...]` — NÃO invente coluna, tipo ou valor.
- `[DEBITO: descrição + sessão-alvo]` para dificuldade técnica adiada; débito
  que bloqueia o Definition of Done não pode ser adiado.
- É PROIBIDO: `USING(true)` em policy; optional chaining para esconder DI
  não injetada; `.skip` em teste; mock de Postgres/Redis em teste de
  integração; declarar ✅ sem saída de comando real.
- Pool de aplicação conecta como `wms_app` (ADR-RLS-002). Migrations rodam com
  a role de bootstrap.
- Não refatore código que já passa nos testes.

## ENTREGÁVEIS

### 1. Migrations — tabelas GLOBAIS (sem tenant_id, sem RLS) — DOC-02 §5.2
`warehouse`, `zone`, `storage_equipment`, `location`, `dock`, `yard_slot`.
Obrigatório: colunas da RN-DAD-002 em todas; tipos da RN-DAD-005; FKs
`ON DELETE RESTRICT` (RN-DAD-006); enums como TEXT + CHECK com os valores
EXATOS do documento (zone_type, equipment_type, access_policy, location_type,
dock_type, slot_type, status de cada entidade).
Constraints específicas: `UNIQUE(warehouse_id, code)` e
`UNIQUE(warehouse_id, aisle, module, level, slot)` em `location`;
coluna gerada ou trigger garantindo `code` = RN-DAD-011
(`aisle-module-level-slot`).

### 2. Migrations — tabelas DE TENANT (com RLS) — DOC-02 §5.1
`client` (tenant_id = id), `client_warehouse_settings`, `logical_warehouse`,
`logical_warehouse_location`.
RLS obrigatório: ENABLE + FORCE + policy no padrão dos ADR-RLS-003/004
(NULLIF(current_setting('app.tenant_ids', true), ''), deny por omissão,
sem USING(true)).
`logical_warehouse_location`: `UNIQUE(location_id)` GLOBAL — um endereço
pertence a no máximo 1 armazém lógico (RG-015).

### 3. Módulos NestJS de cadastro
Serviços e repositórios com CRUD para as entidades acima, aplicando:
- RF-DAD-050 (códigos imutáveis após criação);
- RF-DAD-051 (desativação exige saldo zero e sem documentos abertos — nesta
  sessão, validar apenas o que já existe: vínculos entre as próprias tabelas);
- RF-DAD-054 (geração em massa de endereços por intervalo de coordenadas).
Endpoints REST podem ser criados, mas SEM autenticação real (DOC-12 é depois);
marque `[LACUNA: RBAC DOC-12]` nos guards.

### 4. Seeds mínimos
1 armazém de exemplo (code `SP01`, timezone America/Sao_Paulo), zonas dos
tipos principais, 1 estrutura de cada `equipment_type`, endereços gerados por
RF-DAD-054, 2 docas, 4 vagas de pátio (1 HAZMAT). Seeds separados das
migrations, idempotentes.

### 5. Testes de integração (contra containers reais)
- Isolamento: cliente A não enxerga `logical_warehouse` do cliente B.
- Exclusividade RG-015: um `location_id` não pode ser vinculado a dois
  armazéns lógicos.
- Código de endereço: `code` gerado conforme RN-DAD-011 (ex.: `A1-012-03-02`).
- Imutabilidade: alterar `warehouse.code` ou `client.code` é rejeitado.
- Geração em massa: intervalo A1–A2 × módulos 001–003 × níveis 00–01 × vãos
  01–02 cria exatamente 24 endereços, sem duplicidade.
- Enum inválido é rejeitado pelo CHECK do banco.

## DEFINITION OF DONE
```bash
docker compose up -d
pnpm build
pnpm test && pnpm test:integration    # todos verdes, zero skip
git commit && git push
```
Cole a saída REAL. Relatório `docs/relatorios/SESSAO-2A-relatorio.md` com
matriz requisito → arquivo → teste e lista de lacunas.

## FORA DE ESCOPO (será 2B ou depois)
Produtos, espécies, categorias, embalagens, códigos de barras, lotes, paletes,
LPN e seu Mod-10, `stock_balance`, `fiscal_stock_balance`, `stock_movement`,
`document_sequence` e máscaras de numeração, importação por planilha
(RF-DAD-053), RBAC real, qualquer regra de movimentação.
