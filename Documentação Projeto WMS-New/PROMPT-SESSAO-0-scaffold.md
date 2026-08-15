# PROMPT — SESSÃO 0: SCAFFOLD DO MONOREPO WMS
> Uso: cole este prompt no Claude Code na raiz de um repositório vazio.
> Contexto obrigatório na sessão: `docs/DOC-00-documento-mestre.md` e `docs/DOC-01-arquitetura-infraestrutura.md`.

---

## PAPEL E MISSÃO

Você é o engenheiro responsável pela fundação do sistema WMS Enterprise 3PL especificado
nos documentos em `/docs`. Nesta sessão você criará EXCLUSIVAMENTE o scaffold do monorepo:
estrutura, tooling, containers e esqueletos vazios. NENHUMA regra de negócio será
implementada nesta sessão.

## REGRAS DE CONDUTA (obrigatórias — DOC-00 §1.2)

1. NÃO invente regras ausentes dos documentos. Ao encontrar lacuna, insira o marcador
   `[LACUNA: descrição]` em comentário no ponto exato e liste todas ao final no arquivo
   `docs/relatorios/SESSAO-0-lacunas.md`.
2. Ao detectar conflito entre documentos, registre `[CONFLITO: DOC-X §n vs DOC-Y §m]`
   no mesmo relatório e siga a precedência: DOC-00 > módulo específico.
3. Stack CONGELADA (DOC-00 §2.2): Next.js + Tailwind, NestJS, PostgreSQL ≥ 16, Redis,
   MinIO (S3). É PROIBIDO adicionar frameworks, ORMs alternativos, brokers ou bancos
   fora disso. Escolhas permitidas nesta sessão: ORM/query builder para PostgreSQL
   (usar Kysely ou node-pg com migrations SQL puras — justifique em ADR), gerenciador
   de pacotes (pnpm) e ferramenta de monorepo (pnpm workspaces + turborepo).
4. Todo arquivo criado a partir de um requisito referencia o ID em comentário
   (ex.: `// RNF-ARQ-002`).

## ENTREGÁVEIS DESTA SESSÃO

### 1. Estrutura do monorepo
```
/apps
  /backend        # NestJS (perfis api|worker|scheduler via APP_ROLE — RNF-ARQ-003)
  /frontend       # Next.js App Router, áreas internal|portal|field (RNF-ARQ-004)
  /edge-agent     # esqueleto Node do WMS Edge Agent (RNF-PER-001, só estrutura)
/packages
  /ui             # @wms/ui — biblioteca de componentes (Radix + Tailwind, ícones Lucide)
  /contracts      # tipos TS dos contratos canônicos e enums (placeholder)
/infra
  docker-compose.yml
  /postgres/init  # extensões, usuário da aplicação SEM ownership (RNF-ARQ-011)
/docs             # os 14 DOC-* (já presentes; não alterar)
  /adr            # decisões desta sessão
  /relatorios
/migrations       # migrations SQL numeradas (vazia + migration 0001 de bootstrap)
```

### 2. Docker Compose (`/infra`)
Serviços: postgres:16 (com volume, healthcheck), redis:7 (persistência AOF),
minio (com bucket inicial `wms` criado por job), backend (3 containers: api, worker,
scheduler — mesma imagem, `APP_ROLE` distinto — RNF-ARQ-003), frontend.
Healthchecks e `depends_on` condicionais. `.env.example` completo e comentado.

### 3. Backend NestJS
- Módulos NestJS VAZIOS nomeados conforme RNF-ARQ-001: `portaria`, `recebimento`,
  `estoque`, `expedicao`, `fiscal`, `faturamento`, `paineis`, `perifericos`,
  `seguranca`, `integracoes` + módulos técnicos `core` (config, logger, db, redis)
  e `health`.
- `GET /health/live` e `GET /health/ready` funcionais (RNF-ARQ-002): ready verifica
  PostgreSQL e Redis.
- Logger estruturado pino com os campos mínimos do RNF-ARQ-070 (trace_id/span_id
  como placeholders até a Sessão 1 instrumentar OTel).
- Bootstrap por `APP_ROLE`: api sobe HTTP; worker e scheduler sobem sem HTTP com
  loop de vida e shutdown gracioso.

### 4. Frontend Next.js
- App Router com três grupos de rota: `(internal)`, `(portal)`, `(field)` e uma
  página placeholder em cada, usando 2 componentes de exemplo do `@wms/ui`
  (Button, Card) com tokens Tailwind e ícones Lucide (RG-013).
- PWA: manifest + service worker de shell mínimo APENAS na área field (sem lógica
  de sincronização — isso é sessão futura).

### 5. Migration 0001 (bootstrap)
Apenas infraestrutura de banco desta sessão:
- extensão `pgcrypto`/uuid; função utilitária de UUID v7 (RG-011);
- role de aplicação `wms_app` SEM ownership e SEM BYPASSRLS (RNF-ARQ-011);
- schema `wms`; tabela `schema_migration` de controle.
NENHUMA tabela de negócio nesta sessão (elas vêm do DOC-02 na Sessão 2).

### 6. Qualidade e CI
- TypeScript strict em tudo; ESLint + Prettier compartilhados; commitlint conventional.
- Testes: vitest (packages/backend) e um teste real passando por app (ex.: health).
- GitHub Actions: lint + typecheck + testes + build das imagens em PR.
- `README.md` raiz: subir o ambiente em 5 comandos, mapa do repositório, link dos docs.

### 7. ADRs (`/docs/adr`)
Registrar: escolha do ORM/migrations, pnpm+turborepo, estrutura de pastas do NestJS,
estratégia de imagem Docker única multi-role.

## DEFINITION OF DONE (verifique e demonstre)
```bash
pnpm install && pnpm build && pnpm test        # tudo verde
docker compose -f infra/docker-compose.yml up -d
curl localhost:3000/health/ready               # {"status":"ok",...}
docker compose ps                              # api, worker, scheduler, pg, redis, minio saudáveis
```
Ao final: gere `docs/relatorios/SESSAO-0-relatorio.md` com o que foi criado,
decisões tomadas, lacunas/conflitos (se houver) e o checklist acima executado.

## FORA DE ESCOPO DESTA SESSÃO (não implementar)
RLS e contexto de tenant, outbox, WebSocket, RBAC, qualquer tabela ou regra de
negócio, PWA offline real, instrumentação OpenTelemetry completa.
