'use strict';

// URLs relativas: funciona em http://servidor:3910/ e atrás do Nginx em /cleaner/
const API = {
  health: 'health',
  connections: 'api/connections',
  candidates: 'api/candidates',
  candidate: (id) => `api/candidates/${id}`,
  trashOne: (id) => `api/candidates/${id}/trash`,
  preview: 'api/cleanup/preview',
  execute: 'api/cleanup/execute',
  audit: 'api/audit',
};

const REASONS = {
  RECOVERED_WITHOUT_HUMAN_INTERACTION: 'Recuperado sem intervenção humana',
  ZABBIX_EVENT_ACTIVE: 'Problema ainda ativo',
  ZABBIX_PROBLEM_RECURRED: 'Problema voltou a ocorrer',
  ZABBIX_ACKNOWLEDGED: 'Reconhecido por operador',
  ZABBIX_UPDATE_FOUND: 'Atualização no evento',
  ZABBIX_COMMENT_FOUND: 'Observação no Zabbix',
  GLPI_ID_FOUND_IN_ACK: 'Nº do chamado no reconhecimento',
  HUMAN_INTERACTION_ZABBIX: 'Interação humana no Zabbix',
  MISSING_ZABBIX_EVENT_ID: 'Evento Zabbix não identificado',
  AMBIGUOUS_CORRELATION: 'Mais de um evento compatível',
  ZABBIX_EVENT_NOT_FOUND: 'Evento não encontrado no Zabbix',
  GLPI_TICKET_NOT_FOUND: 'Chamado não encontrado',
  MULTIPLE_GLPI_TICKETS: 'Vários chamados para o evento',
  GLPI_STATUS_CHANGED: 'Status alterado no GLPI',
  GLPI_GROUP_NOT_ALLOWED: 'Fora do grupo técnico Nível 1',
  GLPI_OTHER_GROUP_ASSIGNED: 'Também atribuído a outro grupo',
  GLPI_FOLLOWUP_FOUND: 'Acompanhamento no GLPI',
  GLPI_TASK_FOUND: 'Tarefa no GLPI',
  GLPI_SOLUTION_FOUND: 'Solução no GLPI',
  GLPI_DOCUMENT_FOUND: 'Documento anexado',
  GLPI_ALREADY_PROCESSED: 'Já solucionado/fechado/lixeira',
  GLPI_TICKET_NOT_AUTOMATIC: 'Chamado não automático',
  ENTITY_NOT_ALLOWED: 'Entidade não autorizada',
  CATEGORY_NOT_ALLOWED: 'Categoria não autorizada',
  EXTERNAL_API_ERROR: 'Erro de API externa',
  CONCURRENT_UPDATE_DETECTED: 'Alterado durante a validação',
  EXECUTION_LIMIT_REACHED: 'Limite por execução atingido',
  RECOVERY_NOT_CONFIRMED: 'Recuperação não confirmada',
  RECOVERY_GRACE_PERIOD: 'Dentro da janela de segurança',
  NOT_TRIGGER_EVENT: 'Evento não é de trigger',
};

const RESULTS = {
  ELIGIBLE: 'Elegível', BLOCKED: 'Bloqueado', WAITING: 'Aguardando',
  MANUAL_REVIEW: 'Revisão manual', ERROR: 'Erro',
  TRASHED: 'Lixeira', DRY_RUN: 'Simulado', SKIPPED: 'Ignorado', FAILED: 'Falha', EVALUATED: 'Avaliado',
};

const CORRELATION = { EVENT_ID: 'Event ID', NAME_TIME: 'Nome + horário', NONE: 'Sem vínculo' };

