// Cliente HTTP para a área internal — injeta o token de autenticação e
// traduz erro de API para mensagem legível (nunca stack trace na tela,
// sistema de design §6 "Feedback de ação"). Backend responde erros como
// RFC 9457 problem+json (ver PermissionGuard/filtros do DOC-12) — {error,
// detail} é o formato mais comum visto nos services do backend.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Token de sessão, não dado de negócio (RG-013 proíbe localStorage para
  // dados de negócio — autenticação é estado de sessão, mesma categoria de
  // um cookie de sessão). sessionStorage: some ao fechar a aba, sem
  // persistência entre sessões do navegador.
  return window.sessionStorage.getItem('wms_access_token');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let code = 'ERRO_DESCONHECIDO';
    let message = `Falha na requisição (HTTP ${response.status})`;
    try {
      const body = await response.json();
      code = body.error ?? body.response?.error ?? code;
      message = body.detail ?? body.response?.detail ?? body.message ?? message;
    } catch {
      // corpo não era JSON — mantém a mensagem genérica acima.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/csv')) return (await response.text()) as unknown as T;
  return response.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
};

export function setAccessToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.sessionStorage.setItem('wms_access_token', token);
  else window.sessionStorage.removeItem('wms_access_token');
}

export { API_URL };
