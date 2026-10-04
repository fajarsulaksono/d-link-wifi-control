import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageError } from './errors.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read `.env` into `process.env`.
 *
 * Password doesn't need to be written in crontab and doesn't need manual export
 * from shell. Variables already in environment take precedence — that's
 * the default behavior of `process.loadEnvFile` — so tests and experiments can
 * just set env without touching the file.
 *
 * Call once at the beginning of entrypoint, before `loadConfig()`.
 */
export function loadEnvFile(file = process.env.WIFI_CTL_ENV_FILE || path.join(ROOT, '.env')) {
  // `process.loadEnvFile` tersedia sejak Node 20.12; lihat `engines` di package.json.
  if (typeof process.loadEnvFile !== 'function') return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch (err) {
    // Missing .env is not an error — all values can come from environment.
    if (err.code === 'ENOENT') return false;
    throw usageError(`Cannot read .env: ${file} (${err.message})`);
  }
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw usageError(`Value must be a number >= 0: ${value}`);
  }
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Empty values are treated as "not set" — important so `path.resolve('')` doesn't silently become cwd. */
const isSet = (value) => value !== undefined && value !== null && value !== '';

export function loadConfig({ env = process.env } = {}) {
  const pick = (key, fallback) => (isSet(env[key]) ? env[key] : fallback);

  const stateDir = path.resolve(
    pick('STATE_DIR', path.join(os.homedir(), '.local', 'state', 'wifictl')),
  );

  const apHost = String(pick('AP_HOST', '192.168.10.1'));

  return {
    apHost,
    apiBase: `http://${apHost}/cgi-bin/luci/admin/routerweb`,

    // User dibekuan di front-end router (index.js: var login_user = 'CMCCAdmin').
    adminUser: String(pick('ADMIN_USER', 'CMCCAdmin')),
    adminPass: String(pick('ADMIN_PASS', '')),

    httpTimeoutMs: num(pick('HTTP_TIMEOUT_MS', 15000)),

    stateDir,
    logFile: path.resolve(pick('LOG_FILE', path.join(stateDir, 'wifictl.log'))),
    logMaxBytes: num(pick('LOG_MAX_BYTES', 1048576)),
    logMaxFiles: num(pick('LOG_MAX_FILES', 2)),

    // Used by `sync` when called without file argument.
    blacklistFile: path.resolve(
      pick('BLACKLIST_FILE', path.join(ROOT, 'blacklist.txt')),
    ),

    // Time-based blacklist rules (src/rules.js).
    rulesFile: path.resolve(pick('RULES_FILE', path.join(ROOT, 'rules.json'))),
    // Empty = local machine time. Set if repo moved to server with different timezone.
    rulesTz: String(pick('RULES_TZ', '')),
    rulesEnabled: bool(pick('RULES_ENABLED'), true),

    // Schedules for `schedule:run`. Format = 5-field cron.
    syncCron: String(pick('SYNC_CRON', '*/30 * * * *')),
    auditCron: String(pick('AUDIT_CRON', '5 * * * *')),
    rulesCron: String(pick('RULES_CRON', '* * * * *')),
    auditEnabled: bool(pick('AUDIT_ENABLED'), true),
    syncEnabled: bool(pick('SYNC_ENABLED'), true),

    // Lock: `schedule:run` called every minute, sync can be longer than that,
    // so stale timeout is loose to avoid lock being stolen mid-execution.
    lockStaleMs: num(pick('LOCK_STALE_MS', 120000)),

    http: {
      host: String(pick('HOST', '127.0.0.1')),
      port: num(pick('PORT', 8080)),
      // Required if server bound outside loopback: these endpoints can block devices.
      apiToken: String(pick('API_TOKEN', '')),
    },
  };
}
