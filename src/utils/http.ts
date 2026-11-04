import { config } from '../config/env';

export class ExternalApiError extends Error {
  constructor(
    public readonly service: 'ZABBIX' | 'GLPI',
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(`[${service}] ${message}`);
    this.name = 'ExternalApiError';
  }
}

export async function requestJson<T>(
  service: 'ZABBIX' | 'GLPI',
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.httpTimeoutMs) });
  } catch (err) {
    throw new ExternalApiError(service, `Falha de conexão com ${url}: ${(err as Error).message}`);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok && res.status !== 206) {
    throw new ExternalApiError(service, `HTTP ${res.status} em ${url}`, res.status, data);
  }
  return { status: res.status, data: data as T, headers: res.headers };
}
