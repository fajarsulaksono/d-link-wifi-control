import { Logger } from './logger.js';
import { Scheduler } from './scheduler.js';
import { Service } from './service.js';

/**
 * Scheduled task definitions — similar to `routes/console.php` in Laravel.
 *
 * Add tasks here; `schedule:run` and `/api/schedule/*` endpoints follow automatically.
 *
 * Task `run` must return serializable data (used by /api/schedule/run)
 * and throw AppError on failure — Scheduler determines exit code.
 */
export function buildTasks({ config, logger, service = new Service({ config, logger }) }) {
  const summary = (result) => ({
    want: result.want,
    ditambah: result.blocked.length,
    dilepas: result.unblocked.length,
    tidakBerubah: result.unchanged,
    dariRule: result.fromRules,
  });

  return [
    {
      name: 'blacklist-sync',
      description: 'Reconcile AP blacklist with file contents (desired state)',
      cron: config.syncCron,
      enabled: config.syncEnabled,
      run: async () => summary(await service.sync({ file: config.blacklistFile })),
    },
    {
      name: 'rules-apply',
      description: 'Block/unblock according to time rules (runs every minute)',
      cron: config.rulesCron,
      enabled: config.rulesEnabled,
      run: async () => summary(await service.sync({ file: config.blacklistFile })),
    },
    {
      name: 'blacklist-audit',
      description: 'Log AP blacklist contents (detect changes outside file)',
      cron: config.auditCron,
      enabled: config.auditEnabled,
      run: async () => {
        const { macs } = await service.list();
        logger.info(`AP blacklist audit (${macs.length} MAC): ${macs.join(', ') || '<empty>'}`);
        return { count: macs.length, macs };
      },
    },
  ];
}

export function createScheduler({ config, logger, service, now } = {}) {
  const log = logger ?? new Logger({ logFile: config.logFile, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });

  return new Scheduler({
    tasks: buildTasks({ config, logger: log, service }),
    stateFile: `${config.stateDir}/schedule-state.json`,
    logger: log,
    now,
  });
}
