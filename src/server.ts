import { config } from './config/env';
import { createServer } from './app';
import { glpiClient } from './clients/glpi.client';
import { startCleanupJob, stopCleanupJob } from './jobs/cleanup.job';
import { logger } from './utils/logger';

const server = createServer();

server.listen(config.port, config.host, () => {
  logger.info(`zabbix-glpi-cleaner ouvindo em http://${config.host}:${config.port}`, {
    dryRun: config.dryRun,
    trashEnabled: config.trashEnabled,
    autoRun: config.autoRunEnabled,
    techGroupIds: config.glpi.techGroupIds,
    techGroupExclusive: config.glpi.techGroupExclusive,
  });
  startCleanupJob();
});

async function shutdown(signal: string) {
  logger.info(`Recebido ${signal}, encerrando...`);
  stopCleanupJob();
  server.close();
  await glpiClient.killSession();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { reason: String(reason) }));