const state = { health: null, data: null, sort: { key: 'recoveredMinutesAgo', dir: 'desc' }, current: null, timer: null };

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}min` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const reason = (c) => REASONS[c] || c;
const badge = (r) => `<span class="badge b-${esc(r)}">${esc(RESULTS[r] || r)}</span>`;
const corrBadge = (m) => `<span class="badge b-${esc(m || 'NONE')}">${esc(CORRELATION[m || 'NONE'])}</span>`;
const yesNo = (v) => (v === undefined ? '<span class="muted">—</span>' : v ? '<span class="yes">Sim</span>' : '<span class="no">Não</span>');

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 6000);
}

async function http(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- chave da API ----------
function askKey(message) {
  return new Promise((resolve) => {
    const saved = sessionStorage.getItem('cleanerApiKey');
    const dlg = $('#modal-key');
    $('#key-message').textContent = message;
    $('#input-key').value = saved || '';
    $('#remember-key').checked = !!saved;
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue !== 'ok') return resolve(null);
      const key = $('#input-key').value.trim();
      if ($('#remember-key').checked) sessionStorage.setItem('cleanerApiKey', key);
      else sessionStorage.removeItem('cleanerApiKey');
      resolve(key || null);
    });
  });
}

async function writeRequest(url, message) {
  const key = await askKey(message);
  if (!key) return null;
  try {
    return await http(url, { method: 'POST', headers: { 'X-API-Key': key } });
  } catch (err) {
    if (err.status === 401) sessionStorage.removeItem('cleanerApiKey');
    throw err;
  }
}

// ---------- status ----------
async function loadHealth() {
  try {
    const h = await http(API.health);
    state.health = h;
    const grp = $('#pill-group');
    grp.textContent = `Grupo técnico: ${(h.techGroupIds || []).join(', ')}${h.techGroupExclusive ? ' (exclusivo)' : ''}`;
    grp.className = 'pill info';
    const mode = $('#pill-mode');
    mode.textContent = h.writeMode ? 'MODO EXECUÇÃO' : 'MODO SIMULAÇÃO';
    mode.className = `pill ${h.writeMode ? 'bad' : 'warn'}`;
    const auto = $('#pill-auto');
    auto.textContent = h.autoRun ? `Automático: ${h.autoRunIntervalMinutes} min` : 'Automático: desligado';
    auto.className = `pill ${h.autoRun ? 'ok' : ''}`;
    $('#btn-execute').disabled = !h.writeMode;
    $('#btn-execute').title = h.writeMode ? '' : 'Habilite DRY_RUN=false e TRASH_ENABLED=true no .env';
  } catch {
    $('#pill-mode').textContent = 'API indisponível';
    $('#pill-mode').className = 'pill bad';
  }
}

async function loadConnections() {
  try {
    const c = await http(API.connections);
    const set = (el, name, info) => {
      el.textContent = `${name} ${info?.ok ? '●' : '✕'}`;
      el.className = `pill ${info?.ok ? 'ok' : 'bad'}`;
      el.title = info?.ok ? (info.apiVersion ? `API ${info.apiVersion}` : 'Conectado') : info?.error || 'Falha';
    };
    set($('#pill-zbx'), 'Zabbix', c.zabbix);
    set($('#pill-glpi'), 'GLPI', c.glpi);
  } catch { /* ignorado */ }
}

// ---------- candidatos ----------
async function loadCandidates() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Avaliando...';
  $('#meta').textContent = 'Consultando GLPI e Zabbix...';
  try {
    state.data = await http(API.candidates);
    renderSummary();
    fillReasonFilter();
    renderCandidates();
    const d = state.data;
    const c = d.summary.byCorrelation || {};
    $('#meta').textContent =
      `Atualizado em ${fmtDate(d.generatedAt)} · ${d.ticketsScanned} chamado(s) "Em Atendimento (atribuído)" no grupo técnico ` +
      `${(d.techGroupIds || []).join(', ')} desde ${d.since} · ${d.ignoredNonZabbix} fora da integração ignorado(s) · ` +
      `vínculo: ${c.EVENT_ID || 0} por Event ID, ${c.NAME_TIME || 0} por nome + horário, ${c.NONE || 0} sem vínculo · ` +
      `janela de segurança: ${state.health?.gracePeriodMinutes ?? '?'} min`;
  } catch (err) {
    $('#meta').textContent = `Erro ao carregar: ${err.message}`;
    toast(`Erro ao carregar candidatos: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Atualizar';
  }
}

