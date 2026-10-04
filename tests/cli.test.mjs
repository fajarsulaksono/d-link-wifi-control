import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import plock from 'proper-lockfile';
import { PASSWORD, cliEnv, runCli, startMock, tmpDir } from './helpers.mjs';

// Porting dari tests/run_tests.sh (versi bash) + kasus yang hanya relevan
// untuk implementasi Node. Semua test memakai mock, tidak pernah AP nyata.

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO_BLACKLIST = path.join(ROOT, 'blacklist.txt');

/** Total operasi tulis yang tercatat di log mock. */
const writeCount = (mock) => mock.countLog('BLOCK') + mock.countLog('UNBLOCK');

describe('autentikasi', () => {
  let mock;
  let state;

  before(async () => {
    state = tmpDir();
    mock = await startMock({ seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }] });
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('password benar -> exit 0', async () => {
    const r = await runCli(['login-test'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.all, /Login berhasil/);
  });

  it('password salah -> exit 3', async () => {
    const r = await runCli(['login-test'], { env: cliEnv(mock, state, { ADMIN_PASS: 'salah' }) });
    assert.equal(r.code, 3);
    assert.match(r.all, /password error/);
  });

  it('password kosong -> exit 2', async () => {
    const r = await runCli(['login-test'], { env: cliEnv(mock, state, { ADMIN_PASS: '' }) });
    assert.equal(r.code, 2);
    assert.match(r.all, /belum diisi/i);
  });
});

describe('validasi input', () => {
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

  it('block tanpa argumen -> exit 2', async () => {
    const r = await runCli(['block'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 2);
  });

  it('MAC tidak valid -> exit 2', async () => {
    const r = await runCli(['block', 'bukan-mac'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 2);
    assert.match(r.all, /tidak valid/i);
  });

  it('MAC campuran dalam satu perintah -> exit 2 tanpa efek samping', async () => {
    const before = writeCount(mock);
    const r = await runCli(['block', 'aa:bb:cc:dd:ee:ff', 'ngawur'], {
      env: cliEnv(mock, state),
    });
    assert.equal(r.code, 2);
    assert.equal(writeCount(mock), before, 'tidak boleh ada MAC yang terproses');
  });

  it('dry-run menerima tiga format MAC dan tidak menulis ke AP', async () => {
    const before = writeCount(mock);
    const r = await runCli(
      ['block', 'aa:bb:cc:dd:ee:ff', '11-22-33-44-55-66', '112233445566', '--dry-run'],
      { env: cliEnv(mock, state) },
    );
    assert.equal(r.code, 0);
    assert.match(r.all, /dry-run/);
    assert.equal(writeCount(mock), before);
  });
});

describe('block / unblock', () => {
  let mock;
  let state;

  before(async () => {
    state = tmpDir();
    mock = await startMock({ seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }] });
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('blokir MAC baru lalu muncul di list', async () => {
    const r = await runCli(['block', 'de:ad:be:ef:00:01'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.all, /OK blokir/);

    const list = await runCli(['list'], { env: cliEnv(mock, state) });
    assert.equal(list.code, 0);
    assert.match(list.stdout, /de:ad:be:ef:00:01/);
  });

  it('lepas blokir MAC', async () => {
    const r = await runCli(['unblock', 'de:ad:be:ef:00:01'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.all, /OK lepas-blokir/);

    const list = await runCli(['list'], { env: cliEnv(mock, state) });
    assert.match(list.stdout, /Total: 1/);
    assert.doesNotMatch(list.stdout, /de:ad:be:ef:00:01/);
  });

  it('blokir beberapa MAC sekaligus', async () => {
    const r = await runCli(['block', 'aa:00:00:00:00:01', 'AA:00:00:00:00:02'], {
      env: cliEnv(mock, state),
    });
    assert.equal(r.code, 0);

    const json = await runCli(['list', '--json'], { env: cliEnv(mock, state) });
    const { macs } = JSON.parse(json.stdout);
    assert.ok(macs.includes('aa:00:00:00:00:01'));
    assert.ok(macs.includes('aa:00:00:00:00:02'), 'huruf besar harus dinormalkan');
  });
});

describe('block --permanent', () => {
  let mock;
  let state;
  let list;
  const env = (extra) => cliEnv(mock, state, extra);
  /** MAC yang benar-benar terblokir di AP mock. */
  const blockedInAp = async () => JSON.parse((await runCli(['list', '--json'], { env: env() })).stdout).macs;

  before(async () => {
    state = tmpDir();
    mock = await startMock({ seed: [] });
    list = path.join(state, 'blacklist.txt');
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('menulis MAC ke blacklist.txt lalu memblokir di AP', async () => {
    const r = await runCli(['block', 'AA:BB:CC:DD:EE:F1', '--permanent', '--json'], { env: env() });
    assert.equal(r.code, 0);

    const out = JSON.parse(r.stdout);
    assert.equal(out.permanent, true);
    assert.deepEqual(out.macs, ['aa:bb:cc:dd:ee:f1']);
    assert.deepEqual(out.added, ['aa:bb:cc:dd:ee:f1']);
    assert.deepEqual(out.already, []);
    assert.equal(out.savedTo, list);

    assert.match(fs.readFileSync(list, 'utf8'), /^aa:bb:cc:dd:ee:f1$/m);
    assert.ok((await blockedInAp()).includes('aa:bb:cc:dd:ee:f1'), 'harus terblokir di AP juga');
  });

  it('MAC yang sudah ada tidak ditulis ulang', async () => {
    const r = await runCli(['block', 'aa:bb:cc:dd:ee:f1', '--permanent', '--json'], { env: env() });
    assert.equal(r.code, 0);

    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.already, ['aa:bb:cc:dd:ee:f1']);
    assert.equal(fs.readFileSync(list, 'utf8').match(/aa:bb:cc:dd:ee:f1/g).length, 1, 'tidak boleh duplikat');
  });

  it('beberapa MAC sekaligus, file tetap terurut', async () => {
    const r = await runCli(['block', 'aa:00:00:00:00:02', 'aa:00:00:00:00:01', '-p', '--json'], { env: env() });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).added, ['aa:00:00:00:00:01', 'aa:00:00:00:00:02']);
    assert.match(fs.readFileSync(list, 'utf8'), /^aa:00:00:00:00:02$/m);
  });

  it('--dry-run --permanent tidak menyentuh file maupun AP', async () => {
    const before = fs.readFileSync(list, 'utf8');
    const r = await runCli(['block', 'aa:00:00:00:00:09', '--permanent', '--dry-run', '--json'], { env: env() });
    assert.equal(r.code, 0);

    const out = JSON.parse(r.stdout);
    assert.equal(out.dryRun, true);
    assert.equal(out.permanent, true);
    assert.deepEqual(out.added, []);

    assert.equal(fs.readFileSync(list, 'utf8'), before);
    assert.ok(!(await blockedInAp()).includes('aa:00:00:00:00:09'));
  });

  it('tanpa --permanent file tidak berubah', async () => {
    const before = fs.readFileSync(list, 'utf8');
    const r = await runCli(['block', 'aa:00:00:00:00:0a', '--json'], { env: env() });
    assert.equal(r.code, 0);

    const out = JSON.parse(r.stdout);
    assert.equal(out.permanent, false);
    assert.equal(out.savedTo, undefined, 'tidak boleh ada field file kalau tidak permanent');
    assert.equal(fs.readFileSync(list, 'utf8'), before);
  });

  it('blokir tanpa --permanent hilang lagi setelah sync', async () => {
    const r = await runCli(['sync', '--json'], { env: env() });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.unblocked.includes('aa:00:00:00:00:0a'), 'harus dilepas, hanya berlaku sampai sync');
  });

  it('MAC permanen bertahan setelah sync dijalankan lagi', async () => {
    const r = await runCli(['sync', '--json'], { env: env() });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).unblocked, []);
    assert.ok((await blockedInAp()).includes('aa:bb:cc:dd:ee:f1'), 'sync tidak boleh melepas MAC permanen');
  });

  it('MAC permanen yang dihapus dari file dilepas saat sync', async () => {
    fs.writeFileSync(list, 'aa:00:00:00:00:01\n');

    await runCli(['sync', '--json'], { env: env() });
    const after = await blockedInAp();
    assert.ok(!after.includes('aa:bb:cc:dd:ee:f1'), 'harus dilepas');
    assert.ok(after.includes('aa:00:00:00:00:01'), 'yang masih di file tetap diblokir');
  });

  it('blacklist.txt belum ada -> dibuat', async () => {
    const fresh = tmpDir();
    try {
      fs.rmSync(list, { force: true });
      const r = await runCli(['block', 'aa:00:00:00:00:0b', '-p', '--json'], { env: env() });
      assert.equal(r.code, 0);
      assert.equal(fs.readFileSync(list, 'utf8'), 'aa:00:00:00:00:0b\n');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('sync (rekonsiliasi desired-state)', () => {
  let mock;
  let state;
  let want;

  before(async () => {
    state = tmpDir();
    mock = await startMock({
      seed: [
        { mac: 'aa:bb:cc:dd:ee:ff' },
        { mac: '11:22:33:44:55:66' },
        { mac: '99:88:77:66:55:44' },
      ],
    });
    want = path.join(state, 'want.txt');
    fs.writeFileSync(want, '# daftar\nAA-BB-CC-DD-EE-FF\n\n00:11:22:33:44:55\n');
  });
  after(async () => {
    await mock.stop();
    fs.rmSync(state, { recursive: true, force: true });
  });

  it('pass 1: blokir yang baru, lepas yang tidak ada di file', async () => {
    const r = await runCli(['sync', want], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Ditambah: 1, dilepas: 2/);
    assert.match(r.all, /OK blokir 00:11:22:33:44:55/);
    assert.match(r.all, /OK lepas-blokir 11:22:33:44:55:66/);
  });

  it('pass 2: idempoten', async () => {
    const r = await runCli(['sync', want], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Ditambah: 0, dilepas: 0/);
  });

  it('blacklist akhir persis sesuai file', async () => {
    const list = await runCli(['list', '--json'], { env: cliEnv(mock, state) });
    const { macs } = JSON.parse(list.stdout);
    assert.deepEqual([...macs].sort(), ['00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff']);
  });

  it('path eksplisit yang tidak ada -> exit 2', async () => {
    const r = await runCli(['sync', path.join(state, 'nope.txt')], { env: cliEnv(mock, state) });
    assert.equal(r.code, 2);
    assert.match(r.all, /tidak ditemukan/i);
  });

  // Mock sendiri: test di sini sync ke daftar kosong, jadi akan melepas
  // semua MAC yang test lain di blok ini pakai.
  describe('file default yang belum ada', () => {
    let solo;
    let soloState;

    before(async () => {
      soloState = tmpDir();
      solo = await startMock({ seed: [] });
    });
    after(async () => {
      await solo.stop();
      fs.rmSync(soloState, { recursive: true, force: true });
    });

    const soloEnv = (extra) =>
      cliEnv(solo, soloState, { BLACKLIST_FILE: path.join(soloState, 'belum-ada.txt'), ...extra });

    it('berarti tidak ada MAC permanen, bukan error', async () => {
      const r = await runCli(['sync', '--json'], { env: soloEnv() });
      assert.equal(r.code, 0, 'sync harus tetap berhasil di instalasi baru');
      assert.deepEqual(JSON.parse(r.stdout).blocked, []);
    });

    it('blokir non-permanen tetap bisa dibersihkan', async () => {
      await runCli(['block', 'aa:00:00:00:00:1a'], { env: soloEnv() });

      const r = await runCli(['sync', '--json'], { env: soloEnv() });
      assert.equal(r.code, 0);
      assert.ok(JSON.parse(r.stdout).unblocked.includes('aa:00:00:00:00:1a'));
    });

    it('blacklist-audit dan rules-apply tidak gagal di state kosong', async () => {
      const r = await runCli(['schedule:run', '--force', '--json'], {
        env: soloEnv({ RULES_CRON: '* * * * *', AUDIT_CRON: '* * * * *', SYNC_CRON: '* * * * *' }),
      });
      assert.equal(r.code, 0);
      for (const t of JSON.parse(r.stdout).results) {
        assert.equal(t.status, 'ok', `${t.name} harus ok, bukan ${t.status}`);
      }
    });
  });

  it('dry-run tidak mengubah AP', async () => {
    const before = writeCount(mock);
    const r = await runCli(['sync', want, '--dry-run'], { env: cliEnv(mock, state) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /tidak berubah: 2/);
    assert.equal(writeCount(mock), before);
  });

  it('baris bukan MAC dilaporkan, bukan dibuang diam-diam', async () => {
    const file = path.join(state, 'messy.txt');
    fs.writeFileSync(file, 'aa:bb:cc:dd:ee:ff\nbukan-mac\nzz:zz\n');
    const r = await runCli(['sync', file, '--json'], { env: cliEnv(mock, state) });
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result.invalidLines, ['bukan-mac', 'zz:zz']);
    assert.match(r.stderr, /Melewati baris tidak valid/);
  });

  it('sync tanpa argumen memakai file default dari config', async () => {
    const r = await runCli(['sync', '--json'], {
      env: cliEnv(mock, state, { BLACKLIST_FILE: want }),
    });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).file, want);
  });
});

describe('clients', () => {
  it('menampilkan device terhubung', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const r = await runCli(['clients'], { env: cliEnv(mock, state) });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /LAPTOP-1/);
      assert.match(r.stdout, /Total: 2 device/);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('guard format data', () => {
  it('.list bukan array -> exit 5, dan sync tidak menebak', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [], env: { MOCK_MALFORMED: '1' } });
    try {
      const list = await runCli(['list'], { env: cliEnv(mock, state) });
      assert.equal(list.code, 5);
      assert.match(list.all, /format API berubah/);

      // Kalau sync diam-diam lanjut dengan array kosong, ia akan menganggap
      // seluruh MAC di file perlu diblokir ulang.
      const want = path.join(state, 'want.txt');
      fs.writeFileSync(want, 'aa:bb:cc:dd:ee:ff\n');
      const before = writeCount(mock);
      const sync = await runCli(['sync', want], { env: cliEnv(mock, state) });
      assert.equal(sync.code, 5);
      assert.match(sync.all, /format API berubah/);
      assert.equal(writeCount(mock), before);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('blacklist kosong ({list:{}} di firmware asli) bukan error', async () => {
    // Firmware DIR-612F mengirim {"list":{}} saat tidak ada MAC yang diblokir.
    // Timeout-nya nyata: sebelum diperbaiki, `list` dan dashboard gagal 502.
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const list = await runCli(['list', '--json'], { env: cliEnv(mock, state) });
      assert.equal(list.code, 0, list.all);
      assert.deepEqual(JSON.parse(list.stdout), { macs: [], count: 0 });

      // Sync dengan file kosong juga harus idempoten, bukan error.
      const empty = path.join(state, 'empty.txt');
      fs.writeFileSync(empty, '# belum ada MAC\n');
      const sync = await runCli(['sync', empty], { env: cliEnv(mock, state) });
      assert.equal(sync.code, 0, sync.all);
      assert.equal(writeCount(mock), 0, 'tidak perlu menulis ke AP');
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('AP tidak terjangkau', () => {
  it('TCP gagal -> exit 4', async () => {
    const state = tmpDir();
    try {
      const r = await runCli(['login-test'], {
        env: {
          AP_HOST: '127.0.0.1:1',
          ADMIN_PASS: PASSWORD,
          STATE_DIR: state,
          HTTP_TIMEOUT_MS: '2000',
        },
      });
      assert.equal(r.code, 4);
      assert.match(r.all, /Tidak bisa menghubungi/);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('server menerima koneksi tapi tidak menjawab -> exit 4 (timeout)', async () => {
    const state = tmpDir();
    // Mock ditahan jauh lebih lama daripada timeout klien: satu-satunya
    // yang bisa menyelamatkan adalah AbortSignal.timeout.
    const slow = await startMock({ seed: [], env: { MOCK_DELAY_MS: '8000' } });
    try {
      const r = await runCli(['login-test'], {
        env: cliEnv(slow, state, { HTTP_TIMEOUT_MS: '300' }),
      });
      assert.equal(r.code, 4);
      assert.match(r.all, /Tidak bisa menghubungi/);
    } finally {
      await slow.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('pemisahan stdout/stderr', () => {
  // Regresi lama: log() menulis ke stdout, jadi "Login berhasil" tercampur ke
  // daftar MAC dan sync sempat mengirim MAC kosong ke AP. Stdout HARUS data saja.
  it('stdout bersih dari pesan log', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }] });
    try {
      const r = await runCli(['list'], { env: cliEnv(mock, state) });
      assert.equal(r.code, 0);
      assert.doesNotMatch(r.stdout, /Login berhasil/);
      assert.match(r.stdout, /aa:bb:cc:dd:ee:ff/);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('--quiet tidak membocorkan apa pun ke stderr', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const r = await runCli(['sync', REPO_BLACKLIST, '--quiet'], { env: cliEnv(mock, state) });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.match(r.stdout, /Sync selesai/);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('--quiet tetap melaporkan error ke stderr', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      const r = await runCli(['login-test', '--quiet'], {
        env: cliEnv(mock, state, { ADMIN_PASS: 'salah' }),
      });
      assert.equal(r.code, 3);
      assert.notEqual(r.stderr, '', 'cron harus melihat kegagalan meski --quiet');
      assert.equal(r.stdout, '');
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('locking', () => {
  it('proses kedua yang butuh lock -> exit 6, lalu normal setelah lock lepas', async () => {
    const state = tmpDir();
    const mock = await startMock({ seed: [] });
    try {
      // Dikunci dari luar proses, meniru instantsi wifictl yang lain.
      const lockfile = path.join(state, 'wifictl.lock');
      fs.writeFileSync(lockfile, '');
      await plock.lock(lockfile, { stale: 120000, retries: 0 });

      const blocked = await runCli(['block', 'aa:bb:cc:dd:ee:01'], { env: cliEnv(mock, state) });
      assert.equal(blocked.code, 6);
      assert.match(blocked.all, /sedang berjalan/);

      await plock.unlock(lockfile);

      const ok = await runCli(['block', 'aa:bb:cc:dd:ee:01'], { env: cliEnv(mock, state) });
      assert.equal(ok.code, 0);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('dua proses CLI paralel tidak meniadakan satu sama lain', async () => {
    const state = tmpDir();
    // Mock ditahan 1.5 detik supaya proses pertama jelas masih memegang lock
    // ketika proses kedua mencoba masuk — tanpa itu, hasilnya bisa flaky.
    const mock = await startMock({ seed: [], env: { MOCK_DELAY_MS: '1500' } });
    try {
      const results = await Promise.all([
        runCli(['block', 'aa:00:00:00:00:01'], { env: cliEnv(mock, state) }),
        runCli(['block', 'aa:00:00:00:00:02'], { env: cliEnv(mock, state) }),
      ]);
      const codes = results.map((r) => r.code).sort();
      assert.deepEqual(codes, [0, 6], 'satu berhasil, satu tertahan lock');

      const list = await runCli(['list', '--json'], { env: cliEnv(mock, state) });
      const { macs } = JSON.parse(list.stdout);
      assert.equal(macs.length, 1, 'hanya MAC dari proses yang lock-nya didapat');
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('keluar dari CLI', () => {
  it('perintah tidak dikenal -> exit 2', async () => {
    const r = await runCli(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command/i);
  });

  it('--help -> exit 0', async () => {
    const r = await runCli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /schedule:run/);
  });

  it('mention schedule:run sebagai perintah cron', async () => {
    const r = await runCli(['schedule:run', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /cron/);
  });
});
