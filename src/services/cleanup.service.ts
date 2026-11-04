import { randomUUID } from 'node:crypto';
import { canWrite, config } from '../config/env';
import { glpiClient } from '../clients/glpi.client';
import { zabbixClient } from '../clients/zabbix.client';
import { logger } from '../utils/logger';
import { formatGlpiDate } from '../utils/text';
import type { CorrelationResult, Decision, GlpiInteractions, GlpiTicket, ZabbixEvent, ZabbixProblem } from '../types';
import { auditService } from './audit.service';
import { correlate, countTicketsByEvent, isAutomaticZabbixTicket } from './correlation.service';
import { checkTechGroup, errorDecision, evaluate, hasHumanAcknowledge, snapshotChanged } from './eligibility.service';

const CHUNK = 200;
const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

interface LoadedTicket {
  ticketId: number;
  ticket: GlpiTicket | null;
  groups: number[] | null;
  correlation: CorrelationResult;
  error?: string;
}

const NOT_EVALUATED: CorrelationResult = { eventId: null, method: null, ambiguous: false, detail: 'Não avaliado' };

/** Grupo técnico permitido (Nível 1) e, se exclusivo, sem outros grupos */
function groupInScope(groups: number[] | null): boolean {
  if (!groups) return false;
  const { inScope, others } = checkTechGroup(groups);
  return inScope && (!config.glpi.techGroupExclusive || others.length === 0);
}

function zabbixPreCheckPasses(event: ZabbixEvent | undefined): boolean {
  if (!event) return false;
  if (!event.r_eventid || event.r_eventid === '0') return false;
  return !hasHumanAcknowledge(event);
}

/**
 * @param includeAll true = avalia qualquer chamado informado (diagnóstico individual);
 *                   false = ignora chamados que não são da integração Zabbix
 */
