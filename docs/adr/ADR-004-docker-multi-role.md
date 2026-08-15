# ADR-004: Single Docker Image with Multiple Roles (API, Worker, Scheduler)

**Date**: 2026-08-11  
**Status**: DECIDED  
**Decision Maker**: Architecture Team

## Problem

Backend needs to run three distinct roles (RNF-ARQ-003):
- **API**: HTTP server handling transactional requests
- **Worker**: Background job processor (from Redis Streams)
- **Scheduler**: Scheduled tasks (inventories, reconciliation, etc.)

Options:
1. Single Docker image, multiple containers with `APP_ROLE` env var
2. Three separate Dockerfiles + images
3. Kubernetes-style Helm charts with different deployments

## Decision

**Approved**: Single Image, Multiple Containers via `APP_ROLE` Environment Variable

### Implementation

**Dockerfile.backend**:
- Multi-stage build (reduces image size)
- Both API and non-API services use same entry point
- Role detection at runtime in `main.ts`

**docker-compose.yml**:
```yaml
backend-api:
  build: ./infra/Dockerfile.backend
  environment:
    APP_ROLE: api          # Listens on HTTP port 3000

backend-worker:
  build: ./infra/Dockerfile.backend
  environment:
    APP_ROLE: worker       # No HTTP, consumes Redis Streams

backend-scheduler:
  build: ./infra/Dockerfile.backend
  environment:
    APP_ROLE: scheduler    # No HTTP, runs cron jobs
```

### Bootstrap Logic (main.ts)

```typescript
const appRole = process.env.APP_ROLE || 'api';

if (appRole === 'api') {
  await app.listen(3000);  // HTTP server
} else if (appRole === 'worker') {
  // Worker-specific init
} else if (appRole === 'scheduler') {
  // Scheduler-specific init
}
```

## Rationale

### Single Image Advantages
1. **Consistency**: All three roles run identical code
2. **Deployment**: Single artifact to version and distribute
3. **Development**: `pnpm dev` runs one process; Docker runs three
4. **Dependency Management**: No duplicated build steps

### Multi-Container Advantages
1. **Independent Scaling**: Run N workers, M schedulers, 1 API
2. **Resource Isolation**: Can set different memory/CPU limits per role
3. **Failure Isolation**: One crashing worker doesn't kill scheduler
4. **Observability**: Distinct logs/metrics per container role

### Why Not Separate Images?
- Maintenance burden: Three Dockerfiles to keep in sync
- CI/CD complexity: Push 3 images instead of 1
- Deployment: More configurations in docker-compose

### Why Not Monolithic Single Process?
- HTTP server blocks event loop → degraded concurrency
- No graceful shutdown without coordination
- Harder to scale independently

## Kubernetes Migration

When migrating to Kubernetes:
```yaml
# Same image, different deployment specs
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wms-api
spec:
  replicas: 3
  template:
    spec:
      containers:
      - image: wms/backend:v0.0.1
        env:
        - name: APP_ROLE
          value: api

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wms-worker
spec:
  replicas: 5
  template:
    spec:
      containers:
      - image: wms/backend:v0.0.1
        env:
        - name: APP_ROLE
          value: worker
```

## Healthchecks

- **API**: HTTP probe `/health/live`
- **Worker**: Custom liveness check (Redis connection active)
- **Scheduler**: Custom liveness check (process running)

Placeholder: Implement in Session 1 when role-specific logic added.

## Configuration Strategy

| Setting | Value | Source |
|---------|-------|--------|
| APP_ROLE | api/worker/scheduler | env var |
| HTTP Port | 3000 | env (ignored for worker/scheduler) |
| DB Connection | PostgreSQL URL | env |
| Redis URL | Redis cluster | env |
| Log Level | info/debug | env |

Single `.env.example` covers all roles.

## Testing Strategy

- **Unit Tests**: Independent of role
- **Integration Tests**: Run with APP_ROLE=api (HTTP endpoints)
- **Worker Tests**: Mock Redis Streams (Session 1)
- **Scheduler Tests**: Mock cron/interval (Session 1)

## Future Evolution

If scaling requirements demand:
- Extract API to separate repo (`@wms/backend-api`)
- Keep worker/scheduler in shared monorepo
- Use message queue for cross-repo communication

## References

- RNF-ARQ-003: Multi-role bootstrap requirement
- apps/backend/src/main.ts: Bootstrap implementation
- infra/docker-compose.yml: Container role configuration
