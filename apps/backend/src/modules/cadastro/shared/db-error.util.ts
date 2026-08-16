// Maps Postgres constraint violations (DOC-02 CHECK/UNIQUE/FK constraints) to
// deterministic HTTP errors instead of leaking raw driver errors, per the
// Gherkin scenarios in DOC-02 §7 ("o sistema deve rejeitar com erro determinístico").
import { BadRequestException, ConflictException } from '@nestjs/common';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

/** Rethrows known Postgres constraint errors as domain HTTP exceptions; rethrows anything else as-is. */
export function mapCadastroDbError(error: unknown): never {
  const pgError = error as PgError;

  if (pgError?.code === '23505') {
    // unique_violation
    throw new ConflictException({
      error: 'DUPLICATE',
      constraint: pgError.constraint,
      detail: pgError.detail,
    });
  }

  if (pgError?.code === '23514') {
    // check_violation (enum CHECK, format CHECK, immutability triggers using ERRCODE 23514)
    throw new BadRequestException({
      error: 'CONSTRAINT_VIOLATION',
      constraint: pgError.constraint,
      detail: pgError.message,
    });
  }

  if (pgError?.code === '23503') {
    // foreign_key_violation
    throw new BadRequestException({
      error: 'INVALID_REFERENCE',
      constraint: pgError.constraint,
      detail: pgError.detail,
    });
  }

  throw error;
}