async function evaluateTickets(ticketIds: number[], includeAll: boolean) {
  const now = new Date();

  // 1. GLPI — chamado + grupos técnicos
  const tickets = await mapLimit(ticketIds, CONCURRENCY, async (ticketId) => {
    try {
      const [ticket, groups] = await Promise.all([
        glpiClient.getTicket(ticketId),
        glpiClient.getAssignedGroupIds(ticketId),
      ]);
      return { ticketId, ticket, groups };
    } catch (err) {
      return { ticketId, ticket: null, groups: null, error: (err as Error).message };
    }
  });

  const ignored = includeAll ? [] : tickets.filter((t) => !t.error && t.ticket && !isAutomaticZabbixTicket(t.ticket));
  const relevant = includeAll ? tickets : tickets.filter((t) => t.error || !t.ticket || isAutomaticZabbixTicket(t.ticket));

  // 2. Correlação — só para chamados no escopo do Nível 1 (economiza consultas ao Zabbix)
  const loaded: LoadedTicket[] = await mapLimit(relevant, CONCURRENCY, async (t) => {
    if (t.error || !t.ticket) return { ...t, correlation: NOT_EVALUATED };
    if (!groupInScope(t.groups)) return { ...t, correlation: { ...NOT_EVALUATED, detail: 'Fora do grupo técnico Nível 1' } };
    try {
      return { ...t, correlation: await correlate(t.ticket) };
    } catch (err) {
      return { ...t, correlation: NOT_EVALUATED, error: (err as Error).message };
    }
  });

  const dupCount = countTicketsByEvent(loaded.map((l) => ({ eventId: l.correlation.eventId })));

  // 3. Zabbix — eventos, recuperações e reincidências
  const eventIds = [...new Set(loaded.map((l) => l.correlation.eventId).filter((e): e is string => !!e))];
  const events = new Map<string, ZabbixEvent>();
  let recoveryClocks = new Map<string, number>();
  let activeProblems: ZabbixProblem[] = [];
  let zabbixError: string | null = null;

  try {
    for (const part of chunks(eventIds, CHUNK)) {
      for (const e of await zabbixClient.getProblemEvents(part)) events.set(e.eventid, e);
    }
    const recoveryIds = [...events.values()].map((e) => e.r_eventid).filter((r) => r && r !== '0');
    for (const part of chunks(recoveryIds, CHUNK)) {
      const m = await zabbixClient.getRecoveryClocks(part);
      recoveryClocks = new Map([...recoveryClocks, ...m]);
    }
    const triggerIds = [...events.values()].map((e) => e.objectid);
    for (const part of chunks(triggerIds, CHUNK)) {
      activeProblems = activeProblems.concat(await zabbixClient.getActiveProblemsByTriggers(part));
    }
  } catch (err) {
    zabbixError = (err as Error).message;
    logger.error('Falha ao consultar Zabbix', { error: zabbixError });
  }

  // 4. GLPI — interações + avaliação
  const decisions: Decision[] = await mapLimit(loaded, CONCURRENCY, async (l) => {
    const url = glpiClient.ticketUrl(l.ticketId);
    const eventId = l.correlation.eventId;
    if (l.error) return errorDecision(l.ticketId, url, eventId, l.error);
    if (zabbixError && eventId) return errorDecision(l.ticketId, url, eventId, zabbixError);

    const event = eventId ? events.get(eventId) : undefined;
    let interactions: GlpiInteractions | null = null;

    if (l.ticket && groupInScope(l.groups) && zabbixPreCheckPasses(event)) {
      try {
        interactions = await glpiClient.getInteractions(l.ticketId);
      } catch (err) {
        return errorDecision(l.ticketId, url, eventId, (err as Error).message);
      }
    }

    return evaluate({
      ticketId: l.ticketId,
      ticket: l.ticket,
      assignedGroupIds: l.groups,
      correlation: l.correlation,
      event: event ?? null,
      recoveryClock: event ? recoveryClocks.get(event.r_eventid) ?? null : null,
      activeProblems: event ? activeProblems.filter((p) => p.objectid === event.objectid) : [],
      interactions,
      ticketsForSameEvent: eventId ? dupCount.get(eventId) ?? 1 : 1,
      ticketUrl: url,
      now,
    });
  });

  return { decisions, ignoredNonZabbix: ignored.length };
}

function summarize(decisions: Decision[]) {
  const byResult: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byCorrelation: Record<string, number> = {};
  for (const d of decisions) {
    byResult[d.result] = (byResult[d.result] ?? 0) + 1;
    byReason[d.primaryReason] = (byReason[d.primaryReason] ?? 0) + 1;
    const m = d.snapshot.correlationMethod ?? 'NONE';
    byCorrelation[m] = (byCorrelation[m] ?? 0) + 1;
  }
  return { total: decisions.length, byResult, byReason, byCorrelation };
}

let running = false;

