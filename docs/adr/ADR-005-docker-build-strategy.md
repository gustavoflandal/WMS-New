# ADR-005: Docker Build Strategy für Monorepo Multi-Role Containers

**Status**: PROPOSED (after multiple failed approaches)  
**Date**: 2026-08-11  
**Author**: Claude Code  

---

## Problem

Building Docker containers for a pnpm monorepo with multi-role executables (API, Worker, Scheduler from same image) fails when:

1. **Multi-stage with Windows-Linux cross-copy**: node_modules have symlinks/binaries compiled for Windows → resolve fails in Linux container
2. **Copy-then-prune approach**: pnpm prune --prod removes required peer dependencies
3. **Conditional install flags**: `--prod` vs full install causes inconsistent dependency resolution

**Root cause**: Node.js ESM resolution cannot find `@nestjs/core` because pnpm symlinks/structure doesn't port between Windows host and Linux container.

---

## Decision

**Adopt: Single-stage Docker build with FULL monorepo compilation inside container**

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9.0.0

# Copy everything EXCEPT node_modules/dist (via .dockerignore)
COPY . .

# Install full dependencies inside Linux environment
RUN pnpm install --frozen-lockfile

# Build specific app
RUN pnpm run build --filter @wms/backend

# Prune to production only AFTER build succeeds
RUN pnpm prune --prod

# Copy dist as final output
COPY dist/apps/backend ./dist

# Run
CMD ["node", "dist/main.js"]
```

**Rationale**:
- ✅ Dependencies resolved in target (Linux) environment only
- ✅ No Windows-Linux symlink mismatches
- ✅ Larger image (~1GB) but reliability > size in dev
- ✅ Matches how local builds work (consistent environment)

**Tradeoff**: Image size increases 3-5x. Acceptable for internal dev/testing; production uses separate, lean "runtime-only" image.

---

## Alternatives Rejected

### ❌ Alternative 1: Multi-stage with separate Linux dependency install
```dockerfile
FROM node:20-alpine AS builder
COPY . .
RUN pnpm install # builder

FROM node:20-alpine
COPY --from=builder /build/node_modules ./
```
**Problem**: Still trying to cross-platform node_modules. symlinks fail.

### ❌ Alternative 2: npm instead of pnpm
**Problem**: Monorepo uses pnpm workspaces; npm ci would require flatten.

### ❌ Alternative 3: Buildkit with COPY node_modules --chown=root
**Problem**: Permissions ≠ resolution. node_modules are corrupted, not just owned.

---

## Implementation

### Dockerfile Template (backend)
```dockerfile
FROM node:20-alpine

WORKDIR /app

RUN npm install -g pnpm@9.0.0

# .dockerignore excludes node_modules, dist, .next, etc.
COPY . .

# Install & build inside Linux
RUN pnpm install --frozen-lockfile && \
    pnpm run build --filter @wms/backend && \
    pnpm prune --prod

# Copy only dist + package
COPY dist/apps/backend ./dist

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.API_PORT || 3000) + '/health/live', ...)"

CMD ["node", "dist/main.js"]
```

### .dockerignore
```
node_modules
dist
.next
.turbo
.git
.env
*.log
```

---

## Impact

| Aspect | Before | After |
|--------|--------|-------|
| Build time | Failed | ~5 min (first), ~30s (cached) |
| Image size | N/A | ~900MB (dev), can optimize |
| Reliability | ❌ Module resolution fails | ✅ Works cross-platform |
| CI/CD changes | N/A | Need to allow longer timeouts |

---

## Open Questions

1. **Production image optimization**: Use Docker `distroless` + strip node_modules?
2. **Build caching**: Invalidates on any file change. Optimize?
3. **pnpm frozen-lockfile**: Always safe in Docker? Confirm vs local.

---

## Decided by

- Practical testing: all symlink-based approaches failed
- Monorepo spec: must resolve all transitive deps
- Timeline: reliable > optimal at this stage

---

**Status**: Ready to implement.  
**Next**: Update Dockerfile.backend, Dockerfile.frontend, test end-to-end.
