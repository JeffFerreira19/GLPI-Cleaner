import { config } from '../config/env';
import { cleanupService } from '../services/cleanup.service';
import { logger } from '../utils/logger';

let timer: NodeJS.Timeout | null = null;

export function startCleanupJob(): void {
  if (!config.autoRunEnabled) {
    logger.info('Execução automática desabilitada (AUTO_RUN_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(1, config.autoRunIntervalMinutes) * 60_000;

  const tick = async () => {
    if (cleanupService.isRunning()) {
      logger.warn('Execução anterior ainda em andamento — ciclo ignorado');
      return;
    }
    try {
      await cleanupService.run({ execute: true, trigger: 'scheduler' });
    } catch (err) {
      logger.error('Falha na execução agendada', { error: (err as Error).message });
    }
  };

  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 10_000);
  logger.info(`Execução automática a cada ${config.autoRunIntervalMinutes} min`);
}

export function stopCleanupJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