function renderSummary() {
  const s = state.data.summary;
  $('#cnt-total').textContent = s.total;
  for (const r of ['ELIGIBLE', 'BLOCKED', 'WAITING', 'MANUAL_REVIEW', 'ERROR']) {
    $(`#cnt-${r}`).textContent = s.byResult[r] || 0;
  }
}

function fillReasonFilter() {
  const sel = $('#filter-reason');
  const current = sel.value;
  const entries = Object.entries(state.data.summary.byReason).sort((a, b) => b[1] - a[1]);
  sel.innerHTML = '<option value="">Todos os motivos</option>' +
    entries.map(([c, n]) => `<option value="${esc(c)}">${esc(reason(c))} (${n})</option>`).join('');
  sel.value = entries.some(([c]) => c === current) ? current : '';
}

function sortValue(d, key) {
  if (key === 'ticketId' || key === 'result') return d[key];
  return d.snapshot?.[key] ?? '';
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const res = $('#filter-result').value;
  const rsn = $('#filter-reason').value;
  const { key, dir } = state.sort;

  return (state.data?.decisions || [])
    .filter((d) => !res || d.result === res)
    .filter((d) => !rsn || d.primaryReason === rsn)
    .filter((d) => {
      if (!q) return true;
      const s = d.snapshot || {};
      return [d.ticketId, d.zabbixEventId, s.host, s.trigger, s.ticketName].join(' ').toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const va = sortValue(a, key), vb = sortValue(b, key);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return dir === 'asc' ? cmp : -cmp;
    });
}

function renderCandidates() {
  const rows = filtered();
  const tbody = $('#tbl-candidates tbody');
  $('#empty-candidates').hidden = rows.length > 0;

  tbody.innerHTML = rows.map((d) => {
    const s = d.snapshot || {};
    const inter = s.glpiFollowups === undefined
      ? '<span class="muted">—</span>'
      : `${s.glpiFollowups + s.glpiTasks + s.glpiSolutions + s.glpiDocuments}`;
    const link = d.ticketUrl
      ? `<a href="${esc(d.ticketUrl)}" target="_blank" rel="noopener">#${d.ticketId}</a>`
      : `#${d.ticketId}`;
    return `<tr>
      <td>${link}</td>
      <td>${esc(s.host || '—')}</td>
      <td class="trigger" title="${esc(s.trigger || s.ticketName || '')}">${esc(s.trigger || s.ticketName || '—')}</td>
      <td>${fmtDate(s.problemClock)}</td>
      <td>${fmtMin(s.recoveredMinutesAgo)}</td>
      <td>${yesNo(s.zabbixAcknowledged)}</td>
      <td>${inter}</td>
      <td title="${esc(s.correlationDetail || '')}">${corrBadge(s.correlationMethod)}</td>
      <td>${badge(d.result)}</td>
      <td title="${esc(d.primaryReason)}">${esc(reason(d.primaryReason))}</td>
      <td><button class="btn btn-secondary btn-sm" data-detail="${d.ticketId}">Detalhes</button></td>
    </tr>`;
  }).join('');

  $$('#tbl-candidates th[data-sort]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sort.key) th.classList.add(`sorted-${state.sort.dir}`);
  });
  $$('.card').forEach((c) => c.classList.toggle('selected', c.dataset.filter === $('#filter-result').value));
}

