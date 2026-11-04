import { config } from '../config/env';
import { findTicketReference, parseGlpiDate, unixToIso } from '../utils/text';
import {
  RESULT_PRECEDENCE,
  type CorrelationResult,
  type Decision,
  type DecisionResult,
  type DecisionSnapshot,
  type Finding,
  type GlpiInteractions,
  type GlpiTicket,
  type ReasonCode,
  type ZabbixAcknowledge,
  type ZabbixEvent,
  type ZabbixProblem,
} from '../types';
import { isAutomaticZabbixTicket } from './correlation.service';

const GLPI_STATUS_SOLVED = 5;
const GLPI_STATUS_CLOSED = 6;

export interface EvaluationContext {
  ticketId: number;
  ticket: GlpiTicket | null;
  assignedGroupIds: number[] | null;
  correlation: CorrelationResult;
  event: ZabbixEvent | null;
  recoveryClock: number | null;
  activeProblems: ZabbixProblem[];
  interactions: GlpiInteractions | null;
  ticketsForSameEvent: number;
  ticketUrl: string | null;
  now?: Date;
}

const isHumanGlpi = (userId: unknown) => !config.glpi.automationUserIds.includes(Number(userId ?? 0));
export const isHumanZabbix = (a: ZabbixAcknowledge) => !config.zabbix.automationUserIds.includes(Number(a.userid ?? 0));

/** Reconhecimento humano (reconhecimentos apenas do script de integração NÃO contam) */
export function hasHumanAcknowledge(event: ZabbixEvent): boolean {
  const acks = event.acknowledges ?? [];
  if (acks.some(isHumanZabbix)) return true;
  return event.acknowledged === '1' && acks.length === 0;
}

/** C17 — o chamado está no grupo técnico Nível 1 (e, se exclusivo, somente nele) */
export function checkTechGroup(assigned: number[]): { inScope: boolean; others: number[] } {
  const allowed = config.glpi.techGroupIds;
  const inScope = assigned.some((g) => allowed.includes(g));
  const others = assigned.filter((g) => !allowed.includes(g));
  return { inScope, others };
}

/**
 * Aplica a matriz de decisão (C01..C17 / B01..B24).
 * Precedência: ERROR > BLOCKED > MANUAL_REVIEW > WAITING > ELIGIBLE.
 */
