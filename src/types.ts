// ---------------- Decisão ----------------
export type DecisionResult = 'ELIGIBLE' | 'BLOCKED' | 'MANUAL_REVIEW' | 'WAITING' | 'ERROR';

/** Ordem de precedência: o primeiro encontrado define o resultado final */
export const RESULT_PRECEDENCE: DecisionResult[] = ['ERROR', 'BLOCKED', 'MANUAL_REVIEW', 'WAITING', 'ELIGIBLE'];

/** Como o evento Zabbix foi vinculado ao chamado */
export type CorrelationMethod = 'EVENT_ID' | 'NAME_TIME';

export type ReasonCode =
  | 'ZABBIX_EVENT_ACTIVE'
  | 'ZABBIX_PROBLEM_RECURRED'
  | 'ZABBIX_ACKNOWLEDGED'
  | 'ZABBIX_UPDATE_FOUND'
  | 'ZABBIX_COMMENT_FOUND'
  | 'GLPI_ID_FOUND_IN_ACK'
  | 'HUMAN_INTERACTION_ZABBIX'
  | 'MISSING_ZABBIX_EVENT_ID'
  | 'AMBIGUOUS_CORRELATION'
  | 'ZABBIX_EVENT_NOT_FOUND'
  | 'GLPI_TICKET_NOT_FOUND'
  | 'MULTIPLE_GLPI_TICKETS'
  | 'GLPI_STATUS_CHANGED'
  | 'GLPI_GROUP_NOT_ALLOWED'
  | 'GLPI_OTHER_GROUP_ASSIGNED'
  | 'GLPI_FOLLOWUP_FOUND'
  | 'GLPI_TASK_FOUND'
  | 'GLPI_SOLUTION_FOUND'
  | 'GLPI_DOCUMENT_FOUND'
  | 'GLPI_ALREADY_PROCESSED'
  | 'GLPI_TICKET_NOT_AUTOMATIC'
  | 'ENTITY_NOT_ALLOWED'
  | 'CATEGORY_NOT_ALLOWED'
  | 'EXTERNAL_API_ERROR'
  | 'CONCURRENT_UPDATE_DETECTED'
  | 'EXECUTION_LIMIT_REACHED'
  | 'RECOVERY_NOT_CONFIRMED'
  | 'RECOVERY_GRACE_PERIOD'
  | 'NOT_TRIGGER_EVENT'
  | 'RECOVERED_WITHOUT_HUMAN_INTERACTION';

export interface Finding {
  code: ReasonCode;
  result: Exclude<DecisionResult, 'ELIGIBLE'>;
  rule: string;
  message: string;
}

export interface Decision {
  ticketId: number;
  ticketUrl: string | null;
  zabbixEventId: string | null;
  result: DecisionResult;
  primaryReason: ReasonCode;
  findings: Finding[];
  snapshot: DecisionSnapshot;
  evaluatedAt: string;
}

export interface DecisionSnapshot {
  ticketName?: string;
  ticketStatus?: number;
  ticketDate?: string;
  ticketDateMod?: string;
  ticketEntityId?: number;
  ticketCategoryId?: number;
  assignedGroupIds?: number[];
  correlationMethod?: CorrelationMethod | null;
  correlationDetail?: string;
  host?: string;
  trigger?: string;
  problemClock?: string | null;
  recoveryClock?: string | null;
  recoveredMinutesAgo?: number | null;
  zabbixAcknowledged?: boolean;
  zabbixUpdates?: number;
  zabbixAutomationUpdates?: number;
  glpiFollowups?: number;
  glpiTasks?: number;
  glpiSolutions?: number;
  glpiDocuments?: number;
}

/** Resultado da correlação de um chamado com o Zabbix */
export interface CorrelationResult {
  eventId: string | null;
  method: CorrelationMethod | null;
  ambiguous: boolean;
  detail: string;
}

// ---------------- Zabbix ----------------
export interface ZabbixAcknowledge {
  acknowledgeid: string;
  userid: string;
  eventid: string;
  clock: string;
  message: string;
  action: string;
}

export interface ZabbixEvent {
  eventid: string;
  source: string;
  object: string;
  objectid: string;
  clock: string;
  value: string;
  acknowledged: string;
  name: string;
  severity: string;
  r_eventid: string;
  suppressed?: string;
  acknowledges?: ZabbixAcknowledge[];
  hosts?: Array<{ hostid: string; host: string; name: string }>;
  tags?: Array<{ tag: string; value: string }>;
}

export interface ZabbixProblem {
  eventid: string;
  objectid: string;
  clock: string;
  r_eventid: string;
}

// ---------------- GLPI ----------------
export interface GlpiTicket {
  id: number;
  name: string;
  content: string;
  status: number;
  date: string;
  date_mod: string;
  entities_id: number;
  itilcategories_id: number;
  users_id_recipient: number;
  requesttypes_id: number;
  is_deleted: number;
  solvedate: string | null;
  closedate: string | null;
}

export interface GlpiSubItem {
  id: number;
  users_id?: number;
  [key: string]: unknown;
}

export interface GlpiInteractions {
  followups: GlpiSubItem[];
  tasks: GlpiSubItem[];
  solutions: GlpiSubItem[];
  documents: GlpiSubItem[];
}
