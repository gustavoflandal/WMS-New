// DOC-12 RG-003 [INVIOLÁVEL] — unit test do middleware isolado (sem rede/DB):
// prova que actor_user_id/user_id em body OU query são REJEITADOS (400),
// nunca ignorados em silêncio, e que requisições limpas passam adiante.
import { Request, Response, NextFunction } from 'express';
import { rejectActorSpoofingMiddleware } from '../reject-actor-spoofing.middleware.js';

function fakeReqRes(body: unknown, query: unknown = {}): { req: Request; res: Response; next: NextFunction; statusMock: any; jsonMock: any } {
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock }));
  const res = { status: statusMock } as unknown as Response;
  const req = { body, query } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

describe('rejectActorSpoofingMiddleware - DOC-12 RG-003 [INVIOLÁVEL]', () => {
  it('rejeita (400) quando actor_user_id está no body', () => {
    const { req, res, next, statusMock, jsonMock } = fakeReqRes({ actor_user_id: '00000000-0000-0000-0000-000000000099' });
    rejectActorSpoofingMiddleware(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/RG-003/) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejeita (400) quando user_id está no body', () => {
    const { req, res, next, statusMock } = fakeReqRes({ user_id: '00000000-0000-0000-0000-000000000099' });
    rejectActorSpoofingMiddleware(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejeita (400) quando actor_user_id está na query', () => {
    const { req, res, next, statusMock } = fakeReqRes({}, { actor_user_id: '00000000-0000-0000-0000-000000000099' });
    rejectActorSpoofingMiddleware(req, res, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('não bloqueia (chama next) uma requisição sem actor_user_id/user_id', () => {
    const { req, res, next, statusMock } = fakeReqRes({ code: 'ZN1', name: 'Zona' }, { warehouse_id: 'abc' });
    rejectActorSpoofingMiddleware(req, res, next);
    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('não bloqueia quando body/query estão ausentes (undefined)', () => {
    const jsonMock = vi.fn();
    const statusMock = vi.fn(() => ({ json: jsonMock }));
    const res = { status: statusMock } as unknown as Response;
    const req = {} as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    rejectActorSpoofingMiddleware(req, res, next);
    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
