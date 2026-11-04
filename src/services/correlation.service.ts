import { config } from '../config/env';
import { zabbixClient } from '../clients/zabbix.client';
import { htmlToText, normalizeName, parseGlpiDate } from '../utils/text';
import type { CorrelationResult, GlpiTicket } from '../types';

const NONE = (detail: string): CorrelationResult => ({ eventId: null, method: null, ambiguous: false, detail });

/** Remove o prefixo (ex.: "[Incidente] ") — aplicado ao título do chamado E ao nome do evento */
export function eventNameFromTitle(title: string): string {
  return htmlToText(title).replace(config.correlation.titlePrefixRegex, '').trim();
}

/** Estratégia 1 — "Event ID: 123" no título/descrição do chamado */
export function correlateByEventId(ticket: Pick<GlpiTicket, 'name' | 'content'>): CorrelationResult | null {
  const text = `${ticket.name ?? ''}\n${htmlToText(ticket.content)}`;
  const id = text.match(config.correlation.eventIdRegex)?.[1];
  return id ? { eventId: id, method: 'EVENT_ID', ambiguous: false, detail: 'Event ID encontrado no chamado' } : null;
}

/**
 * Estratégia 2 — nome do evento + horário.
 * Exige UM único evento com nome idêntico (sem prefixo) iniciado na janela antes da abertura.
 */
export async function correlateByNameAndTime(ticket: GlpiTicket): Promise<CorrelationResult> {
  const name = eventNameFromTitle(ticket.name);
  if (!name) return NONE('Título vazio após remover o prefixo');

  const opened = parseGlpiDate(ticket.date);
  if (!opened) return NONE('Data de abertura do chamado inválida');

  const { maxDelaySeconds, clockSkewSeconds } = config.correlation;
  const openedUnix = Math.floor(opened.getTime() / 1000);

  const found = await zabbixClient.findProblemEventsByName(name, openedUnix - maxDelaySeconds, openedUnix + clockSkewSeconds);
  const target = normalizeName(name);
  const exact = found.filter((e) => normalizeName(eventNameFromTitle(e.name)) === target);

  if (exact.length === 0) {
    return NONE(`Nenhum evento "${name}" iniciado até ${maxDelaySeconds}s antes da abertura`);
  }
  if (exact.length > 1) {
    return {
      eventId: null,
      method: 'NAME_TIME',
      ambiguous: true,
      detail: `${exact.length} eventos "${name}" na janela (${exact.map((e) => e.eventid).join(', ')})`,
    };
  }
  const delay = openedUnix - Number(exact[0].clock);
  return {
    eventId: exact[0].eventid,
    method: 'NAME_TIME',
    ambiguous: false,
    detail: `Nome idêntico; chamado aberto ${delay}s após o início do evento`,
  };
}

export async function correlate(ticket: GlpiTicket): Promise<CorrelationResult> {
  const byId = correlateByEventId(ticket);
  if (byId) return byId;
  if (!config.correlation.nameTimeEnabled) return NONE('Event ID ausente e correlação por nome/horário desabilitada');
  return correlateByNameAndTime(ticket);
}

/** C01 — chamado criado pela integração Zabbix (usuário/tipo de solicitação) */
export function isAutomaticZabbixTicket(ticket: GlpiTicket): boolean {
  const { zabbixRecipientUserIds, zabbixRequestTypeIds } = config.glpi;
  if (zabbixRecipientUserIds.length > 0 && !zabbixRecipientUserIds.includes(Number(ticket.users_id_recipient))) {
    return false;
  }
  if (zabbixRequestTypeIds.length > 0 && !zabbixRequestTypeIds.includes(Number(ticket.requesttypes_id))) {
    return false;
  }
  return true;
}

export function countTicketsByEvent(pairs: Array<{ eventId: string | null }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const { eventId } of pairs) {
    if (!eventId) continue;
    map.set(eventId, (map.get(eventId) ?? 0) + 1);
  }
  return map;
}
