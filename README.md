# WMS Enterprise 3PL — Warehouse Management System

Sistema moderno de gestão de armazéns para operadores logísticos (3PL) que gerenciam múltiplos armazéns e empresas-clientes.

## Stack Tecnológico

- **Frontend**: Next.js 14 + React 18 + Tailwind CSS + Radix UI
- **Backend**: Node.js 20 + NestJS + PostgreSQL 16 + Redis 7 + MinIO
- **Arquitetura**: Monorepo (pnpm workspaces + Turborepo)
- **Qualidade**: TypeScript strict, ESLint, Prettier, vitest
- **CI/CD**: GitHub Actions (lint, typecheck, test, build)

## Início Rápido (5 Comandos)

```bash
# 1. Instalar dependências
pnpm install

# 2. Construir todos os pacotes
pnpm build

# 3. Executar testes
pnpm test

# 4. Subir ambiente Docker
docker compose -f infra/docker-compose.yml up -d

# 5. Verificar saúde da API
curl http://localhost:3000/health/ready
```

## Estrutura do Repositório

```
wms-enterprise-3pl/
├── apps/
│   ├── backend/          # NestJS API (api|worker|scheduler profiles)
│   ├── frontend/         # Next.js Portal (internal|portal|field areas)
│   └── edge-agent/       # Hardware bridge (placeholder)
├── packages/
│   ├── ui/               # Radix + Tailwind component library
│   └── contracts/        # Shared TypeScript types & enums
├── infra/
│   ├── docker-compose.yml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── postgres/init/    # Database initialization scripts
├── migrations/           # SQL database migrations
├── docs/                 # Specification documents (DOC-00 a DOC-13)
│   ├── adr/              # Architecture Decision Records
│   └── relatorios/       # Session reports & gaps
└── [root configs]        # tsconfig, eslint, prettier, commitlint
```

## Comandos Principais

### Desenvolvimento

```bash
# Iniciar todos os serviços em paralelo
pnpm dev

# Iniciar apenas backend
pnpm --filter @wms/backend dev

# Iniciar apenas frontend (porta 3001)
pnpm --filter @wms/frontend dev
```

### Qualidade

```bash
# Lint em todas os pacotes
pnpm lint

# Format com Prettier
pnpm format

# TypeScript strict mode check
pnpm type-check

# Testes com coverage
pnpm test
```

### Docker

```bash
# Subir todos os serviços
docker compose -f infra/docker-compose.yml up -d

# Visualizar logs
docker compose -f infra/docker-compose.yml logs -f

# Parar ambiente
docker compose -f infra/docker-compose.yml down
```

## Serviços Disponíveis

- **API Backend**: http://localhost:3000
  - Health: `/health/live` (liveness)
  - Readiness: `/health/ready` (checks PostgreSQL + Redis)
- **Frontend**: http://localhost:3001
- **MinIO Console**: http://localhost:9001 (minioadmin / minioadmin)
- **PostgreSQL**: localhost:5432 (wms_db)
- **Redis**: localhost:6379

## Arquitetura Geral

### Multi-tenancy & Segurança (RG-001)
- Isolamento por Row-Level Security (RLS) no PostgreSQL
- Contexto de tenant obrigatório em toda transação
- Role `wms_app` sem permissão BYPASSRLS

### Backend Multi-Perfil (RNF-ARQ-003)
```
API Server       → HTTP na porta 3000 (transações)
Worker Service   → Processamento de background jobs (Redis Streams)
Scheduler        → Tarefas agendadas (cron, inventários automáticos)
```
Mesma imagem Docker, app_role distinto via env var.

### Logging Estruturado (RNF-ARQ-070)
Pino JSON com trace_id/span_id (placeholders para OpenTelemetry na Session 1).

### Frontend: Três Áreas (RNF-ARQ-004)
- **`(internal)`**: Operadores internos (recebimento, expedição, painéis)
- **`(portal)`**: Clientes externos (consulta estoque, pré-faturas)
- **`(field)`**: Coletores/tablets com PWA offline-first

## Próximas Etapas

### Session 1 — Fundação (DOC-01, DOC-02, DOC-12)
- [ ] ORM/Query builder decision (Kysely vs. node-pg)
- [ ] Database connection pool + migrations runner
- [ ] RLS policies per tenant
- [ ] RBAC system (roles, permissions, approval authorities)
- [ ] Complete audit logging
- [ ] OpenTelemetry integration (trace_id/span_id)

### Session 2+ — Business Modules
- Portaria (gate-in/out)
- Recebimento (receiving)
- Estoque (inventory)
- Expedição (shipping)
- Fiscal (NF-e, RG-014: fiscal stock tracking)
- Faturamento (billing)
- And more...

## Referência de Documentação

Toda a especificação está em `/docs`:
- **DOC-00**: Documento Mestre (governa tudo)
- **DOC-01**: Arquitetura & Infraestrutura
- **DOC-02**: Modelo de Dados
- **DOC-03 a DOC-13**: Módulos operacionais

## Convenções

- **IDs de Requisitos**: Formato `<TIPO>-<MÓDULO>-<SEQ>` (ex: RF-EXP-014)
- **Enums**: SCREAMING_SNAKE_CASE em inglês
- **Datas**: ISO 8601 UTC em persistência, fuso do armazém em exibição
- **Moeda**: BRL, 2 casas decimais
- **UUIDs**: UUID v7 (sortable by timestamp)

## Troubleshooting

### Docker falha ao iniciar PostgreSQL
```bash
# Limpar volumes
docker volume rm wms-postgres wms-redis wms-minio

# Reiniciar
docker compose -f infra/docker-compose.yml up -d
```

### Portas já em uso
```bash
# Procurar processos usando porta (ex: 3000)
lsof -i :3000

# Usar valores diferentes no .env
API_PORT=3100 docker compose up -d
```

## Licença

PROPRIETARY - WMS Enterprise
