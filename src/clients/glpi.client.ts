import { config } from '../config/env';
import { ExternalApiError, requestJson } from '../utils/http';
import { logger } from '../utils/logger';
import type { GlpiInteractions, GlpiSubItem, GlpiTicket } from '../types';

/** Group_Ticket.type: 1 = requerente, 2 = atribuído (grupo técnico), 3 = observador */
const GROUP_TYPE_ASSIGNED = 2;

let sessionToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.glpi.appToken) h['App-Token'] = config.glpi.appToken;
  return h;
}

async function initSession(): Promise<string> {
  const { data } = await requestJson<{ session_token: string }>('GLPI', `${config.glpi.url}/initSession`, {
    method: 'GET',
    headers: { ...baseHeaders(), Authorization: `user_token ${config.glpi.userToken}` },
  });
  if (!data?.session_token) throw new ExternalApiError('GLPI', 'initSession não retornou session_token');
  const token = data.session_token;

  // Garante visibilidade de todos os contratos (entidade raiz + recursivo)
  await requestJson('GLPI', `${config.glpi.url}/changeActiveEntities`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Session-Token': token },
    body: JSON.stringify({
      entities_id: config.glpi.rootEntityId,
      is_recursive: config.glpi.entityRecursive,
    }),
  });

  logger.info('Sessão GLPI iniciada', {
    rootEntity: config.glpi.rootEntityId,
    recursive: config.glpi.entityRecursive,
  });
  return token;
}

