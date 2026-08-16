// Maps Postgres constraint violations (DOC-03 CHECK/UNIQUE/FK constraints) to
// deterministic HTTP errors instead of leaking raw driver errors. Duplicated
// from modules/cadastro/shared/db-error.util.ts (RNF-ARQ-001: each module is
// self-contained) rather than cross-imported.
import { BadRequestException, ConflictException } from '@nestjs/common';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

/** Rethrows known Postgres constraint errors as domain HTTP exceptions; rethrows anything else as-is. */
export function mapPortariaDbError(error: unknown): never {
  const pgError = error as PgError;

  if (pgError?.code === '23505') {
    throw new ConflictException({ error: 'DUPLICATE', constraint: pgError.constraint, detail: pgError.detail });
  }

  if (pgError?.code === '23514') {
    throw new BadRequestException({ error: 'CONSTRAINT_VIOLATION', constraint: pgError.constraint, detail: pgError.message });
  }

  if (pgError?.code === '23503') {
    throw new BadRequestException({ error: 'INVALID_REFERENCE', constraint: pgError.constraint, detail: pgError.detail });
  }

  throw error;
}
