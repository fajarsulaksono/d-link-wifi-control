import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { AppError, EXIT, httpStatusFor, usageError } from './errors.js';
import { describe, readRules, resolveNow } from './rules.js';
import { createScheduler } from './schedule.js';

const VIEWS_DIR = path.join(ROOT, 'src', 'views');
const PUBLIC_DIR = path.join(ROOT, 'public');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * `sync` boleh membaca file dari dalam repo atau state dir saja.
 *
 * Tanpa batas ini, `POST /api/sync {file:"/etc/passwd"}` jadi primitive baca
 * file sembarang: baris yang tidak valid MAC dikembalikan apa adanya di
 * `invalidLines`.
 */
function assertSyncPathAllowed(config, file) {
  if (!file) return config.blacklistFile;

  const resolved = path.resolve(file);
  const allowed = [ROOT, config.stateDir].map((p) => path.resolve(p));
  const ok = allowed.some((base) => resolved === base || resolved.startsWith(`${base}${path.sep}`));
  if (!ok) {
      throw usageError(
        `File outside allowed area: ${resolved}. Only ${allowed.join(', ')} allowed.`,
      );
    }
  return resolved;
}

function requireToken(config) {
  return (req, res, next) => {
    if (!config.http.apiToken) return next();
    const header = req.get('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const given = bearer ?? req.get('x-api-token') ?? req.query.token;
    if (given === config.http.apiToken) return next();
    res.status(401).json({ error: 'API token missing or invalid.' });
  };
}

function readMacsFromBody(body) {
  const raw = Array.isArray(body?.macs) ? body.macs : typeof body?.mac === 'string' ? [body.mac] : [];
  if (raw.length === 0)     throw usageError('Body must have "macs": ["aa:bb:cc:dd:ee:ff"]');
  return raw;
}

export async function createServer({ config, logger, service }) {
  const scheduler = createScheduler({ config, logger, service });

  // These endpoints can block devices on network. Running on 0.0.0.0 without token
  // means anyone can block MACs.
  if (!config.http.apiToken && !['127.0.0.1', '::1', 'localhost'].includes(config.http.host)) {
    throw usageError(
      `API_TOKEN required if HOST=${config.http.host} (not loopback). ` +
        'Or run with HOST=127.0.0.1.',
    );
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', requireToken(config));

  app.get(
    '/api/config',
    asyncHandler(async (_req, res) => {
      res.json({
        apHost: config.apHost,
        blacklistFile: config.blacklistFile,
        syncCron: config.syncCron,
        auditCron: config.auditCron,
        requiresToken: Boolean(config.http.apiToken),
      });
    }),
  );

  app.get(
    '/api/rules',
    asyncHandler(async (req, res) => {
      const ruleset = await readRules(config.rulesFile);
      const view = describe(ruleset, {
        now: resolveNow(req.query.at),
        timeZone: config.rulesTz,
      });
      const active = view.rules.filter((r) => r.active);
      res.json({
        file: config.rulesFile,
        enabled: config.rulesEnabled,
        timeZone: view.timeZone,
        now: view.now,
        count: view.rules.length,
        activeCount: active.length,
        blockedMacs: [...new Set(active.flatMap((r) => r.macs))].sort(),
        rules: view.rules,
      });
    }),
  );

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      res.json({ ok: true, apHost: config.apHost, session: service.client.sessionOk });
    }),
  );

  app.get(
    '/api/blacklist',
    asyncHandler(async (_req, res) => {
      res.json(await service.list());
    }),
  );

  app.get(
    '/api/clients',
    asyncHandler(async (_req, res) => {
      res.json(await service.clients());
    }),
  );

  app.post(
    '/api/blacklist/block',
    asyncHandler(async (req, res) => {
      res.json(
        await service.block(readMacsFromBody(req.body), {
          dryRun: Boolean(req.body?.dryRun),
          permanent: Boolean(req.body?.permanent),
        }),
      );
    }),
  );

  app.post(
    '/api/blacklist/unblock',
    asyncHandler(async (req, res) => {
      res.json(await service.unblock(readMacsFromBody(req.body), { dryRun: Boolean(req.body?.dryRun) }));
    }),
  );

  app.post(
    '/api/sync',
    asyncHandler(async (req, res) => {
      const file = assertSyncPathAllowed(config, req.body?.file);
      res.json(await service.sync({ file, dryRun: Boolean(req.body?.dryRun) }));
    }),
  );

  app.post(
    '/api/login-test',
    asyncHandler(async (_req, res) => {
      res.json(await service.loginTest());
    }),
  );

  app.get(
    '/api/schedule',
    asyncHandler(async (_req, res) => {
      res.json(scheduler.status());
    }),
  );

  app.post(
    '/api/schedule/run',
    asyncHandler(async (req, res) => {
      const summary = await scheduler.runDue({
        force: Boolean(req.body?.force),
        only: Array.isArray(req.body?.task) ? req.body.task : undefined,
      });
      res.status(summary.exitCode === EXIT.OK ? 200 : 500).json(summary);
    }),
  );

  app.get(
    '/api/logs',
    asyncHandler(async (req, res) => {
      const lines = Math.min(Number(req.query.lines) || 50, 500);
      let text = '';
      try {
        text = await fsp.readFile(config.logFile, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      res.json({ file: config.logFile, lines: text.split('\n').filter(Boolean).slice(-lines) });
    }),
  );

  // Aset: CSS hasil build Tailwind + dashboard.
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
  app.use('/assets', express.static(VIEWS_DIR, { index: false }));
  app.get('/', (_req, res) => res.sendFile(path.join(VIEWS_DIR, 'index.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ada.' });
    res.status(404).send('Not found');
  });

  // Empat argumen wajib: Express mengenali error handler dari arity-nya.
  app.use((err, req, res, next) => {
    const status = httpStatusFor(err);
    const payload = { error: err?.message ?? 'Error tidak diketahui' };
    if (err instanceof AppError) payload.code = err.code;
    if (status >= 500) logger.error(`${req.method} ${req.path} -> ${status}: ${payload.error}`);
    res.status(status).json(payload);
  });

  const port = config.http.port;
  const host = config.http.host;
  let server;

  const cssFile = path.join(PUBLIC_DIR, 'tailwind.css');
  if (!fs.existsSync(cssFile)) {
    logger.warn(`public/tailwind.css belum ada — dashboard akan tampil tanpa style. Jalankan: npm run build:css`);
  }

  await new Promise((resolve, reject) => {
    server = app.listen(port, host, resolve);
    server.on('error', (err) =>
      reject(usageError(`Server gagal listen di ${host}:${port} — ${err.message}`)),
    );
    server.keepAliveTimeout = 5000;
  });

  logger.info(`HTTP API + dashboard: http://${host}:${port} (AP ${config.apHost})`);
  if (config.http.apiToken) {
    logger.info('API_TOKEN aktif — semua /api/* butuh Authorization: Bearer <token>.');
  }

  return { app, server, scheduler };
}

export { VIEWS_DIR, PUBLIC_DIR };
