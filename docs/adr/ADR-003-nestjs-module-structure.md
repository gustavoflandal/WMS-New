# ADR-003: NestJS Module Structure and Organization

**Date**: 2026-08-11  
**Status**: DECIDED  
**Decision Maker**: Architecture Team

## Problem

WMS backend has 10 business modules (portaria, recebimento, estoque, etc.) plus 3 core modules (database, logger, redis). Need to define:
- Folder structure within each module
- Whether modules are feature-driven or layered
- Shared service injection pattern

## Decision

**Approved**: Feature-Driven Module Structure with Shared Core

### Module Organization

```
src/
├── core/                          # Infrastructure modules
│   ├── core.module.ts
│   ├── logger/                    # Pino logging (RNF-ARQ-070)
│   ├── database/                  # PostgreSQL connection
│   ├── redis/                     # Redis client
│   └── health/                    # Health check endpoints (RNF-ARQ-002)
│
├── modules/                       # Business modules (RNF-ARQ-001)
│   ├── portaria/
│   │   ├── portaria.module.ts
│   │   ├── portaria.controller.ts (when implemented)
│   │   ├── portaria.service.ts
│   │   ├── dto/
│   │   ├── entities/
│   │   └── portaria.spec.ts
│   │
│   ├── recebimento/
│   ├── estoque/
│   ├── expedicao/
│   ├── fiscal/
│   ├── faturamento/
│   ├── paineis/
│   ├── perifericos/
│   ├── seguranca/
│   └── integracoes/
│
└── app.module.ts                  # Root module
```

### Core Module Exports

Each core module exports:
- Service (if applicable)
- Token/Provider (if multi-implementation)

Example:
```typescript
// core/database/database.module.ts
@Module({
  providers: [{ provide: 'DATABASE_CONNECTION', useFactory: ... }],
  exports: ['DATABASE_CONNECTION'],
})
export class DatabaseModule {}
```

### Feature Modules

Each business module is self-contained:
- Controllers handle HTTP routing
- Services contain business logic
- DTOs for validation (via class-validator)
- Entities/Types in `/dto` or dedicated `/types`
- Unit tests co-located (*.spec.ts)

### Per-Module Subdirectories (When Implemented)

- `dto/` — Data Transfer Objects + validation
- `entities/` — TypeORM entities or database types (Session 1)
- `services/` — Business logic
- `controllers/` — HTTP endpoints
- `guards/` — Auth/permission guards (seguranca module)

### Dependency Injection Pattern

All modules import `CoreModule`:
```typescript
@Module({
  imports: [CoreModule],
  controllers: [RecebimentoController],
  providers: [RecebimentoService],
})
export class RecebimentoModule {}
```

Services receive dependencies via constructor:
```typescript
@Injectable()
export class RecebimentoService {
  constructor(
    @Inject('DATABASE_CONNECTION') private db,
    private logger: LoggerService,
  ) {}
}
```

## Why Feature-Driven?

1. **Cohesion**: Each module owns its data models and logic
2. **Scalability**: Easy to extract as separate microservice later
3. **Testing**: Module can be tested in isolation
4. **NestJS Convention**: Aligns with NestJS best practices

## Why Not Layered (controllers/ services/ dto/ all at root)?

- Less maintainable as modules grow
- Harder to understand boundaries
- Difficult to extract features

## Technology Notes

- **Validation**: class-validator + ClassSerializerInterceptor
- **DTOs**: Use DTOs for both request validation AND API response serialization
- **Entities**: To be decided in Session 1 (TypeORM vs. Kysely)
- **Guards**: Per-module guards in `guards/` subdirectory

## Migration Path

If monolithic structure becomes unmanageable:
1. Move module to separate package in `/packages`
2. Create NestJS Gateway/BFF at `/apps/backend-gateway`
3. Modules communicate via HTTP or message queue (Redis Streams)

## References

- RNF-ARQ-001: 10 business modules as specified
- DOC-00: Stack congelada (NestJS only)
- NestJS docs: https://docs.nestjs.com/modules
