import { config } from '../config/env';

/** Remove HTML e decodifica entidades comuns (o GLPI armazena texto com HTML codificado) */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input);
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Normaliza nomes para comparação exata */
export function normalizeName(input: string | null | undefined): string {
  return htmlToText(input).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Converte data GLPI "YYYY-MM-DD HH:mm:ss" em Date, aplicando GLPI_UTC_OFFSET */
export function parseGlpiDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Date(utcMs - config.correlation.glpiUtcOffsetMinutes * 60_000);
}

/** Formata Date no fuso do GLPI para uso nas buscas */
export function formatGlpiDate(d: Date): string {
  const local = new Date(d.getTime() + config.correlation.glpiUtcOffsetMinutes * 60_000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

export function unixToIso(clock: string | number | null | undefined): string | null {
  const n = Number(clock);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
}

/** Detecta referência a chamado na mensagem de reconhecimento */
export function findTicketReference(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.match(/(?:glpi|chamado|ticket)?\s*[#:nº°]*\s*(\d{4,})/i);
  return m ? m[1] : null;
}
