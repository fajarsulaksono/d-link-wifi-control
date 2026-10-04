import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeMac, parseMacList, reconcile } from '../src/blacklist.js';
import { CookieJar } from '../src/cookies.js';
import { EXIT, httpStatusFor } from '../src/errors.js';
import { loadConfig, loadEnvFile } from '../src/config.js';

describe('normalizeMac', () => {
  it('menerima tiga format', () => {
    assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('AaBbCcDdEeFf'), 'aa:bb:cc:dd:ee:ff');
  });

  it('menolak input yang bukan MAC', () => {
    for (const bad of ['', 'bukan-mac', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'zz:bb:cc:dd:ee:ff', 'aabbccddeef']) {
      assert.equal(normalizeMac(bad), null, `harus ditolak: ${bad}`);
    }
  });
});

describe('parseMacList', () => {
  it('buang komentar, baris kosong, dan duplikat', () => {
    const { macs } = parseMacList(
      ['# komentar', '', 'AA-BB-CC-DD-EE-FF', 'aa:bb:cc:dd:ee:ff  # inline', '  ', '11:22:33:44:55:66'].join('\n'),
    );
    assert.deepEqual(macs, ['11:22:33:44:55:66', 'aa:bb:cc:dd:ee:ff']);
  });

  it('kembalikan baris rusak terpisah supaya bisa dilaporkan', () => {
    const { macs, invalid } = parseMacList('aa:bb:cc:dd:ee:ff\nngawur\nzz\n');
    assert.deepEqual(macs, ['aa:bb:cc:dd:ee:ff']);
    assert.deepEqual(invalid, ['ngawur', 'zz']);
  });

  it('file kosong -> daftar kosong, bukan error', () => {
    assert.deepEqual(parseMacList(''), { macs: [], invalid: [] });
    assert.deepEqual(parseMacList('# hanya komentar\n'), { macs: [], invalid: [] });
  });
});

describe('reconcile', () => {
  it('menghitung dua arah: tambah dan lepas', () => {
    const r = reconcile(
      ['aa:bb:cc:dd:ee:ff', '00:11:22:33:44:55'],
      ['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'],
    );
    assert.deepEqual(r.toBlock, ['00:11:22:33:44:55']);
    assert.deepEqual(r.toUnblock, ['11:22:33:44:55:66']);
  });

  it('identik -> tidak ada aksi (dasar idempotensi)', () => {
    const list = ['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'];
    const r = reconcile(list, list);
    assert.deepEqual(r.toBlock, []);
    assert.deepEqual(r.toUnblock, []);
  });

  it('file kosong -> semua yang diblokir dilepas', () => {
    assert.deepEqual(reconcile([], ['aa:bb:cc:dd:ee:ff']).toUnblock, ['aa:bb:cc:dd:ee:ff']);
  });
});

describe('CookieJar', () => {
  const res = (cookies) => ({ headers: { getSetCookie: () => cookies } });

  it('menyerap dan clung serialkan cookie', () => {
    const jar = new CookieJar();
    jar.absorb(res(['sysauth=abc; Path=/']));
    jar.absorb(res(['lain=xyz; Path=/']));
    assert.equal(jar.header(), 'sysauth=abc; lain=xyz');
  });

  it('tidak peduli nama cookie (nama diganti firmware)', () => {
    const jar = new CookieJar();
    jar.absorb(res(['SESSIONID=abc; Path=/']));
    assert.equal(jar.header(), 'SESSIONID=abc');
  });

  it('cookie kosong -> header null, bukan string kosong', () => {
    assert.equal(new CookieJar().header(), null);
  });

  it('Max-Age=0 menghapus cookie', () => {
    const jar = new CookieJar();
    jar.absorb(res(['sysauth=abc; Path=/']));
    jar.absorb(res(['sysauth=; Max-Age=0; Path=/']));
    assert.equal(jar.header(), null);
  });

  it('nilai cookie bertanda koma tidak dirusak', () => {
    const jar = new CookieJar();
    jar.absorb(res(['a=1; Path=/', 'b=2; Path=/']));
    assert.deepEqual(jar.header().split('; '), ['a=1', 'b=2']);
  });
});

describe('exit code & pemetaan HTTP', () => {
  it('kode keluar dipertahankan dari versi bash', () => {
    assert.deepEqual(EXIT, { OK: 0, USAGE: 2, AUTH: 3, NETWORK: 4, API: 5, LOCKED: 6 });
  });

  it('AppError dipetakan ke status yang masuk akal', () => {
    assert.equal(httpStatusFor({ code: EXIT.USAGE }), 400);
    assert.equal(httpStatusFor({ code: EXIT.AUTH }), 401);
    assert.equal(httpStatusFor({ code: EXIT.NETWORK }), 502);
    assert.equal(httpStatusFor({ code: EXIT.API }), 502);
    assert.equal(httpStatusFor({ code: EXIT.LOCKED }), 423);
    assert.equal(httpStatusFor(new Error('boom')), 500);
  });
});

