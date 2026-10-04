import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PASSWORD, cliEnv, runCli, startMock, tmpDir } from './helpers.mjs';

// `schedule:run` adalah satu-satunya perintah yang dipanggil cron. Test ini
// mengunci perilaku yang penting: idempoten, tidak menumpuk saat cron telat,
// dan menghormati jadwal cron.

describe('schedule:run', () => {
  let mock;
  let state;
  let want;

  before(async () => {
    state = tmpDir();
    mock = await startMock({
      seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }, { mac: '11:22:33:44:55:66' }],
    });
    want = path.join(state, 'want.txt');
    fs.writeFileSync(want, '# desired\nAA:BB:CC:DD:EE:FF\n00:11:22:33:44:55\n');
  });

  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  /**
   * Simulasikan cron yang sudah berjalan sejak lama: task terakhir jalan 40
   * menit lalu, jadi jadwal tiap 30 menit sudah jatuh tempo.
   * (Tidak boleh menulis `*`/`/` berurutan di dalam komentar ini.)
   */
  beforeEach(() => {
    fs.writeFileSync(
      path.join(state, 'schedule-state.json'),
      JSON.stringify({
        version: 1,
        tasks: {
          'blacklist-sync': {
            runs: 3,
            lastRunAt: new Date(Date.now() - 40 * 60_000).toISOString(),
            lastStatus: 'ok',
            lastDurationMs: 120,
            lastError: null,
          },
          'blacklist-audit': {
            runs: 1,
            lastRunAt: new Date(Date.now() - 70 * 60_000).toISOString(),
            lastStatus: 'ok',
            lastDurationMs: 90,
            lastError: null,
          },
        },
      }),
    );
  });

  const env = (extra = {}) =>
    cliEnv(mock, state, { BLACKLIST_FILE: want, SYNC_CRON: '*/30 * * * *', ...extra });

  it('task yang jatuh tempo dijalankan', async () => {
    const r = await runCli(['schedule:run', '--json'], { env: env() });
    assert.equal(r.code, 0);

    const summary = JSON.parse(r.stdout);
    const sync = summary.results.find((x) => x.name === 'blacklist-sync');
    assert.equal(sync.status, 'ok');
    assert.equal(sync.data.ditambah, 1, '00:11:22:33:44:55 harus masuk');
    assert.equal(sync.data.dilepas, 1, '11:22:33:44:55:66 harus keluar');
  });

  it('task yang belum pernah jalan menunggu slot cron berikutnya', async () => {
    // Setara schedule:run milik Laravel: next run dihitung dari now, jadi
    // instalasi baru tidak langsung menyala di tengah menit.
    fs.rmSync(path.join(state, 'schedule-state.json'));
    const r = await runCli(['schedule:run', '--json'], { env: env() });
    const sync = JSON.parse(r.stdout).results.find((x) => x.name === 'blacklist-sync');
    assert.equal(sync.status, 'not-due');

    const status = JSON.parse((await runCli(['schedule:run', '--status', '--json'], { env: env() })).stdout);
    const next = status.tasks.find((t) => t.name === 'blacklist-sync');
    assert.ok(new Date(next.nextRunAt) > new Date(status.now), 'slot berikutnya harus di masa depan');
  });

  it('tick berikutnya di menit yang sama tidak menjalankan apa pun', async () => {
    // Inilah raison d'être schedule:run — cron memanggil setiap menit, task
    // harus menolak jalan di luar jadwalnya.
    const first = await runCli(['schedule:run', '--json'], { env: env() });
    const ranFirst = JSON.parse(first.stdout).results.find((x) => x.name === 'blacklist-sync');
    assert.equal(ranFirst.status, 'ok');

    const second = await runCli(['schedule:run', '--json'], { env: env() });
    const sync = JSON.parse(second.stdout).results.find((x) => x.name === 'blacklist-sync');
    assert.equal(sync.status, 'not-due');
    assert.equal(sync.ran, false);
  });

  it('sync idempoten walau dipaksa berulang kali', async () => {
    await runCli(['schedule:run', '--force'], { env: env() });
    const second = await runCli(['schedule:run', '--force', '--json'], { env: env() });
    const sync = JSON.parse(second.stdout).results.find((x) => x.name === 'blacklist-sync');
    assert.equal(sync.data.ditambah, 0);
    assert.equal(sync.data.dilepas, 0);
  });

  it('--task membatasi hanya task yang diminta', async () => {
    const r = await runCli(['schedule:run', '--force', '--task', 'blacklist-audit', '--json'], {
      env: env(),
    });
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0].name, 'blacklist-audit');
    assert.equal(summary.results[0].status, 'ok');
  });

  it('--status tidak menjalankan apa pun', async () => {
    const before = mock.countLog('BLOCK') + mock.countLog('UNBLOCK');
    const r = await runCli(['schedule:run', '--status', '--json'], { env: env() });
    assert.equal(r.code, 0);
    assert.equal(mock.countLog('BLOCK') + mock.countLog('UNBLOCK'), before);

    const status = JSON.parse(r.stdout);
    assert.deepEqual(status.tasks.map((t) => t.name), ['blacklist-sync', 'rules-apply', 'blacklist-audit']);
    assert.ok(status.tasks.every((t) => t.cron && t.nextRunAt));
  });

  it('cron expression dipakai untuk menentukan due', async () => {
    // Jadwal 6 jam lagi => tidak due, dan nextRunAt harus di masa depan.
    const r = await runCli(['schedule:run', '--status', '--json'], {
      env: env({ SYNC_CRON: '0 6 * * *' }),
    });
    const status = JSON.parse(r.stdout);
    const sync = status.tasks.find((t) => t.name === 'blacklist-sync');
    assert.equal(sync.due, false);
    assert.ok(new Date(sync.nextRunAt) > new Date(status.now));
  });

  it('pola cron salah gagal dengan pesan jelas', async () => {
    const r = await runCli(['schedule:run', '--status'], { env: env({ SYNC_CRON: 'bukan cron' }) });
    assert.notEqual(r.code, 0);
    assert.match(r.all, /cron tidak valid/i);
  });

  it('task yang dimatikan dilewati', async () => {
    const r = await runCli(['schedule:run', '--force', '--json'], {
      env: env({ SYNC_ENABLED: 'false', AUDIT_ENABLED: 'false', RULES_ENABLED: 'false' }),
    });
    const summary = JSON.parse(r.stdout);
    assert.ok(summary.results.every((x) => x.status === 'disabled'));
  });

  it('cron yang gagal membuat schedule:run keluar non-zero', async () => {
    const r = await runCli(['schedule:run', '--force'], {
      env: env({ AP_HOST: '127.0.0.1:1', HTTP_TIMEOUT_MS: '1000' }),
    });
    assert.equal(r.code, 4, 'cron/laravel monitoring perlu tahu task gagal');
  });

  it('scheduler state disimpan di state dir', async () => {
    await runCli(['schedule:run', '--force'], { env: env() });
    const file = path.join(state, 'schedule-state.json');
    assert.ok(fs.existsSync(file), 'harus ada state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(saved.tasks['blacklist-sync'].lastRunAt);
    assert.equal(saved.tasks['blacklist-sync'].lastStatus, 'ok');
  });

  it('kegagalan dicatat failed lalu tidak diulang sampai jadwal berikutnya', async () => {
    const broken = env({ AP_HOST: '127.0.0.1:1', HTTP_TIMEOUT_MS: '1000' });
    await runCli(['schedule:run', '--force'], { env: broken });

    const file = path.join(state, 'schedule-state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.tasks['blacklist-sync'].lastStatus, 'failed');

    // AP sudah kembali: tick berikutnya harus TIDAK menjalankan task itu lagi
    // (jadwalnya belum datang), supaya AP yang rusak tidak di-hammer tiap menit.
    const after = await runCli(['schedule:run', '--json'], { env: env() });
    const sync = JSON.parse(after.stdout).results.find((x) => x.name === 'blacklist-sync');
    assert.equal(sync.status, 'not-due');
  });
});