async function getSession(): Promise<string> {
  if (sessionToken) return sessionToken;
  if (!sessionPromise) {
    sessionPromise = initSession()
      .then((t) => {
        sessionToken = t;
        return t;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<{ status: number; data: T }> {
  const token = await getSession();
  try {
    return await requestJson<T>('GLPI', `${config.glpi.url}${path}`, {
      ...init,
      headers: { ...baseHeaders(), 'Session-Token': token, ...(init.headers as Record<string, string>) },
    });
  } catch (err) {
    if (retry && err instanceof ExternalApiError && err.status === 401) {
      sessionToken = null;
      return api<T>(path, init, false);
    }
    throw err;
  }
}

async function subItems(ticketId: number, itemtype: string): Promise<GlpiSubItem[]> {
  const { data } = await api<GlpiSubItem[] | unknown>(`/Ticket/${ticketId}/${itemtype}?range=0-999`);
  return Array.isArray(data) ? (data as GlpiSubItem[]) : [];
}

export const glpiClient = {
  async killSession(): Promise<void> {
    if (!sessionToken) return;
    try {
      await requestJson('GLPI', `${config.glpi.url}/killSession`, {
        method: 'GET',
        headers: { ...baseHeaders(), 'Session-Token': sessionToken },
      });
    } catch (err) {
      logger.warn('Falha ao encerrar sessão GLPI', { error: (err as Error).message });
    } finally {
      sessionToken = null;
    }
  },

  /**
   * IDs de chamados "Em Atendimento (atribuído)", abertos após `since`,
   * cujo GRUPO TÉCNICO é um dos GLPI_TECH_GROUP_IDS (Nível 1).
   */
  async searchAssignedTicketIds(since: string): Promise<number[]> {
    const so = config.glpi.searchOptions;
    const ids: number[] = [];
    const pageSize = 500;
    let start = 0;

    for (;;) {
      const qs = new URLSearchParams();
      qs.set('criteria[0][field]', String(so.status));
      qs.set('criteria[0][searchtype]', 'equals');
      qs.set('criteria[0][value]', String(config.glpi.statusAssigned));

      qs.set('criteria[1][link]', 'AND');
      qs.set('criteria[1][field]', String(so.openDate));
      qs.set('criteria[1][searchtype]', 'morethan');
      qs.set('criteria[1][value]', since);

      // (grupo técnico = G1 OR grupo técnico = G2 ...)
      qs.set('criteria[2][link]', 'AND');
      config.glpi.techGroupIds.forEach((gid, i) => {
        const p = `criteria[2][criteria][${i}]`;
        if (i > 0) qs.set(`${p}[link]`, 'OR');
        qs.set(`${p}[field]`, String(so.techGroup));
        qs.set(`${p}[searchtype]`, 'equals');
        qs.set(`${p}[value]`, String(gid));
      });

      qs.set('forcedisplay[0]', String(so.id));
      qs.set('sort', String(so.id));
      qs.set('order', 'ASC');
      qs.set('range', `${start}-${start + pageSize - 1}`);

      const { data } = await api<{ totalcount?: number; data?: Array<Record<string, unknown>> }>(
        `/search/Ticket?${qs.toString()}`,
      );

      const rows = data?.data ?? [];
      for (const row of rows) {
        const id = Number(row[String(so.id)]);
        if (Number.isFinite(id) && id > 0) ids.push(id);
      }

      const total = Number(data?.totalcount ?? 0);
      start += pageSize;
      if (rows.length === 0 || start >= total) break;
    }
    return [...new Set(ids)];
  },

  async getTicket(ticketId: number): Promise<GlpiTicket | null> {
    try {
      const { data } = await api<GlpiTicket>(`/Ticket/${ticketId}`);
      return data && typeof data === 'object' && 'id' in data ? data : null;
    } catch (err) {
      if (err instanceof ExternalApiError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  },

  /** Grupos técnicos (atribuídos) do chamado — usado na validação de escopo */
  async getAssignedGroupIds(ticketId: number): Promise<number[]> {
    const rows = await subItems(ticketId, 'Group_Ticket');
    return rows
      .filter((r) => Number(r.type) === GROUP_TYPE_ASSIGNED)
      .map((r) => Number(r.groups_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  },

  /** Lista grupos pelo nome (diagnóstico / descoberta do ID do Nível 1) */
  async findGroups(name: string): Promise<Array<{ id: number; name: string; completename: string; is_assign: number }>> {
    const qs = new URLSearchParams({ 'searchText[name]': name, range: '0-100' });
    const { data } = await api<Array<Record<string, unknown>> | unknown>(`/Group?${qs.toString()}`);
    if (!Array.isArray(data)) return [];
    return data.map((g) => ({
      id: Number(g.id),
      name: String(g.name ?? ''),
      completename: String(g.completename ?? g.name ?? ''),
      is_assign: Number(g.is_assign ?? 0),
    }));
  },

  async getInteractions(ticketId: number): Promise<GlpiInteractions> {
    const [followups, tasks, solutions, documents] = await Promise.all([
      subItems(ticketId, 'ITILFollowup'),
      subItems(ticketId, 'TicketTask'),
      subItems(ticketId, 'ITILSolution'),
      subItems(ticketId, 'Document_Item'),
    ]);
    return { followups, tasks, solutions, documents };
  },

  async addPrivateFollowup(ticketId: number, content: string): Promise<void> {
    await api('/ITILFollowup', {
      method: 'POST',
      body: JSON.stringify({
        input: { itemtype: 'Ticket', items_id: ticketId, content, is_private: 1 },
      }),
    });
  },

  /** Envia para a LIXEIRA (force_purge=false). Nunca faz exclusão definitiva. */
  async moveToTrash(ticketId: number): Promise<void> {
    const { data } = await api<Array<Record<string, unknown>>>(`/Ticket/${ticketId}?force_purge=false`, {
      method: 'DELETE',
    });
    const ok = Array.isArray(data) && data.some((r) => r[String(ticketId)] === true);
    if (!ok) throw new ExternalApiError('GLPI', `Falha ao enviar ticket ${ticketId} à lixeira`, undefined, data);
  },

  ticketUrl(ticketId: number): string | null {
    return config.glpi.webUrl ? `${config.glpi.webUrl}/front/ticket.form.php?id=${ticketId}` : null;
  },
};
