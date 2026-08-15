# ADR-002: Monorepo Tooling — pnpm Workspaces + Turborepo

**Date**: 2026-08-11  
**Status**: DECIDED  
**Decision Maker**: Architecture Team

## Problem

WMS system is organized as a monorepo with multiple apps (backend, frontend, edge-agent) and shared packages (ui, contracts). Need to choose:
- Package manager (npm, yarn, pnpm)
- Task orchestrator (Turborepo, Nx, Lerna)

## Constraints

- RNF-ARQ-001: Multiple packages must share TypeScript and ESLint configurations
- Build output should be efficient (cache aware, parallel execution)
- Node.js ≥ 20 available

## Decision

**Approved**: pnpm 9.0.0 + Turborepo

### Rationale

1. **pnpm Workspaces**
   - Stricter dependency management than npm/yarn (catches missing deps)
   - 50-60% disk savings (hard links to global store)
   - Native monorepo support via `pnpm-workspace.yaml`
   - Fast hoisting resolves cross-package imports correctly

2. **Turborepo**
   - Zero-config caching for build artifacts and test results
   - Parallel task execution with dependency graph
   - Smart filtering (`--filter`) for CI efficiency
   - Native TypeScript support

### Implementation

**Created**:
- `pnpm-workspace.yaml` — defines package locations
- `turbo.json` — task pipeline, caching rules, outputs
- `package.json` — root-level scripts using turbo

**Usage**:
```bash
pnpm install                    # Installs all workspaces
pnpm build                      # Parallel build with caching
pnpm test                       # Run tests in dependency order
pnpm --filter @wms/backend dev  # Dev mode for specific package
```

### Why Not Alternatives?

- **npm workspaces**: Slower, less strict dependency resolution
- **Yarn v3+**: Good choice, but pnpm is lighter + Turborepo better integrated
- **Lerna + npm**: Over-engineered for this mono-repo size; Turborepo simpler
- **Nx**: Heavier overhead; Turborepo sufficient for our needs

## Migration Path

If requirements change in future:
- Turborepo → Nx: Non-breaking (Nx can consume turbo.json)
- pnpm → yarn: Rewrite lock file, minimal code changes

## References

- pnpm: https://pnpm.io/workspaces
- Turborepo: https://turbo.build
- Session 0 scaffold decisions