// ---------- detalhe ----------
function renderDetail(d) {
  state.current = d;
  const s = d.snapshot || {};
  $('#detail-title').innerHTML = `Chamado #${d.ticketId} ${badge(d.result)}`;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;

  $('#detail-body').innerHTML = `
    <dl class="kv">
      ${row('Chamado', d.ticketUrl ? `<a href="${esc(d.ticketUrl)}" target="_blank" rel="noopener">Abrir no GLPI ↗</a>` : '—')}
      ${row('Título', esc(s.ticketName || '—'))}
      ${row('Aberto em (GLPI)', esc(s.ticketDate || '—'))}
      ${row('Grupo(s) técnico(s)', esc((s.assignedGroupIds || []).join(', ') || '—'))}
      ${row('Vínculo com o Zabbix', `${corrBadge(s.correlationMethod)} <span class="muted">${esc(s.correlationDetail || '')}</span>`)}
      ${row('Evento Zabbix', esc(d.zabbixEventId || '—'))}
      ${row('Host', esc(s.host || '—'))}
      ${row('Evento', esc(s.trigger || '—'))}
      ${row('Início do problema', fmtDate(s.problemClock))}
      ${row('Recuperação', `${fmtDate(s.recoveryClock)} (${fmtMin(s.recoveredMinutesAgo)})`)}
      ${row('Reconhecido por operador', yesNo(s.zabbixAcknowledged))}
      ${row('Atualizações de operador', s.zabbixUpdates ?? '—')}
      ${row('Atualizações da automação', s.zabbixAutomationUpdates ?? '—')}
      ${row('Acompanhamentos GLPI', s.glpiFollowups ?? '—')}
      ${row('Tarefas GLPI', s.glpiTasks ?? '—')}
      ${row('Soluções GLPI', s.glpiSolutions ?? '—')}
      ${row('Documentos GLPI', s.glpiDocuments ?? '—')}
      ${row('Entidade / Categoria', `${s.ticketEntityId ?? '—'} / ${s.ticketCategoryId ?? '—'}`)}
      ${row('Avaliado em', fmtDate(d.evaluatedAt))}
    </dl>
    <div class="section-title">Regras acionadas</div>
    ${d.findings.length === 0
      ? `<ul class="findings"><li>${badge('ELIGIBLE')} Todas as regras atendidas — ${esc(reason(d.primaryReason))}</li></ul>`
      : `<ul class="findings">${d.findings.map((f) =>
          `<li>${badge(f.result)} <strong>${esc(reason(f.code))}</strong> — ${esc(f.message)} <code>[${esc(f.rule)} · ${esc(f.code)}]</code></li>`
        ).join('')}</ul>`}
  `;

  const can = d.result === 'ELIGIBLE' && state.health?.writeMode;
  $('#btn-trash-one').disabled = !can;
  $('#btn-trash-one').title = can ? '' : d.result !== 'ELIGIBLE' ? 'Chamado não elegível' : 'Modo execução desabilitado';
}

function openDetail(id) {
  const d = state.data?.decisions.find((x) => x.ticketId === id);
  if (!d) return;
  renderDetail(d);
  $('#modal-detail').showModal();
}

