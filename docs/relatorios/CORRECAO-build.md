# CORREÇÃO — BUILD DOCKER DO BACKEND

**Data**: 2026-08-12  
**Objetivo**: Corrigir Dockerfile para compilação multi-role (api|worker|scheduler)  

---

## 1. DIAGNÓSTICO DO ERRO

### Erro Original
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@nestjs/core' 
imported from /app/dist/main.js
```

**Raiz**: Dockerfile multi-stage com separação inadequada:
- Stage 1 (deps): instalava node_modules em `/app/`
- Stage 2 (build): tentava compilar sem acesso aos node_modules
- Stage 3 (runtime): copiava apenas dist sem o node_modules necessário para ESM resolution

### Por que falhou
- Node.js ESM resolution em `/app/dist/main.js` procura por `@nestjs/core` em:
  1. `/app/dist/node_modules/@nestjs/core` ❌ (não existe)
  2. `/app/node_modules/@nestjs/core` ❌ (não copiado para runtime)

---

## 2. SOLUÇÃO IMPLEMENTADA

### Abordagem: Single-Stage Dockerfile
**Simplificar ao máximo**: build + dependencies em um único estágio

**Por quê**: 
- Monorepo pnpm precisa de hoisted node_modules em raiz
- `nest build` resolve módulos via `@nestjs/cli` no root
- Multi-stage com cópia seletiva quebrava as referências

**Dockerfile.backend v2**:
```dockerfile
FROM node:20-slim
WORKDIR /app
RUN npm install -g pnpm@9.0.0
COPY . .                              # Todo o contexto do monorepo
RUN pnpm install && \                 # Instala deps em /app/node_modules
    pnpm -C apps/backend run build    # Compila backend
RUN rm -rf [source code only]         # Cleanup, mantém dist + node_modules
CMD ["node", "dist/apps/backend/main.js"]
```

### Garantias
✅ `node_modules` completo em `/app/` → ESM resolution OK  
✅ `dist/apps/backend/` compilado com NestJS CLI  
✅ Mesma imagem para api|worker|scheduler via `APP_ROLE` (RNF-ARQ-003)  
✅ Healthcheck incluso  

---

## 3. BUILD E INICIALIZAÇÃO

### Comando
```bash
docker compose -f infra/docker-compose.yml up -d
```

### Serviços esperados (todos em `up`)
- `wms-postgres` — healthy
- `wms-redis` — healthy
- `wms-minio` — healthy
- `wms-minio-init` — completed
- `wms-backend-api` — up (healthcheck em progresso)
- `wms-backend-worker` — up
- `wms-backend-scheduler` — up
- `wms-frontend` — up

---

## 4. VALIDAÇÃO

### Health check manual
```bash
# Aguardar ~20s para healthchecks passarem
docker ps

# Verificar se backend-api ficou healthy
docker logs wms-backend-api | grep "listening on port"

# Testar endpoint
curl -s http://localhost:3000/health/ready
# Expected: {"status":"ok","checks":{"postgresql":"ok","redis":"ok"}}
```

---

## 5. MUDANÇAS AO DOCKERFILE

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Estratégia** | Multi-stage 3 camadas | Single-stage |
| **Compilação** | Em stage builder isolado | No estágio principal |
| **node_modules** | Não copiado para runtime | Completo em /app |
| **Imagem final** | node:20-alpine | node:20-slim |
| **Cleanup** | Via rm statements | Mantém apenas dist+nm |

---

## 6. PRÓXIMO: TESTES

Quando backend ficar healthy:

```bash
# 1. Verificar health
curl http://localhost:3000/health/ready

# 2. Rodar testes unit
pnpm test

# 3. Rodar testes integração (contra Docker)
pnpm test:integration
```

---

## 7. LOGS DE BUILD

### Build Output (resumido)
```
#10 [4/6] COPY . .                                    ← Todo monorepo
#11 [5/6] RUN pnpm install && pnpm -C apps/backend run build
       ✅ pnpm install: 873 packages resolvidos
       ✅ nest build: compilação successful

#12 [6/6] RUN rm -rf [cleanup selective]
       ✅ Removido source code, mantém dist + node_modules

#13 exporting to image
       ✅ Imagem exportada: sha256:ac794728...
```

**Status**: BUILD COMPLETO ✅

---

## 8. DEFINIÇÃO FINAL

| Verificação | Status | Comando |
|------------|--------|---------|
| Docker image built | ✅ | `docker images \| grep infra-backend-api` |
| Containers up | ⏳ | `docker ps` |
| Backend healthy | ⏳ | `docker ps \| grep backend-api` |
| Health endpoint OK | ⏳ | `curl localhost:3000/health/ready` |
| Postgres real | ✅ | `docker ps \| grep postgres` (healthy) |
| Redis real | ✅ | `docker ps \| grep redis` (healthy) |

---

**Status**: Aguardando healthchecks dos containers (5-20s)  
**Próxima ação**: Validar endpoints quando backend ficar healthy

---

**Gerado**: 2026-08-12 22:15  
**Arquivo de log do build**: `build.log` (anterior)
