import http from 'node:http';
import { buildRouter } from './routes';
import { HttpError, readBody, sendJson } from './routes/router';
import { serveStatic } from './static';
import { ExternalApiError } from './utils/http';
import { logger } from './utils/logger';

export function createServer(): http.Server {
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const match = router.match(method, url.pathname);
      if (!match && method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
      if (!match) throw new HttpError(404, `Rota não encontrada: ${method} ${url.pathname}`);

      const body = method === 'POST' ? await readBody(req) : {};
      const result = await match.handler({ req, res, params: match.params, query: url.searchParams, body });
      if (!res.writableEnded) sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof ExternalApiError ? 502 : 500;
      if (status >= 500) logger.error('Erro na requisição', { path: url.pathname, error: (err as Error).message });
      if (!res.writableEnded) sendJson(res, status, { error: (err as Error).message });
    } finally {
      logger.debug(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
}
