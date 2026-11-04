import { config } from '../config/env';
import { ExternalApiError, requestJson } from '../utils/http';
import type { ZabbixEvent, ZabbixProblem } from '../types';

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  result?: T;
  error?: { code: number; message: string; data: string };
  id: number;
}

let rpcId = 1;

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json-rpc' };
  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params, id: rpcId++ };

  if (config.zabbix.authMode === 'header') {
    headers.Authorization = `Bearer ${config.zabbix.token}`;
  } else {
    body.auth = config.zabbix.token;
  }

  const { data } = await requestJson<JsonRpcResponse<T>>('ZABBIX', config.zabbix.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (data?.error) {
    throw new ExternalApiError('ZABBIX', `${method}: ${data.error.message} ${data.error.data ?? ''}`.trim());
  }
  if (data?.result === undefined) {
    throw new ExternalApiError('ZABBIX', `${method}: resposta sem "result"`);
  }
  return data.result;
}

export const zabbixClient = {
  async apiVersion(): Promise<string> {
    const { data } = await requestJson<JsonRpcResponse<string>>('ZABBIX', config.zabbix.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-rpc' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'apiinfo.version', params: {}, id: rpcId++ }),
    });
    return data.result ?? 'desconhecida';
  },

  async getProblemEvents(eventIds: string[]): Promise<ZabbixEvent[]> {
    if (eventIds.length === 0) return [];
    return call<ZabbixEvent[]>('event.get', {
      eventids: eventIds,
      output: [
        'eventid', 'source', 'object', 'objectid', 'clock', 'value',
        'acknowledged', 'name', 'severity', 'r_eventid', 'suppressed',
      ],
      selectAcknowledges: 'extend',
      selectTags: 'extend',
      selectHosts: ['hostid', 'host', 'name'],
    });
  },

  /** Eventos de problema cujo nome contém `name`, iniciados entre timeFrom e timeTill (unix) */
  async findProblemEventsByName(name: string, timeFrom: number, timeTill: number): Promise<Array<{ eventid: string; name: string; clock: string }>> {
    return call('event.get', {
      source: 0,
      object: 0,
      value: 1,
      time_from: timeFrom,
      time_till: timeTill,
      search: { name },
      output: ['eventid', 'name', 'clock'],
      sortfield: ['clock'],
      sortorder: 'ASC',
      limit: 50,
    });
  },

  async getRecoveryClocks(recoveryEventIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const ids = recoveryEventIds.filter((id) => id && id !== '0');
    if (ids.length === 0) return map;
    const events = await call<Array<{ eventid: string; clock: string }>>('event.get', {
      eventids: ids,
      output: ['eventid', 'clock'],
    });
    for (const e of events) map.set(e.eventid, Number(e.clock));
    return map;
  },

  async getActiveProblemsByTriggers(triggerIds: string[]): Promise<ZabbixProblem[]> {
    if (triggerIds.length === 0) return [];
    return call<ZabbixProblem[]>('problem.get', {
      objectids: [...new Set(triggerIds)],
      source: 0,
      object: 0,
      recent: false,
      output: ['eventid', 'objectid', 'clock', 'r_eventid'],
    });
  },
};
