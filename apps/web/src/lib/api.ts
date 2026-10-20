export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const AUTH_TOKEN_KEY = 'automation-hub-token';

export function getStoredToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setStoredToken(token: string | null) {
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    return;
  }

  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

/** Erro de uma chamada à API; `status` 0 = nem chegou ao servidor (rede caiu, hub reiniciando). */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Falha que costuma passar sozinha (hub reiniciando/sobrecarregado, rede): vale tentar de novo. */
export function isTransientError(err: unknown) {
  const status = err instanceof ApiError ? err.status : 0;
  return !(status === 400 || status === 401 || status === 403 || status === 404);
}

const MSG_SERVIDOR_INDISPONIVEL =
  'O servidor está indisponível no momento (pode estar reiniciando ou sobrecarregado). Tente de novo em instantes.';
const MSG_SEM_CONEXAO = 'Sem conexão com o servidor. Verifique a rede ou aguarde: ele pode estar reiniciando.';

// Página de erro de quem está na frente do hub (IIS "502 - O servidor Web recebeu uma resposta inválida...").
function pareceHtml(texto: string) {
  return /^\s*(<!doctype html|<html)/i.test(texto);
}

export async function api<T>(path: string, options: RequestInit = {}) {
  const token = getStoredToken();
  const headers = new Headers(options.headers ?? {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new ApiError(MSG_SEM_CONEXAO, 0);
  }

  if (!response.ok) {
    const text = await response.text();
    let message: string;
    try {
      const json = JSON.parse(text) as { message?: unknown };
      message = typeof json.message === 'string' ? json.message : text;
    } catch {
      message = pareceHtml(text) ? MSG_SERVIDOR_INDISPONIVEL : text || `Erro ${response.status}: ${response.statusText}`;
    }
    throw new ApiError(message || 'Falha na requisição.', response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  return response.text() as T;
}

export async function downloadFile(url: string, filename: string) {
  const token = getStoredToken();
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'Sessão expirada. Entre novamente para baixar o arquivo.'
        : `Erro ${response.status} ao baixar o arquivo.`,
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

export async function downloadWithFeedback(
  url: string,
  filename: string,
  notify: (message: string) => void,
) {
  try {
    await downloadFile(url, filename);
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Não foi possível baixar o arquivo.');
  }
}
