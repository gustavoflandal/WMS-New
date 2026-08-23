// DOC-12 RG-003 [INVIOLÁVEL] — o autor de qualquer ação (escrita OU leitura
// que estabelece contexto de tenant/RLS via app.user_id) vem exclusivamente
// do JWT, nunca do cliente. Antes desta correção, 13 controllers de cadastro
// aceitavam `actor_user_id` via body/query e o repassavam direto para
// created_by/updated_by e para o GUC app.user_id (DatabaseService.query),
// permitindo que qualquer usuário autenticado se passasse por outro na
// trilha de auditoria. Middleware global (não um util opcional por
// controller) para que nenhum módulo — presente ou futuro — precise lembrar
// de repetir a checagem: rejeita explicitamente (400), nunca ignora em
// silêncio.
import type { Request, Response, NextFunction } from 'express';

const FORBIDDEN_KEYS = ['actor_user_id', 'user_id'];

function findForbiddenKey(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null;
  for (const key of FORBIDDEN_KEYS) {
    if (key in (source as Record<string, unknown>)) return key;
  }
  return null;
}

export function rejectActorSpoofingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const offender = findForbiddenKey(req.body) ?? findForbiddenKey(req.query);
  if (offender) {
    res.status(400).json({
      statusCode: 400,
      error: 'Bad Request',
      message: `RG-003 [INVIOLÁVEL]: '${offender}' não pode ser informado pelo cliente — o ator é derivado exclusivamente do token autenticado`,
    });
    return;
  }
  next();
}