export const cleanupService = {
  isRunning: () => running,

  async listCandidates(filter?: string) {
    const since = formatGlpiDate(new Date(Date.now() - config.candidateLookbackHours * 3_600_000));
    const ids = await glpiClient.searchAssignedTicketIds(since);
    const { decisions, ignoredNonZabbix } = await evaluateTickets(ids, false);
    const list = filter ? decisions.filter((d) => d.result === filter.toUpperCase()) : decisions;
    return {
      generatedAt: new Date().toISOString(),
      since,
      techGroupIds: config.glpi.techGroupIds,
      ticketsScanned: ids.length,
      ignoredNonZabbix,
      summary: summarize(decisions),
      decisions: list,
    };
  },

  async evaluateOne(ticketId: number): Promise<Decision> {
    const { decisions } = await evaluateTickets([ticketId], true);
    return decisions[0];
  },

  async run(options: { execute: boolean; ticketIds?: number[]; trigger: string }) {
    if (running) throw new Error('Já existe uma execução em andamento');
    running = true;
    const runId = randomUUID();
    const writeMode = options.execute && canWrite();
    const started = Date.now();

    logger.info('Execução iniciada', { runId, trigger: options.trigger, writeMode, dryRun: config.dryRun });

    try {
      const base = options.ticketIds?.length
        ? { decisions: (await evaluateTickets(options.ticketIds, true)).decisions, ignoredNonZabbix: 0 }
        : await this.listCandidates();
      const decisions = base.decisions;

      const eligible = decisions
        .filter((d) => d.result === 'ELIGIBLE')
        .sort((a, b) => (a.snapshot.recoveryClock ?? '').localeCompare(b.snapshot.recoveryClock ?? ''));

      for (const d of decisions.filter((x) => x.result !== 'ELIGIBLE')) {
        auditService.fromDecision(runId, 'SKIPPED', d);
      }

      const trashed: number[] = [];
      const failed: Array<{ ticketId: number; error: string }> = [];
      const aborted: Array<{ ticketId: number; reason: string }> = [];
      let limitReached = 0;

      for (const d of eligible) {
        if (!writeMode) {
          auditService.fromDecision(runId, 'DRY_RUN', d);
          continue;
        }
        if (trashed.length >= config.maxTicketsPerExecution) {
          limitReached++;
          auditService.fromDecision(runId, 'SKIPPED', { ...d, result: 'WAITING', primaryReason: 'EXECUTION_LIMIT_REACHED' });
          continue;
        }

        // C16 / B20 — validação final (inclui grupo técnico) imediatamente antes da ação
        const fresh = await this.evaluateOne(d.ticketId);
        if (fresh.result !== 'ELIGIBLE') {
          aborted.push({ ticketId: d.ticketId, reason: fresh.primaryReason });
          auditService.fromDecision(runId, 'SKIPPED', fresh);
          continue;
        }
        if (snapshotChanged(d.snapshot, fresh.snapshot) || fresh.zabbixEventId !== d.zabbixEventId) {
          aborted.push({ ticketId: d.ticketId, reason: 'CONCURRENT_UPDATE_DETECTED' });
          auditService.fromDecision(runId, 'SKIPPED', { ...fresh, result: 'BLOCKED', primaryReason: 'CONCURRENT_UPDATE_DETECTED' });
          continue;
        }

        try {
          if (config.addFollowupBeforeTrash) {
            await glpiClient.addPrivateFollowup(
              d.ticketId,
              `[Automação NOC] Evento Zabbix ${fresh.zabbixEventId} recuperado em ${fresh.snapshot.recoveryClock} ` +
                `sem reconhecimento ou observação de operador. Correlação: ${fresh.snapshot.correlationMethod} ` +
                `(${fresh.snapshot.correlationDetail}). Chamado do Nível 1 enviado à lixeira automaticamente (execução ${runId}).`,
            );
          }
          await glpiClient.moveToTrash(d.ticketId);
          trashed.push(d.ticketId);
          auditService.fromDecision(runId, 'TRASHED', fresh);
          logger.info('Chamado enviado à lixeira', { ticketId: d.ticketId, eventId: fresh.zabbixEventId });
        } catch (err) {
          const error = (err as Error).message;
          failed.push({ ticketId: d.ticketId, error });
          auditService.fromDecision(runId, 'FAILED', fresh, { error });
          logger.error('Falha ao enviar à lixeira', { ticketId: d.ticketId, error });
        }
      }

      const result = {
        runId,
        trigger: options.trigger,
        mode: writeMode ? 'EXECUTE' : 'DRY_RUN',
        durationMs: Date.now() - started,
        ignoredNonZabbix: base.ignoredNonZabbix,
        summary: summarize(decisions),
        eligible: eligible.length,
        trashed,
        aborted,
        failed,
        limitReached,
      };
      logger.info('Execução finalizada', { ...result, trashed: trashed.length });
      return result;
    } finally {
      running = false;
    }
  },
};
