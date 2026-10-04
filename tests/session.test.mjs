import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { RouterClient } from '../src/client.js';
import { EXIT } from '../src/errors.js';
import { PASSWORD, startMock, tmpDir } from './helpers.mjs';

/**
 * Sesi yang kedaluwarsa di tengah proses yang sedang jalan.
 *
 * Firmware ini membalas "sesi hilang" dalam dua bentuk, dan keduanya harus
 * memicu login ulang:
 *   1. 200 text/html  -> halaman login LuCI (diawali `<`)
 *   2. 500 text/plain -> /usr/lib/lua/luci/sauth.lua: ... Security Exception
 *
 * Bentuk kedua inilah yang dulu bocor: JSON.parse gagal, body tidak diawali
 * `<`, jadi jatuh ke apiError biasa (exit 5) dan tidak pernah di-retry.
 * Bentuk aslinya dikonfirmasi ke 192.168.10.1 dengan cookie sysauth=abc.
 */
const newClient = (port) =>
  new RouterClient({
    apiBase: `http://127.0.0.1:${port}/cgi-bin/luci/admin/routerweb`,
    adminUser: 'CMCCAdmin',
    adminPass: PASSWORD,
    timeoutMs: 5000,
  });

describe('sesi kedaluwarsa -> 500 text/plain dari sauth.lua', () => {
  let mock;

  before(async () => {
    // 1 request terautentikasi boleh berhasil, lalu sesi berikutnya meledak
    // persis seperti yang dilakukan firmware asli.
    mock = await startMock({
      seed: [{ mac: 'aa:bb:cc:dd:ee:ff' }],
      env: { MOCK_EXPIRE_AFTER: '1' },
    });
  });
  after(async () => {
    await mock.stop();
  });

  it('login ulang otomatis, lalu operasi berhasil', async () => {
    const client = newClient(mock.port);

    assert.deepEqual(await client.fetchBlacklist(), ['aa:bb:cc:dd:ee:ff']);
    assert.ok(client.sessionOk, 'sesi harus pulih setelah login ulang');
    assert.equal(mock.log.match(/login OK/g)?.length ?? 0, 2, 'harus login dua kali: awal + pemulihan');
  });

  it('blokir tetap terpengaruh setelah sesi kadaluwarsa', async () => {
    const client = newClient(mock.port);

    await client.setDeny('aa:00:00:00:00:aa', 1, 'blokir');
    assert.ok(
      (await client.fetchBlacklist()).includes('aa:00:00:00:00:aa'),
      'MAC harus benar-benar terblokir di AP',
    );
  });

  it('logout tidak perlu: sesi baru langsung dipakai', async () => {
    const client = newClient(mock.port);
    await client.fetchBlacklist();
    assert.ok(client.sessionOk);
  });
});

describe('sesi hilang yang tidak bisa dipulihkan', () => {
  it('balasan sauth.lua terus-menerus -> exit auth, tanpa traceback bocor', async () => {
    // Mock yang selalu membalas 500 sauth.lua apa pun yang dikirim.
    const mock = await startMock({ seed: [], env: { MOCK_ALWAYS_SESSION_ERROR: '1' } });
    try {
      const client = newClient(mock.port);
      await assert.rejects(
        () => client.fetchBlacklist(),
        (err) => {
          assert.equal(err.code, EXIT.AUTH, `harus auth(3), bukan ${err.code}`);
          assert.doesNotMatch(err.message, /stack traceback/, 'traceback tidak boleh bocor');
          assert.match(err.message, /ditolak dua kali/, 'pesan harus menjelaskan-situasi');
          return true;
        },
      );
    } finally {
      await mock.stop();
    }
  });

  it('respons non-JSON yang bukan tanda tangan sesi tetap exit 5', async () => {
    // Teks acak: jangan sampai ikut dianggap "sesi hilang" dan di-retry.
    const responses = [
      new Response('Internal Server Error: boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
      new Response('{"result":0}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    let i = 0;
    const client = new RouterClient({
      apiBase: 'http://mock.invalid',
      adminUser: 'CMCCAdmin',
      adminPass: PASSWORD,
      fetchImpl: async () => responses[Math.min(i++, responses.length - 1)],
    });

    await assert.rejects(
      () => client.fetchBlacklist(),
      (err) => {
        assert.equal(err.code, EXIT.API, `harus api(5), bukan ${err.code}`);
        assert.match(err.message, /bukan JSON/);
        return true;
      },
    );
  });
});

describe('login gagal', () => {
  it('password salah -> exit 3 dengan pesan yang jelas', async () => {
    const mock = await startMock({ seed: [] });
    try {
      const client = new RouterClient({
        apiBase: `http://127.0.0.1:${mock.port}/cgi-bin/luci/admin/routerweb`,
        adminUser: 'CMCCAdmin',
        adminPass: 'salah',
        timeoutMs: 5000,
      });
      await assert.rejects(
        () => client.login(),
        (err) => {
          assert.equal(err.code, EXIT.AUTH);
          assert.match(err.message, /password error|Login gagal/);
          return true;
        },
      );
    } finally {
      await mock.stop();
    }
  });
});