import { timingSafeEqual } from 'node:crypto';
import { canWrite, config } from '../config/env';
import { glpiClient } from '../clients/glpi.client';
import { zabbixClient } from '../clients/zabbix.client';
import { auditService } from '../services/audit.service';
import { cleanupService } from '../services/cleanup.service';
import { correlate, eventNameFromTitle, isAutomaticZabbixTicket } from '../services/correlation.service';
import { checkTechGroup } from '../services/eligibility.service';
import { formatGlpiDate, unixToIso } from '../utils/text';
import { HttpError, Router, type Ctx } from './router';

function requireApiKey(ctx: Ctx): void {
  const provided = String(ctx.req.headers['x-api-key'] ?? '');
  const expected = config.apiKey;
  if (!expected) throw new HttpError(503, 'API_KEY não configurada — endpoints de escrita desabilitados');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'X-API-Key inválida');
}

function ticketIdParam(ctx: Ctx): number {
  const id = Number.parseInt(ctx.params.ticketId, 10);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'ticketId inválido');
  return id;
}

export function buildRouter(): Router {
  const r = new Router();

  r.get('/health', () => ({
    status: 'ok',
    running: cleanupService.isRunning(),
    dryRun: config.dryRun,
    trashEnabled: config.trashEnabled,
    writeMode: canWrite(),
    autoRun: config.autoRunEnabled,
    autoRunIntervalMinutes: config.autoRunIntervalMinutes,
    gracePeriodMinutes: config.gracePeriodMinutes,
    maxTicketsPerExecution: config.maxTicketsPerExecution,
    candidateLookbackHours: config.candidateLookbackHours,
    nameTimeCorrelation: config.correlation.nameTimeEnabled,
    techGroupIds: config.glpi.techGroupIds,
    techGroupExclusive: config.glpi.techGroupExclusive,
  }));

  r.get('/api/connections', async () => {
    const result: Record<string, unknown> = {};
    try {
      const apiVersion = await zabbixClient.apiVersion();
      await zabbixClient.getProblemEvents(['1']);
      result.zabbix = { ok: true, apiVersion };
    } catch (err) {
      result.zabbix = { ok: false, error: (err as Error).message };
    }
    try {
      const ids = await glpiClient.searchAssignedTicketIds(formatGlpiDate(new Date(Date.now() - 3_600_000)));
      result.glpi = { ok: true, assignedLastHourInTechGroup: ids.length };
    } catch (err) {
      result.glpi = { ok: false, error: (err as Error).message };
    }
    return result;
  });

  r.get('/api/candidates', (ctx) => cleanupService.listCandidates(ctx.query.get('result') ?? undefined));
  r.get('/api/candidates/:ticketId', (ctx) => cleanupService.evaluateOne(ticketIdParam(ctx)));

  /** Descobre o ID de grupos pelo nome. Ex.: /api/diagnostics/groups?name=Nível */
  r.get('/api/diagnostics/groups', async (ctx) => {
    const name = ctx.query.get('name') ?? '';
    if (!name.trim()) throw new HttpError(400, 'Informe ?name=');
    return glpiClient.findGroups(name.trim());
  });

  /** Vínculo do chamado + grupos técnicos + quem reconheceu o evento */
  r.get('/api/diagnostics/ticket/:ticketId', async (ctx) => {
    const id = ticketIdParam(ctx);
    const [ticket, groups] = await Promise.all([glpiClient.getTicket(id), glpiClient.getAssignedGroupIds(id)]);
    if (!ticket) throw new HttpError(404, `Chamado ${id} não encontrado`);

    const correlation = await correlate(ticket);
    const [event] = correlation.eventId ? await zabbixClient.getProblemEvents([correlation.eventId]) : [];
    const grp = checkTechGroup(groups);

    return {
      ticket: {
        id: ticket.id,
        name: ticket.name,
        date: ticket.date,
        status: ticket.status,
        users_id_recipient: ticket.users_id_recipient,
        requesttypes_id: ticket.requesttypes_id,
        isAutomaticZabbixTicket: isAutomaticZabbixTicket(ticket),
        expectedEventName: eventNameFromTitle(ticket.name),
      },
      techGroup: {
        assignedGroupIds: groups,
        configuredTechGroupIds: config.glpi.techGroupIds,
        inScope: grp.inScope,
        otherGroups: grp.others,
        exclusive: config.glpi.techGroupExclusive,
      },
      correlation,
      event: event
        ? {
            eventid: event.eventid,
            name: event.name,
            host: event.hosts?.[0]?.name,
            clock: unixToIso(event.clock),
            recovered: event.r_eventid !== '0',
            acknowledged: event.acknowledged === '1',
            acknowledges: (event.acknowledges ?? []).map((a) => ({
              userid: a.userid,
              clock: unixToIso(a.clock),
              action: a.action,
              message: a.message,
              treatedAsAutomation: config.zabbix.automationUserIds.includes(Number(a.userid)),
            })),
            tags: event.tags,
          }
        : null,
    };
  });

  r.post('/api/cleanup/preview', () => cleanupService.run({ execute: false, trigger: 'manual-preview' }));

  r.post('/api/cleanup/execute', (ctx) => {
    requireApiKey(ctx);
    if (!canWrite()) throw new HttpError(409, 'Modo escrita desabilitado (DRY_RUN=true ou TRASH_ENABLED=false)');
    return cleanupService.run({ execute: true, trigger: 'manual-execute' });
  });

  r.post('/api/candidates/:ticketId/trash', (ctx) => {
    requireApiKey(ctx);
    if (!canWrite()) throw new HttpError(409, 'Modo escrita desabilitado (DRY_RUN=true ou TRASH_ENABLED=false)');
    return cleanupService.run({ execute: true, ticketIds: [ticketIdParam(ctx)], trigger: 'manual-single' });
  });

  r.get('/api/audit', (ctx) => {
    const limit = Math.min(Number.parseInt(ctx.query.get('limit') ?? '200', 10) || 200, 2000);
    const ticketId = ctx.query.get('ticketId');
    return auditService.read(limit, {
      action: ctx.query.get('action') ?? undefined,
      ticketId: ticketId ? Number(ticketId) : undefined,
    });
  });

  return r;
}