export function evaluate(ctx: EvaluationContext): Decision {
  const now = ctx.now ?? new Date();
  const findings: Finding[] = [];
  const add = (result: Finding['result'], code: ReasonCode, rule: string, message: string) =>
    findings.push({ result, code, rule, message });

  const { ticket, event, interactions, correlation } = ctx;
  const snapshot: DecisionSnapshot = {
    correlationMethod: correlation.method,
    correlationDetail: correlation.detail,
  };

  if (!ticket) {
    add('MANUAL_REVIEW', 'GLPI_TICKET_NOT_FOUND', 'B09', 'Chamado não encontrado no GLPI');
    return finalize(ctx, findings, snapshot);
  }

  Object.assign(snapshot, {
    ticketName: ticket.name,
    ticketStatus: Number(ticket.status),
    ticketDate: ticket.date,
    ticketDateMod: ticket.date_mod,
    ticketEntityId: Number(ticket.entities_id),
    ticketCategoryId: Number(ticket.itilcategories_id),
    assignedGroupIds: ctx.assignedGroupIds ?? undefined,
  });

  // ---------------- C17 / B23-B24 — escopo: grupo técnico Nível 1 ----------------
  if (ctx.assignedGroupIds) {
    const { inScope, others } = checkTechGroup(ctx.assignedGroupIds);
    if (!inScope) {
      add('BLOCKED', 'GLPI_GROUP_NOT_ALLOWED', 'C17/B23',
        `Chamado não está no grupo técnico Nível 1 (grupos atuais: ${ctx.assignedGroupIds.join(', ') || 'nenhum'})`);
    } else if (config.glpi.techGroupExclusive && others.length > 0) {
      add('BLOCKED', 'GLPI_OTHER_GROUP_ASSIGNED', 'C17/B24',
        `Chamado também atribuído a outro(s) grupo(s) técnico(s): ${others.join(', ')}`);
    }
  }

  // ---------------- C01 / C02 — origem e correlação ----------------
  if (!isAutomaticZabbixTicket(ticket)) {
    add('BLOCKED', 'GLPI_TICKET_NOT_AUTOMATIC', 'C01', 'Chamado não foi criado pelo usuário da integração Zabbix');
  }
  if (correlation.ambiguous) {
    add('MANUAL_REVIEW', 'AMBIGUOUS_CORRELATION', 'C02', `Correlação ambígua: ${correlation.detail}`);
  } else if (!correlation.eventId) {
    add('MANUAL_REVIEW', 'MISSING_ZABBIX_EVENT_ID', 'C02/B08', `Evento Zabbix não identificado: ${correlation.detail}`);
  }
  if (ctx.ticketsForSameEvent > 1) {
    add('MANUAL_REVIEW', 'MULTIPLE_GLPI_TICKETS', 'B10', `${ctx.ticketsForSameEvent} chamados vinculados ao mesmo evento`);
  }

  // ---------------- GLPI: status / entidade / categoria ----------------
  const status = Number(ticket.status);
  if (Number(ticket.is_deleted) === 1 || status === GLPI_STATUS_SOLVED || status === GLPI_STATUS_CLOSED) {
    add('BLOCKED', 'GLPI_ALREADY_PROCESSED', 'C12/B16', 'Chamado já solucionado, fechado ou na lixeira');
  } else if (status !== config.glpi.statusAssigned) {
    add('BLOCKED', 'GLPI_STATUS_CHANGED', 'C11/B11', `Status atual (${status}) difere de "Em Atendimento (atribuído)"`);
  }

  const { allowedEntityIds, allowedCategoryIds } = config.glpi;
  if (allowedEntityIds.length > 0 && !allowedEntityIds.includes(Number(ticket.entities_id))) {
    add('BLOCKED', 'ENTITY_NOT_ALLOWED', 'B17', `Entidade ${ticket.entities_id} fora da lista autorizada`);
  }
  if (allowedCategoryIds.length > 0 && !allowedCategoryIds.includes(Number(ticket.itilcategories_id))) {
    add('BLOCKED', 'CATEGORY_NOT_ALLOWED', 'B18', `Categoria ${ticket.itilcategories_id} fora da lista automatizada`);
  }

  // ---------------- GLPI: interações humanas ----------------
  if (interactions) {
    const followups = interactions.followups.filter((f) => isHumanGlpi(f.users_id));
    const tasks = interactions.tasks.filter((t) => isHumanGlpi(t.users_id));
    const solutions = interactions.solutions;
    const documents = interactions.documents;

    Object.assign(snapshot, {
      glpiFollowups: followups.length,
      glpiTasks: tasks.length,
      glpiSolutions: solutions.length,
      glpiDocuments: documents.length,
    });

    if (followups.length > 0) add('BLOCKED', 'GLPI_FOLLOWUP_FOUND', 'C13/B12', `${followups.length} acompanhamento(s) humano(s)`);
    if (tasks.length > 0) add('BLOCKED', 'GLPI_TASK_FOUND', 'C14/B13', `${tasks.length} tarefa(s) humana(s)`);
    if (solutions.length > 0) add('BLOCKED', 'GLPI_SOLUTION_FOUND', 'C15/B14', 'Solução registrada no chamado');
    if (documents.length > 0) add('BLOCKED', 'GLPI_DOCUMENT_FOUND', 'B15', `${documents.length} documento(s) anexado(s)`);
  }

  // ---------------- Zabbix ----------------
  if (correlation.eventId && !event) {
    add('MANUAL_REVIEW', 'ZABBIX_EVENT_NOT_FOUND', 'C02', `Evento ${correlation.eventId} não encontrado no Zabbix`);
  }

  if (event) {
    const acks = event.acknowledges ?? [];
    const humanAcks = acks.filter(isHumanZabbix);
    const recoveredMinutesAgo =
      ctx.recoveryClock !== null ? Math.floor((now.getTime() / 1000 - ctx.recoveryClock) / 60) : null;

    Object.assign(snapshot, {
      host: event.hosts?.[0]?.name ?? event.hosts?.[0]?.host,
      trigger: event.name,
      problemClock: unixToIso(event.clock),
      recoveryClock: unixToIso(ctx.recoveryClock),
      recoveredMinutesAgo,
      zabbixAcknowledged: hasHumanAcknowledge(event),
      zabbixUpdates: humanAcks.length,
      zabbixAutomationUpdates: acks.length - humanAcks.length,
    });

    if (event.source !== '0' || event.object !== '0' || event.value !== '1') {
      add('BLOCKED', 'NOT_TRIGGER_EVENT', 'C03', 'Evento não é problema de trigger');
    }

    if (!event.r_eventid || event.r_eventid === '0') {
      add('BLOCKED', 'ZABBIX_EVENT_ACTIVE', 'C04/B01', 'Problema ainda ativo no Zabbix');
    } else if (ctx.recoveryClock === null) {
      add('MANUAL_REVIEW', 'RECOVERY_NOT_CONFIRMED', 'C05', 'Evento de recuperação sem horário confirmado');
    } else if (recoveredMinutesAgo !== null && recoveredMinutesAgo < config.gracePeriodMinutes) {
      add('WAITING', 'RECOVERY_GRACE_PERIOD', 'C07',
        `Recuperado há ${recoveredMinutesAgo} min (mínimo ${config.gracePeriodMinutes} min)`);
    }

    const recurred = ctx.activeProblems.some(
      (p) => p.objectid === event.objectid && BigInt(p.eventid) > BigInt(event.eventid),
    );
    if (recurred) {
      add('BLOCKED', 'ZABBIX_PROBLEM_RECURRED', 'C06/B02', 'A trigger voltou a ficar em problema após a recuperação');
    }

    if (hasHumanAcknowledge(event)) {
      add('BLOCKED', 'ZABBIX_ACKNOWLEDGED', 'C08/B03', 'Evento reconhecido por operador no Zabbix');
    }

    if (humanAcks.length > 0) {
      add('BLOCKED', 'ZABBIX_UPDATE_FOUND', 'C09/B04', `${humanAcks.length} atualização(ões) de operador no evento`);
      add('BLOCKED', 'HUMAN_INTERACTION_ZABBIX', 'B07', 'Atualização realizada por usuário não automatizado');

      const withMessage = humanAcks.filter((a) => (a.message ?? '').trim().length > 0);
      if (withMessage.length > 0) {
        add('BLOCKED', 'ZABBIX_COMMENT_FOUND', 'C10/B05', `${withMessage.length} observação(ões) no evento`);
      }
      const ref = withMessage.map((a) => findTicketReference(a.message)).find(Boolean);
      if (ref) {
        add('BLOCKED', 'GLPI_ID_FOUND_IN_ACK', 'B06', `Reconhecimento referencia o chamado ${ref}`);
      }
    }
  }

  return finalize(ctx, findings, snapshot);
}

