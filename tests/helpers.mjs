import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(ROOT, 'src', 'cli.js');
export const MOCK = path.join(ROOT, 'tests', 'mock_router.py');
export const PASSWORD = 'test123';

/**
 * Mock API WL-Router (tests/mock_router.py) disalakan di port bebas dan
 * nomor portnya dibaca dari file yang ditulis proses itu sendiri. Menghindari
 * balapan reuse-port antar test case.
 */
export async function startMock({ seed = [], password = PASSWORD, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifictl-mock-'));
  const seedFile = path.join(dir, 'seed.json');
  const portFile = path.join(dir, 'port');
  fs.writeFileSync(seedFile, JSON.stringify(seed));

  const child = spawn(
    'python3',
    [MOCK, '0'],
    {
      env: { ...process.env, MOCK_SEED: seedFile, MOCK_PASSWORD: password, MOCK_PORT_FILE: portFile, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      if (fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim() !== '') {
        clearInterval(poll);
        resolve(Number(fs.readFileSync(portFile, 'utf8').trim()));
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`Mock server tidak mau start:\n${log}`));
      }
    }, 50);
    child.once('exit', () => {
      clearInterval(poll);
      reject(new Error(`Mock server keluar sebelum siap:\n${log}`));
    });
  });

  await waitForPort(port);

  return {
    port,
    dir,
    get log() {
      return log;
    },
    /**
     * Hitung operasi tulis yang tercatat, dicocokkan PREFIX setelah "[mock] ".
     * Wajib di-anchor: "UNBLOCK" mengandung "BLOCK", jadi cocokkan substring
     * akan menghitung dua kali.
     */
    countLog: (op) => log.split('\n').filter((l) => new RegExp(`\\] ${op}\\s`).test(l)).length,
    async stop() {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForPort(port) {
  const net = await import('node:net');
  const deadline = Date.now() + 8000;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => (sock.destroy(), resolve(true)));
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`Port ${port} tidak terbuka`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Jalankan CLI sebagai proses anak; return { code, stdout, stderr, all }. */
export function runCli(args, { env = {}, cwd = ROOT, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();

    child.once('close', (code) =>
      resolve({ code, stdout, stderr, all: `${stdout}${stderr}` }),
    );
  });
}

/** Environment CLI yang diarahkan ke mock + state dir sementara. */
export function cliEnv(mock, stateDir, extra = {}) {
  return {
    // Arahkan ke path yang pasti tidak ada supaya test tidak pernah membaca
    // .env lokal developer (yang isinya password AP asli).
    WIFI_CTL_ENV_FILE: path.join(stateDir, 'tidak-ada.env'),
    AP_HOST: `127.0.0.1:${mock.port}`,
    ADMIN_PASS: PASSWORD,
    STATE_DIR: stateDir,
    LOG_FILE: path.join(stateDir, 'wifictl.log'),
    HTTP_TIMEOUT_MS: '5000',
    // Default-nya file daftar di dalam stateDir, bukan blacklist.txt repo.
    // Test yang menulis daftar permanen akan menimpanya sendiri lewat `extra`.
    BLACKLIST_FILE: path.join(stateDir, 'blacklist.txt'),
    RULES_FILE: path.join(stateDir, 'rules.json'),
    ...extra,
  };
}

export function tmpDir(prefix = 'wifictl-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