async function reevaluate() {
  const id = state.current?.ticketId;
  if (!id) return;
  const btn = $('#btn-reevaluate');
  btn.disabled = true;
  try {
    const d = await http(API.candidate(id));
    const list = state.data.decisions;
    const i = list.findIndex((x) => x.ticketId === id);
    if (i >= 0) list[i] = d;
    renderDetail(d);
    renderCandidates();
    toast(`Chamado #${id}: ${RESULTS[d.result]} — ${reason(d.primaryReason)}`);
  } catch (err) {
    toast(`Erro ao reavaliar: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function trashOne() {
  const id = state.current?.ticketId;
  if (!id) return;
  try {
    const r = await writeRequest(API.trashOne(id), `Enviar o chamado #${id} à lixeira do GLPI? O chamado será revalidado antes da ação.`);
    if (!r) return;
    if (r.trashed.includes(id)) toast(`Chamado #${id} enviado à lixeira.`, 'ok');
    else if (r.aborted.length) toast(`Ação cancelada: ${reason(r.aborted[0].reason)}`, 'bad');
    else if (r.failed.length) toast(`Falha: ${r.failed[0].error}`, 'bad');
    else toast('Chamado não estava mais elegível.', 'bad');
    $('#modal-detail').close();
    loadCandidates();
  } catch (err) {
    toast(`Erro: ${err.message}`, 'bad');
  }
}

// ---------- execução em lote ----------
function runSummary(r) {
  return `Modo: ${r.mode === 'EXECUTE' ? 'Execução' : 'Simulação'}\n` +
    `Elegíveis: ${r.eligible}\n` +
    `Enviados à lixeira: ${r.trashed.length}\n` +
    `Cancelados na revalidação: ${r.aborted.length}\n` +
    `Falhas: ${r.failed.length}` +
    (r.limitReached ? `\nAguardando próximo ciclo (limite): ${r.limitReached}` : '');
}

async function preview() {
  const btn = $('#btn-preview');
  btn.disabled = true;
  try {
    const r = await http(API.preview, { method: 'POST' });
    toast(runSummary(r), 'ok');
    loadAudit();
  } catch (err) {
    toast(`Erro na simulação: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function executeAll() {
  const n = state.data?.summary.byResult.ELIGIBLE || 0;
  if (n === 0) return toast('Não há chamados elegíveis no momento.');
  const max = state.health?.maxTicketsPerExecution;
  try {
    const r = await writeRequest(API.execute,
      `Enviar ${n} chamado(s) elegível(is) do Nível 1 à lixeira? Limite por execução: ${max}. Cada chamado é revalidado antes da ação.`);
    if (!r) return;
    $('#btn-execute').disabled = true;
    toast(runSummary(r), r.failed.length ? 'bad' : 'ok');
    await loadCandidates();
    loadAudit();
  } catch (err) {
    toast(`Erro na execução: ${err.message}`, 'bad');
  } finally {
    $('#btn-execute').disabled = !state.health?.writeMode;
  }
}

// ---------- auditoria ----------
async function loadAudit() {
  const qs = new URLSearchParams({ limit: $('#audit-limit').value });
  if ($('#audit-action').value) qs.set('action', $('#audit-action').value);
  if ($('#audit-ticket').value) qs.set('ticketId', $('#audit-ticket').value);
  try {
    const list = await http(`${API.audit}?${qs}`);
    $('#empty-audit').hidden = list.length > 0;
    $('#tbl-audit tbody').innerHTML = list.map((a) => `<tr>
      <td>${fmtDate(a.timestamp)}</td>
      <td>${badge(a.action)}</td>
      <td>#${a.ticketId}</td>
      <td>${esc(a.zabbixEventId || '—')}</td>
      <td>${badge(a.decision)}</td>
      <td title="${esc(a.reason)}">${esc(reason(a.reason))}</td>
      <td>${a.dryRun ? 'Simulação' : 'Execução'}</td>
      <td class="muted" title="${esc(a.runId)}">${esc(String(a.runId).slice(0, 8))}</td>
    </tr>`).join('');
  } catch (err) {
    toast(`Erro na auditoria: ${err.message}`, 'bad');
  }
}

// ---------- eventos ----------
function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'audit') loadAudit();
  }));

  $$('.card').forEach((c) => c.addEventListener('click', () => {
    $('#filter-result').value = c.dataset.filter;
    renderCandidates();
  }));

  $$('#tbl-candidates th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' };
    renderCandidates();
  }));

  $('#search').addEventListener('input', renderCandidates);
  $('#filter-result').addEventListener('change', renderCandidates);
  $('#filter-reason').addEventListener('change', renderCandidates);
  $('#tbl-candidates tbody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-detail]');
    if (b) openDetail(Number(b.dataset.detail));
  });

  $('#btn-refresh').addEventListener('click', loadCandidates);
  $('#btn-preview').addEventListener('click', preview);
  $('#btn-execute').addEventListener('click', executeAll);
  $('#btn-reevaluate').addEventListener('click', reevaluate);
  $('#btn-trash-one').addEventListener('click', trashOne);
  $('#btn-audit').addEventListener('click', loadAudit);
  $('#audit-action').addEventListener('change', loadAudit);
  $('[data-close]').addEventListener('click', () => $('#modal-detail').close());

  $('#auto-refresh').addEventListener('change', (e) => {
    clearInterval(state.timer);
    if (e.target.checked) state.timer = setInterval(() => { loadHealth(); loadCandidates(); }, 60_000);
  });
}

(async function init() {
  bind();
  await loadHealth();
  loadConnections();
  loadCandidates();
})();
