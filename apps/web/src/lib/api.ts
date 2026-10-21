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

const MSG_SESSAO_EXPIRADA = 'Sessão expirada. Entre novamente para baixar o arquivo.';

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function startBrowserDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Jeito antigo: baixa tudo para a memória do navegador e só depois salva. Só serve para arquivos pequenos (e para
// endereços fora de /storage); com arquivo grande a tela parece parada por minutos.
async function downloadViaMemory(url: string, filename: string) {
  const token = getStoredToken();
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new ApiError(MSG_SEM_CONEXAO, 0);
  }
  if (!response.ok) {
    throw new ApiError(
      response.status === 401 ? MSG_SESSAO_EXPIRADA : `Erro ${response.status} ao baixar o arquivo.`,
      response.status,
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  startBrowserDownload(objectUrl, filename);
  // Revogar na hora cancela o download em alguns navegadores; dá tempo dele começar.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * Baixa um arquivo. Para arquivos do /storage pede ao servidor um link curto e assinado e deixa o NAVEGADOR baixar
 * direto para o disco (barra de progresso própria, sem encher a memória — há entradas de centenas de MB).
 * `notify` (opcional) recebe o aviso de que o download começou.
 */
export async function downloadFile(url: string, filename: string, notify?: (message: string) => void) {
  if (url.startsWith('/storage/')) {
    try {
      const link = await api<{ url: string; size: number }>('/storage/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: url }),
      });
      startBrowserDownload(link.url, filename);
      notify?.(
        link.size >= 1024 * 1024
          ? `Baixando "${filename}" (${formatBytes(link.size)}). Acompanhe na barra de downloads do navegador.`
          : `Download iniciado: ${filename}`,
      );
      return;
    } catch (error) {
      // Servidor ainda sem a rota nova (deploy em andamento): cai no jeito antigo. Qualquer outro erro é mostrado.
      const rotaNaoExiste = error instanceof ApiError && error.status === 404 && /^Cannot POST/.test(error.message);
      if (!rotaNaoExiste) throw error;
    }
  }
  await downloadViaMemory(url, filename);
}

export async function downloadWithFeedback(
  url: string,
  filename: string,
  notify: (message: string) => void,
) {
  try {
    await downloadFile(url, filename, notify);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      notify(MSG_SESSAO_EXPIRADA);
      return;
    }
    notify(error instanceof Error ? error.message : 'Não foi possível baixar o arquivo.');
  }
}
