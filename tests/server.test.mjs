import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { Service } from '../src/service.js';
import { createServer } from '../src/server.js';
import { PASSWORD, ROOT, startMock, tmpDir } from './helpers.mjs';

let nextPort = 24000 + (process.pid % 2000) * 10;

async function withServer({ mock, stateDir, extraEnv = {}, run }) {
  const port = (nextPort += 1);
  // Jangan spread process.env di sini: env developer bisa saja berisi
  // BLACKLIST_FILE yang menunjuk file asli. Semua path file diarahkan ke
  // stateDir supaya test tidak pernah menulis ke repo.
  const env = {
    AP_HOST: `127.0.0.1:${mock.port}`,
    ADMIN_PASS: PASSWORD,
    STATE_DIR: stateDir,
    LOG_FILE: path.join(stateDir, 'wifictl.log'),
    HTTP_TIMEOUT_MS: '5000',
    HOST: '127.0.0.1',
    PORT: String(port),
    BLACKLIST_FILE: path.join(stateDir, 'blacklist.txt'),
    RULES_FILE: path.join(stateDir, 'rules.json'),
    ...extraEnv,
  };

  const config = loadConfig({ env });
  const logger = new Logger({ logFile: config.logFile, quiet: true });
  const service = new Service({ config, logger });
  const { server } = await createServer({ config, logger, service });

  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opts = {}) => {
    const res = await fetch(`${base}${p}`, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  };

  try {
    await run({ call, base, config });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /api/rules', () => {
  const rulesJson = (rules) => JSON.stringify({ rules });

  it('menampilkan rule, status aktif, dan MAC yang diblokir', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    fs.writeFileSync(
      rulesFile,
      rulesJson([
        { id: 'selalu', name: 'Selalu', macs: ['de:ad:be:ef:00:01'], windows: [{ start: '00:00', end: '24:00' }] },
        { id: 'malam', name: 'Malam', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '03:00', end: '04:00' }] },
        { id: 'mati', name: 'Mati', enabled: false, macs: ['bb:bb:bb:bb:bb:bb'], windows: [{ start: '00:00', end: '24:00' }] },
      ]),
    );

    const mock = await startMock({ seed: [] });
    try {
      await withServer({ mock, stateDir: state, extraEnv: { RULES_FILE: rulesFile }, run: async ({ call }) => {
        const res = await call('/api/rules');
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 3);
        assert.equal(res.body.activeCount, 1);
        assert.deepEqual(res.body.blockedMacs, ['de:ad:be:ef:00:01']);
        assert.equal(res.body.file, rulesFile);

        const byId = Object.fromEntries(res.body.rules.map((r) => [r.id, r]));
        assert.equal(byId.selalu.active, true);
        assert.equal(byId.malam.active, false);
        assert.equal(byId.mati.active, false);
      } });
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('?at= meninjau rule pada jam lain', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    fs.writeFileSync(
      rulesFile,
      rulesJson([{ id: 'siang', name: 'Siang', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '12:00', end: '13:00' }] }]),
    );

    const mock = await startMock({ seed: [] });
    try {
      await withServer({ mock, stateDir: state, extraEnv: { RULES_FILE: rulesFile }, run: async ({ call }) => {
        const now = new Date();
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 30);
        const res = await call(`/api/rules?at=${d.toISOString()}`);
        assert.equal(res.body.activeCount, 1);
        assert.deepEqual(res.body.blockedMacs, ['aa:aa:aa:aa:aa:aa']);
      } });
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('file rules.json rusak -> 400 dengan pesan dari parser', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    fs.writeFileSync(rulesFile, '{rusak');

    const mock = await startMock({ seed: [] });
    try {
      await withServer({ mock, stateDir: state, extraEnv: { RULES_FILE: rulesFile }, run: async ({ call }) => {
        const res = await call('/api/rules');
        assert.equal(res.status, 400);
        assert.match(res.body.error, /JSON tidak valid/);
      } });
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('HTTP API', () => {
  let mock;
  let state;

  before(async () => {
    state = tmpDir();
    mock = await startMock({
      seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }, { mac: '11:22:33:44:55:66' }],
    });
    fs.writeFileSync(path.join(state, 'want.txt'), 'aa:bb:cc:dd:ee:ff\n00:11:22:33:44:55\n');
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('dashboard dan CSS Tailwind tersaji', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const page = await call('/');
      assert.equal(page.status, 200);
      assert.match(page.body.raw, /wifictl/);
      assert.match(page.body.raw, /tailwind\.css/);

      const css = await call('/tailwind.css');
      assert.equal(css.status, 200, 'jalankan `npm run build:css` dulu');
    } });
  });

  it('GET /api/blacklist mengembalikan MAC dari AP', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/blacklist');
      assert.equal(r.status, 200);
      assert.deepEqual([...r.body.macs].sort(), ['11:22:33:44:55:66', 'aa:bb:cc:dd:ee:ff']);
      assert.equal(r.body.count, 2);
    } });
  });

  it('GET /api/clients mengembalikan device', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/clients');
      assert.equal(r.status, 200);
      assert.equal(r.body.count, 2);
      assert.equal(r.body.clients[0].hostname, 'LAPTOP-1');
    } });
  });

  it('POST block/unblock mengubah blacklist', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const block = await call('/api/blacklist/block', {
        method: 'POST',
        body: { macs: ['AA-00-00-00-00-09'] },
      });
      assert.equal(block.status, 200);
      assert.deepEqual(block.body.macs, ['aa:00:00:00:00:09']);

      const list = await call('/api/blacklist');
      assert.ok(list.body.macs.includes('aa:00:00:00:00:09'));

      const unblock = await call('/api/blacklist/unblock', {
        method: 'POST',
        body: { macs: ['aa:00:00:00:00:09'] },
      });
      assert.equal(unblock.status, 200);

      const after = await call('/api/blacklist');
      assert.ok(!after.body.macs.includes('aa:00:00:00:00:09'));
    } });
  });

  it('POST block permanent menulis ke blacklist.txt dan bertahan setelah sync', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const file = path.join(state, 'blacklist.txt');

      const block = await call('/api/blacklist/block', {
        method: 'POST',
        body: { macs: ['aa:00:00:00:00:11'], permanent: true },
      });
      assert.equal(block.status, 200);
      assert.equal(block.body.permanent, true);
      assert.deepEqual(block.body.added, ['aa:00:00:00:00:11']);
      assert.equal(block.body.savedTo, file);
      assert.match(fs.readFileSync(file, 'utf8'), /^aa:00:00:00:00:11$/m);

      // stateDir dipakai bersama beberapa test lain, jadi yang diperiksa hanya
      // MAC milik test ini — bukan seluruh daftar.
      const sync = await call('/api/sync', { method: 'POST', body: {} });
      assert.equal(sync.status, 200);
      assert.ok(!sync.body.unblocked.includes('aa:00:00:00:00:11'), 'sync tidak boleh melepas MAC permanen');

      const list = await call('/api/blacklist');
      assert.ok(list.body.macs.includes('aa:00:00:00:00:11'));
    } });
  });

  it('POST block tanpa permanent hilang setelah sync', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      await call('/api/blacklist/block', { method: 'POST', body: { macs: ['aa:00:00:00:00:12'] } });

      const sync = await call('/api/sync', { method: 'POST', body: {} });
      assert.ok(sync.body.unblocked.includes('aa:00:00:00:00:12'));
    } });
  });

  it('POST block permanent + dry-run tidak menulis file', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const file = path.join(state, 'blacklist.txt');
      const r = await call('/api/blacklist/block', {
        method: 'POST',
        body: { macs: ['aa:00:00:00:00:13'], permanent: true, dryRun: true },
      });
      assert.equal(r.body.dryRun, true);
      assert.deepEqual(r.body.added, []);
      assert.doesNotMatch(
        fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
        /aa:00:00:00:00:13/,
        'dry-run tidak boleh menulis file',
      );
    } });
  });

  it('MAC tidak valid -> 400', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/blacklist/block', { method: 'POST', body: { macs: ['bukan-mac'] } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 2);
    } });
  });

  it('body tanpa macs -> 400', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/blacklist/block', { method: 'POST', body: {} });
      assert.equal(r.status, 400);
    } });
  });

  it('POST /api/sync merekonsiliasi, dry-run tidak menulis', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const file = path.join(state, 'want.txt');
      const dry = await call('/api/sync', { method: 'POST', body: { file, dryRun: true } });
      assert.equal(dry.status, 200);
      assert.equal(dry.body.dryRun, true);

      const real = await call('/api/sync', { method: 'POST', body: { file } });
      assert.equal(real.status, 200);
      assert.equal(real.body.want, 2);
    } });
  });

  it('sync menolak file di luar repo/state dir (path traversal)', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/sync', { method: 'POST', body: { file: '/etc/passwd' } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /di luar area yang diizinkan/i);
      // Pastikan tidak ada isi file yang bocor lewat invalidLines.
      assert.equal(r.body.invalidLines, undefined);
    } });
  });

  it('GET /api/schedule melaporkan task dan next run', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/schedule');
      assert.equal(r.status, 200);
      const names = r.body.tasks.map((t) => t.name);
      assert.deepEqual(names, ['blacklist-sync', 'rules-apply', 'blacklist-audit']);
      assert.ok(r.body.tasks.every((t) => /^\*|\d/.test(t.cron)));
    } });
  });

  it('POST /api/schedule/run menjalankan task', async () => {
    const schedState = tmpDir();
    try {
      await withServer({
        mock,
        stateDir: schedState,
        extraEnv: { BLACKLIST_FILE: path.join(state, 'want.txt') },
        run: async ({ call }) => {
          const r = await call('/api/schedule/run', { method: 'POST', body: { force: true } });
          assert.equal(r.status, 200);
          assert.ok(r.body.results.every((x) => x.status === 'ok'));
        },
      });
    } finally {
      fs.rmSync(schedState, { recursive: true, force: true });
    }
  });

  it('GET /api/logs mengembalikan isi log', async () => {
    const logState = tmpDir();
    try {
      await withServer({
        mock,
        stateDir: logState,
        run: async ({ call }) => {
          await call('/api/blacklist');
          const r = await call('/api/logs?lines=10');
          assert.equal(r.status, 200);
          assert.ok(r.body.lines.length > 0);
          assert.match(r.body.lines.at(-1), /Login berhasil/);
        },
      });
    } finally {
      fs.rmSync(logState, { recursive: true, force: true });
    }
  });

  it('AP mati -> 502, bukan 500', async () => {
    const deadState = tmpDir();
    try {
      await withServer({
        mock: { port: 1 },
        stateDir: deadState,
        extraEnv: { HTTP_TIMEOUT_MS: '1000' },
        run: async ({ call }) => {
          const r = await call('/api/blacklist');
          assert.equal(r.status, 502);
          assert.equal(r.body.code, 4);
        },
      });
    } finally {
      fs.rmSync(deadState, { recursive: true, force: true });
    }
  });

  it('endpoint tidak ada -> 404 JSON', async () => {
    await withServer({ mock, stateDir: state, run: async ({ call }) => {
      const r = await call('/api/tidak-ada');
      assert.equal(r.status, 404);
    } });
  });
});