describe('loadConfig', () => {
  const base = { HOME: '/home/fjr' };

  it('precedence: default < env', () => {
    const cfg = loadConfig({ env: { ...base, AP_HOST: '10.0.0.9:8080', ADMIN_USER: 'root' } });
    assert.equal(cfg.apHost, '10.0.0.9:8080', 'env menang');
    assert.equal(cfg.apiBase, 'http://10.0.0.9:8080/cgi-bin/luci/admin/routerweb');
    assert.equal(cfg.adminUser, 'root');
  });

  it('tanpa env -> default yang masuk akal', () => {
    const cfg = loadConfig({ env: base });
    assert.equal(cfg.apHost, '192.168.10.1');
    assert.equal(cfg.adminUser, 'CMCCAdmin');
    assert.equal(cfg.adminPass, '');
    assert.ok(cfg.stateDir.startsWith('/home/fjr'));
    assert.equal(cfg.http.host, '127.0.0.1');
  });

  it('nilai numerik tidak valid ditolak', () => {
    assert.throws(() => loadConfig({ env: { ...base, HTTP_TIMEOUT_MS: 'cepat' } }), /angka/);
  });

  it('stateDir bisa dipindah tanpa mengubah default lain', () => {
    const cfg = loadConfig({ env: { ...base, STATE_DIR: '/tmp/wl' } });
    assert.equal(cfg.stateDir, '/tmp/wl');
    assert.equal(cfg.logFile, '/tmp/wl/wifictl.log');
  });

  it('nilai kosong berarti "pakai default"', () => {
    // .env.example sengaja mengosongkan field opsional. Kalau string kosong
    // ikut dipakai, path.resolve('') = cwd dan state ikut pindah ke repo.
    const cfg = loadConfig({ env: { ...base, STATE_DIR: '', LOG_FILE: '', API_TOKEN: '' } });
    assert.ok(cfg.stateDir.startsWith('/home/fjr'), `stateDir jadi ${cfg.stateDir}`);
    assert.ok(cfg.logFile.startsWith('/home/fjr'), `logFile jadi ${cfg.logFile}`);
    assert.equal(cfg.http.apiToken, '');
  });

  it('boolean menerima 1/true/yes/on dan menolak yang lain', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
      assert.equal(loadConfig({ env: { ...base, AUDIT_ENABLED: v } }).auditEnabled, true, v);
    }
    for (const v of ['0', 'false', 'no', 'off', 'ngawur']) {
      assert.equal(loadConfig({ env: { ...base, AUDIT_ENABLED: v } }).auditEnabled, false, v);
    }
  });
});

describe('loadEnvFile', () => {
  it('file yang tidak ada bukan error', () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wifictl-env-')), 'tidak-ada');
    assert.equal(loadEnvFile(missing), false);
  });

  it('nilai dari .env masuk ke process.env, env shell tetap menang', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifictl-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'WIFICTL_UNIT_DARI_FILE=file\nWIFICTL_UNIT_DARI_SHELL=\n');

    process.env.WIFICTL_UNIT_DARI_SHELL = 'shell';
    try {
      assert.equal(loadEnvFile(file), true);
      assert.equal(process.env.WIFICTL_UNIT_DARI_FILE, 'file');
      assert.equal(process.env.WIFICTL_UNIT_DARI_SHELL, 'shell', 'env yang sudah ada tidak ditimpa');
    } finally {
      delete process.env.WIFICTL_UNIT_DARI_FILE;
      delete process.env.WIFICTL_UNIT_DARI_SHELL;
    }
  });

  it('.env yang bukan file biasa ditolak dengan pesan yang menyebut file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifictl-env-'));
    const notAFile = path.join(dir, '.env');
    fs.mkdirSync(notAFile);
    assert.throws(() => loadEnvFile(notAFile), /\.env tidak bisa dibaca/);
  });

  it('baris tanpa "=" diabaikan diam-diam, jadi salah ketik berarti "default"', () => {
    // Perilaku bawaan process.loadEnvFile. Kalau ADMIN_PASS salah ketik, gejalanya
    // exit 2 "Password AP belum diisi" — bukan crash, jadi tidak diam-diam saja.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifictl-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'ADMIN PASS=salah-ketik\nWIFICTL_UNIT_OK=ya\n');
    try {
      loadEnvFile(file);
      assert.equal(process.env.WIFICTL_UNIT_OK, 'ya');
      assert.equal(process.env.ADMIN, undefined, 'baris rusak tidak jadi variable');
    } finally {
      delete process.env.WIFICTL_UNIT_OK;
    }
  });
});

describe('rotasi log', () => {
  it('file lama diputar, bukan dihapus', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'wifictl-log-'));
    const { Logger } = await import('../src/logger.js');
    const logFile = path.join(dir, 'wifictl.log');
    const logger = new Logger({ logFile, maxBytes: 200, maxFiles: 2, quiet: true });

    for (let i = 0; i < 20; i++) logger.info(`baris panjang nomor ${i} agar melewati batas rotasi`);

    assert.ok(fs.existsSync(`${logFile}.1`), 'rotasi harus menghasilkan file .1');
    assert.ok(fs.statSync(logFile).size <= 400, 'file aktif tidak boleh tumbuh tanpa batas');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logger tidak pernah menulis ke stdout', async () => {
    const { Logger } = await import('../src/logger.js');
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'wifictl-log-'));
    let written = '';
    const logger = new Logger({
      logFile: path.join(dir, 'x.log'),
      quiet: false,
      stream: { write: (s) => (written += s) },
    });
    logger.info('halo');
    assert.equal(written, 'halo\n', 'harus lewat stream stderr, bukan stdout');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
