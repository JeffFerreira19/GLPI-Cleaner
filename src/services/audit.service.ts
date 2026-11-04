import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env';
import type { Decision } from '../types';

export type AuditAction = 'EVALUATED' | 'TRASHED' | 'SKIPPED' | 'DRY_RUN' | 'FAILED';

export interface AuditRecord {
  timestamp: string;
  runId: string;
  action: AuditAction;
  ticketId: number;
  zabbixEventId: string | null;
  decision: Decision['result'];
  reason: string;
  dryRun: boolean;
  details?: unknown;
}

function fileFor(date: Date): string {
  return path.join(config.logDir, `audit-${date.toISOString().slice(0, 10)}.jsonl`);
}

export const auditService = {
  write(record: Omit<AuditRecord, 'timestamp'>): void {
    fs.mkdirSync(config.logDir, { recursive: true });
    const full: AuditRecord = { timestamp: new Date().toISOString(), ...record };
    fs.appendFileSync(fileFor(new Date()), JSON.stringify(full) + '\n', 'utf8');
  },

  fromDecision(runId: string, action: AuditAction, d: Decision, details?: unknown): void {
    this.write({
      runId,
      action,
      ticketId: d.ticketId,
      zabbixEventId: d.zabbixEventId,
      decision: d.result,
      reason: d.primaryReason,
      dryRun: config.dryRun,
      details: details ?? { findings: d.findings, snapshot: d.snapshot },
    });
  },

  read(limit = 200, filters: { action?: string; ticketId?: number } = {}): AuditRecord[] {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const records: AuditRecord[] = [];

    for (const file of [fileFor(yesterday), fileFor(today)]) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as AuditRecord);
        } catch {
          /* linha corrompida */
        }
      }
    }

    return records
      .filter((r) => !filters.action || r.action === filters.action)
      .filter((r) => !filters.ticketId || r.ticketId === filters.ticketId)
      .slice(-limit)
      .reverse();
  },
};