describe('API_TOKEN', () => {
  let mock;
  let state;

  before(async () => {
    state = tmpDir();
    mock = await startMock({ seed: [] });
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('tanpa token -> 401; dengan token -> 200', async () => {
    await withServer({
      mock,
      stateDir: state,
      extraEnv: { API_TOKEN: 'rahasia123' },
      run: async ({ call }) => {
        const anon = await call('/api/blacklist');
        assert.equal(anon.status, 401);

        const wrong = await call('/api/blacklist', { headers: { Authorization: 'Bearer salah' } });
        assert.equal(wrong.status, 401);

        const ok = await call('/api/blacklist', {
          headers: { Authorization: 'Bearer rahasia123' },
        });
        assert.equal(ok.status, 200);
      },
    });
  });

  it('/health tetap terbuka supaya monitoring tidak perlu token', async () => {
    await withServer({
      mock,
      stateDir: state,
      extraEnv: { API_TOKEN: 'rahasia123' },
      run: async ({ call }) => {
        const r = await call('/health');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
      },
    });
  });

  it('server refuses start di luar loopback tanpa token', async () => {
    const env = {
      ...process.env,
      AP_HOST: `127.0.0.1:${mock.port}`,
      ADMIN_PASS: PASSWORD,
      STATE_DIR: state,
      HOST: '0.0.0.0',
      PORT: '0',
    };
    const config = loadConfig({ env });
    const logger = new Logger({ logFile: config.logFile, quiet: true });

    await assert.rejects(
      () => createServer({ config, logger, service: new Service({ config, logger }) }),
      /API_TOKEN wajib diisi/,
    );
  });
});

describe('aset statis', () => {
  it('public/tailwind.css hasil build benar-benar ada di repo', () => {
    const css = path.join(ROOT, 'public', 'tailwind.css');
    assert.ok(fs.existsSync(css), 'jalankan `npm run build:css`');
    const text = fs.readFileSync(css, 'utf8');
    assert.match(text, /\.btn-danger/, 'utility kustom harus ikut ter-build');
    assert.match(text, /--color-bad/, 'tema warna kustom harus ada');
  });
});