function finalize(ctx: EvaluationContext, findings: Finding[], snapshot: DecisionSnapshot): Decision {
  let result: DecisionResult = 'ELIGIBLE';
  let primaryReason: ReasonCode = 'RECOVERED_WITHOUT_HUMAN_INTERACTION';

  for (const level of RESULT_PRECEDENCE) {
    const hit = findings.find((f) => f.result === level);
    if (hit) {
      result = hit.result;
      primaryReason = hit.code;
      break;
    }
  }

  return {
    ticketId: ctx.ticketId,
    ticketUrl: ctx.ticketUrl,
    zabbixEventId: ctx.correlation.eventId,
    result,
    primaryReason,
    findings,
    snapshot,
    evaluatedAt: (ctx.now ?? new Date()).toISOString(),
  };
}

export function errorDecision(ticketId: number, ticketUrl: string | null, eventId: string | null, message: string): Decision {
  return {
    ticketId,
    ticketUrl,
    zabbixEventId: eventId,
    result: 'ERROR',
    primaryReason: 'EXTERNAL_API_ERROR',
    findings: [{ result: 'ERROR', code: 'EXTERNAL_API_ERROR', rule: 'B19', message }],
    snapshot: {},
    evaluatedAt: new Date().toISOString(),
  };
}

/** Detecta alteração concorrente (B20) */
export function snapshotChanged(before: DecisionSnapshot, after: DecisionSnapshot): boolean {
  const a = parseGlpiDate(before.ticketDateMod)?.getTime();
  const b = parseGlpiDate(after.ticketDateMod)?.getTime();
  const groups = (g?: number[]) => [...(g ?? [])].sort().join(',');
  return (
    a !== b ||
    before.ticketStatus !== after.ticketStatus ||
    groups(before.assignedGroupIds) !== groups(after.assignedGroupIds) ||
    before.zabbixUpdates !== after.zabbixUpdates ||
    before.zabbixAcknowledged !== after.zabbixAcknowledged
  );
}