describe('schedule:run saat lock ditahan', () => {
  it('task dilewati, bukan dicatat gagal, dan tidak advancement state', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const want = path.join(state, 'want.txt');
      fs.writeFileSync(want, 'aa:bb:cc:dd:ee:ff\n');

      const lockfile = path.join(state, 'wifictl.lock');
      fs.writeFileSync(lockfile, '');
      const plock = (await import('proper-lockfile')).default;
      await plock.lock(lockfile, { stale: 120000, retries: 0 });

      const r = await runCli(['schedule:run', '--force', '--json'], {
        env: cliEnv(mock, state, { BLACKLIST_FILE: want }),
      });
      const sync = JSON.parse(r.stdout).results.find((x) => x.name === 'blacklist-sync');
      assert.equal(sync.status, 'skipped-locked');
      assert.equal(sync.ran, false);

      await plock.unlock(lockfile);

      // Karena tidak di-advancement, run berikutnya langsung mencoba lagi.
      const retry = await runCli(['schedule:run', '--force', '--json'], {
        env: cliEnv(mock, state, { BLACKLIST_FILE: want }),
      });
      const again = JSON.parse(retry.stdout).results.find((x) => x.name === 'blacklist-sync');
      assert.equal(again.status, 'ok');
      assert.equal(again.data.ditambah, 1);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('password tidak bocor', () => {
  it('tidak muncul di log maupun di output', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const r = await runCli(['login-test'], { env: cliEnv(mock, state) });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.all, new RegExp(PASSWORD));
      assert.doesNotMatch(fs.readFileSync(path.join(state, 'wifictl.log'), 'utf8'), new RegExp(PASSWORD));
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
