import fs from 'node:fs';
import path from 'node:path';

// Carrega .env nativamente (Node >= 20.12), sem dependências externas
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return v.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Variável ${name} deve ser numérica`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'sim'].includes(raw.trim().toLowerCase());
}

function idList(name: string): number[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

function requiredIdList(name: string): number[] {
  const list = idList(name);
  if (list.length === 0) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return list;
}

function regex(name: string, fallback: string): RegExp {
  const src = str(name, fallback);
  try {
    return new RegExp(src, 'i');
  } catch (err) {
    throw new Error(`Regex inválida em ${name}: ${(err as Error).message}`);
  }
}

/** "-03:00" -> -180 (minutos) */
function utcOffsetMinutes(name: string, fallback: string): number {
  const raw = str(name, fallback);
  const m = raw.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) throw new Error(`${name} deve estar no formato ±HH:MM`);
  const total = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -total : total;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export const config = {
  port: int('PORT', 3910),
  host: str('HOST', '127.0.0.1'),
  apiKey: str('API_KEY', ''),

  dryRun: bool('DRY_RUN', true),
  trashEnabled: bool('TRASH_ENABLED', false),
  autoRunEnabled: bool('AUTO_RUN_ENABLED', false),
  autoRunIntervalMinutes: int('AUTO_RUN_INTERVAL_MINUTES', 5),
  gracePeriodMinutes: int('GRACE_PERIOD_MINUTES', 15),
  maxTicketsPerExecution: int('MAX_TICKETS_PER_EXECUTION', 20),
  candidateLookbackHours: int('CANDIDATE_LOOKBACK_HOURS', 24),
  addFollowupBeforeTrash: bool('ADD_FOLLOWUP_BEFORE_TRASH', true),

  zabbix: {
    url: str('ZABBIX_API_URL'),
    token: str('ZABBIX_API_TOKEN'),
    authMode: str('ZABBIX_AUTH_MODE', 'header') as 'header' | 'body',
    automationUserIds: idList('ZABBIX_AUTOMATION_USER_IDS'),
  },

  correlation: {
    eventIdRegex: regex(
      'ZABBIX_EVENTID_REGEX',
      '(?:event(?:o)?[\\s_.-]*id|id[\\s_.-]*(?:do[\\s_.-]*)?evento)\\s*[:#=]?\\s*(\\d{3,})',
    ),
    nameTimeEnabled: bool('NAME_TIME_CORRELATION_ENABLED', true),
    titlePrefixRegex: regex('TICKET_TITLE_PREFIX_REGEX', '^\\s*\\[[^\\]]*\\]\\s*'),
    maxDelaySeconds: int('CORRELATION_MAX_DELAY_SECONDS', 900),
    clockSkewSeconds: int('CORRELATION_CLOCK_SKEW_SECONDS', 60),
    glpiUtcOffsetMinutes: utcOffsetMinutes('GLPI_UTC_OFFSET', '-03:00'),
  },

  glpi: {
    url: trimSlash(str('GLPI_API_URL')),
    appToken: str('GLPI_APP_TOKEN', ''),
    userToken: str('GLPI_USER_TOKEN'),
    webUrl: trimSlash(str('GLPI_WEB_URL', '')),
    rootEntityId: int('GLPI_ROOT_ENTITY_ID', 0),
    entityRecursive: bool('GLPI_ENTITY_RECURSIVE', true),
    statusAssigned: int('GLPI_STATUS_ASSIGNED', 2),
    techGroupIds: requiredIdList('GLPI_TECH_GROUP_IDS'),
    techGroupExclusive: bool('GLPI_TECH_GROUP_EXCLUSIVE', true),
    searchOptions: {
      id: int('GLPI_SO_ID', 2),
      status: int('GLPI_SO_STATUS', 12),
      openDate: int('GLPI_SO_OPEN_DATE', 15),
      techGroup: int('GLPI_SO_TECH_GROUP', 8),
    },
    zabbixRecipientUserIds: idList('GLPI_ZABBIX_RECIPIENT_USER_IDS'),
    zabbixRequestTypeIds: idList('GLPI_ZABBIX_REQUESTTYPE_IDS'),
    automationUserIds: idList('GLPI_AUTOMATION_USER_IDS'),
    allowedEntityIds: idList('GLPI_ALLOWED_ENTITY_IDS'),
    allowedCategoryIds: idList('GLPI_ALLOWED_CATEGORY_IDS'),
  },

  logDir: path.resolve(process.cwd(), str('LOG_DIR', 'logs')),
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 20000),
};

/** A lixeira só é acionada quando DRY_RUN=false E TRASH_ENABLED=true */
export const canWrite = (): boolean => !config.dryRun && config.trashEnabled;

export type AppConfig = typeof config;
