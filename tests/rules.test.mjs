import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate, isWindowActive, parseRules, readRules, resolveNow } from '../src/rules.js';
import { PASSWORD, cliEnv, runCli, startMock, tmpDir } from './helpers.mjs';

const json = (rules) => JSON.stringify({ rules });

function parse(rules) {
  return parseRules(json(rules));
}

/** Window tunggal, biar test fokus pada logika jam. */
function win(spec) {
  const [rule] = parse([{ name: 'r', macs: ['aa:bb:cc:dd:ee:ff'], windows: [spec] }]).rules;
  return rule.windows[0];
}

describe('validasi rules.json', () => {
  it('menolak JSON rusak dan struktur salah', () => {
    assert.throws(() => parseRules('{bukan json'), /JSON tidak valid/);
    assert.throws(() => parseRules('[]'), /harus objek/);
    assert.throws(() => parseRules('{}'), /"rules" tidak ada/);
    assert.throws(() => parseRules('{"rules":{}}'), /"rules" harus array/);
  });

  it('menolak rule yang tidak lengkap', () => {
    assert.throws(() => parse([{ macs: ['aa:bb:cc:dd:ee:ff'], windows: [{ start: '1:00', end: '2:00' }] }]), /"name" wajib/);
    assert.throws(() => parse([{ name: 'x', windows: [{ start: '1:00', end: '2:00' }] }]), /macs wajib/);
    assert.throws(() => parse([{ name: 'x', macs: [], windows: [{ start: '1:00', end: '2:00' }] }]), /macs wajib/);
    assert.throws(() => parse([{ name: 'x', macs: [] }]), /"windows" wajib/);
    assert.throws(() => parse([{ name: 'x', macs: ['aa:bb:cc:dd:ee:ff'] }]), /"windows" wajib/);
  });

  it('menolak jam, MAC, dan hari yang tidak masuk akal', () => {
    const macs = ['aa:bb:cc:dd:ee:ff'];
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '25:00', end: '26:00' }] }]), /jam 25 tidak ada/);
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '12:00', end: '13:60' }] }]), /HH:MM/);
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: 'nope', end: '13:00' }] }]), /HH:MM/);
    assert.throws(() => parse([{ name: 'x', macs: ['zz:zz'], windows: [{ start: '1:00', end: '2:00' }] }]), /MAC tidak valid/);
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '1:00', end: '2:00', days: ['xyz'] }] }]), /tidak dikenal/);
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '1:00', end: '2:00', days: [] }] }]), /tidak boleh kosong/);
  });

  it('menolak start === end, karena "sepanjang hari" harus ditulis eksplisit', () => {
    const macs = ['aa:bb:cc:dd:ee:ff'];
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '12:00', end: '12:00' }] }]), /start dan end sama/);
    // Bentuk eksplisitnya tetap diterima.
    const [rule] = parse([{ name: 'x', macs, windows: [{ start: '00:00', end: '24:00' }] }]).rules;
    assert.equal(rule.windows[0].end, 1440);
  });

  it('24:00 hanya sah sebagai end', () => {
    const macs = ['aa:bb:cc:dd:ee:ff'];
    assert.throws(() => parse([{ name: 'x', macs, windows: [{ start: '24:00', end: '01:00' }] }]), /jam 24 tidak ada/);
  });

  it('menyederhanakan id duplikat, dan-windows, dan bentuk ringkas', () => {
    const { rules } = parse([
      { name: 'Sama', macs: ['aa:bb:cc:dd:ee:ff'], windows: [{ start: '1:00', end: '2:00' }] },
      { name: 'Sama', macs: ['aa:bb:cc:dd:ee:ff'], windows: [{ start: '3:00', end: '4:00' }] },
      { name: 'Ringkas', macs: ['bb:bb:bb:bb:bb:bb'], start: '5:00', end: '6:00', days: ['mon'] },
    ]);
    assert.deepEqual(rules.map((r) => r.id), ['sama', 'sama-2', 'ringkas']);
    assert.equal(rules[2].windows[0].label, '5:00-6:00');
    assert.deepEqual(rules[2].windows[0].days, [1]);
  });
});

describe('jendela waktu', () => {
  // 2026-10-05 = Senin, 2026-10-03 = Sabtu, 2026-10-04 = Minggu.
  const senin = (hhmm) => new Date(2026, 9, 5, ...hhmm.split(':').map(Number), 0, 0);
  const sabtu = (hhmm) => new Date(2026, 9, 3, ...hhmm.split(':').map(Number), 0, 0);
  const minggu = (hhmm) => new Date(2026, 9, 4, ...hhmm.split(':').map(Number), 0, 0);

  it('batas inklusif di start, eksklusif di end', () => {
    const w = win({ start: '12:00', end: '13:00' });
    assert.equal(isWindowActive(w, senin('11:59')), false);
    assert.equal(isWindowActive(w, senin('12:00')), true);
    assert.equal(isWindowActive(w, senin('12:59')), true);
    assert.equal(isWindowActive(w, senin('13:00')), false);
  });

  it('menutup semua jam bila 00:00-24:00', () => {
    const w = win({ start: '00:00', end: '24:00' });
    for (const t of ['00:00', '09:30', '23:59']) {
      assert.equal(isWindowActive(w, senin(t)), true, t);
    }
  });

  it('melewati tengah malam: 23:00-01:00 aktif di kedua sisi', () => {
    const w = win({ start: '23:00', end: '01:00' });
    assert.equal(isWindowActive(w, senin('22:59')), false);
    assert.equal(isWindowActive(w, senin('23:00')), true);
    assert.equal(isWindowActive(w, senin('23:59')), true);
    assert.equal(isWindowActive(w, minggu('00:00')), true);
    assert.equal(isWindowActive(w, minggu('00:59')), true);
    assert.equal(isWindowActive(w, minggu('01:00')), false);
  });

  it('days menunjuk ke hari jendela dimulai, termasuk yang lewat tengah malam', () => {
    // Jumat 23:00-01:00 -> Sabtu 00:30 masih aktif.
    const jumatMalam = win({ start: '23:00', end: '01:00', days: ['fri'] });
    assert.equal(isWindowActive(jumatMalam, new Date(2026, 9, 2, 23, 30)), true);
    assert.equal(isWindowActive(jumatMalam, sabtu('00:30')), true, 'Sabtu dini hari masih milik Jumat');
    assert.equal(isWindowActive(jumatMalam, sabtu('23:30')), false, 'Sabtu malam bukan Jumat');

    const jumatSiang = win({ start: '12:00', end: '13:00', days: ['fri'] });
    assert.equal(isWindowActive(jumatSiang, new Date(2026, 9, 2, 12, 30)), true);
    assert.equal(isWindowActive(jumatSiang, senin('12:30')), false);
  });

  it('menerima hari sebagai angka 0-6', () => {
    const w = win({ start: '12:00', end: '13:00', days: [0] });
    assert.equal(isWindowActive(w, minggu('12:30')), true);
    assert.equal(isWindowActive(w, senin('12:30')), false);
  });

  it('evaluate menggabungkan MAC dari semua rule aktif', () => {
    const ruleset = parse([
      { name: 'A', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '12:00', end: '13:00' }] },
      { name: 'B', macs: ['bb:bb:bb:bb:bb:bb', 'aa:aa:aa:aa:aa:aa'], windows: [{ start: '12:30', end: '14:00' }] },
      { name: 'C', macs: ['cc:cc:cc:cc:cc:cc'], windows: [{ start: '20:00', end: '21:00' }] },
      { name: 'D', enabled: false, macs: ['dd:dd:dd:dd:dd:dd'], windows: [{ start: '00:00', end: '24:00' }] },
    ]);

    const at = senin('12:45');
    const result = evaluate(ruleset, { now: at });
    assert.deepEqual(result.macs, ['aa:aa:aa:aa:aa:aa', 'bb:bb:bb:bb:bb:bb']);
    assert.deepEqual(result.activeRules.map((r) => r.name), ['A', 'B']);
    assert.deepEqual(result.skippedRules, ['d']);
  });

  it('rule disabled tidak pernah aktif, walau jendelanya cocok', () => {
    const ruleset = parse([
      { name: 'Mati', enabled: false, macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '00:00', end: '24:00' }] },
    ]);
    assert.deepEqual(evaluate(ruleset, { now: senin('12:00') }).macs, []);
  });
});

describe('zona waktu', () => {
  // Hanya zona yang disebutkan yang diuji — hasil untuk "jam sistem" bergantung
  // pada zona mesin tempat test dijalankan, jadi tidak boleh diasumsikan.
  it('RULES_TZ menentukan jam yang dipakai, bukan jam sistem', () => {
    const ruleset = parse([
      { name: 'Siang', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '13:00', end: '14:00' }] },
    ]);
    const utc = new Date('2026-10-05T06:30:00Z');

    assert.deepEqual(
      evaluate(ruleset, { now: utc, timeZone: 'Asia/Jakarta' }).macs,
      ['aa:aa:aa:aa:aa:aa'],
      '06:30 UTC = 13:30 WIB, di dalam 13:00-14:00',
    );
    assert.deepEqual(evaluate(ruleset, { now: utc, timeZone: 'UTC' }).macs, [], '06:30 UTC, di luar');
    assert.deepEqual(
      evaluate(ruleset, { now: utc, timeZone: 'Asia/Makassar' }).macs,
      [],
      '06:30 UTC = 14:30 WITA, di luar',
    );
  });

  it('hari juga dihitung di zona rules', () => {
    // 2026-10-05 23:00 UTC = 2026-10-06 06:00 WIB (Selasa).
    const ruleset = parse([
      { name: 'Pagi', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '06:00', end: '07:00', days: ['tue'] }] },
    ]);
    const now = new Date('2026-10-05T23:00:00Z');

    assert.deepEqual(evaluate(ruleset, { now, timeZone: 'Asia/Jakarta' }).macs, ['aa:aa:aa:aa:aa:aa']);
    assert.deepEqual(evaluate(ruleset, { now, timeZone: 'UTC' }).macs, [], 'di UTC masih Senin');
  });
});

describe('resolveNow', () => {
  it('HH:MM berarti hari ini di jam itu', () => {
    const at = resolveNow('17:30');
    assert.equal(at.getHours(), 17);
    assert.equal(at.getMinutes(), 30);
    assert.equal(at.getSeconds(), 0);
  });

  it('timestamp lengkap dipakai apa adanya', () => {
    assert.equal(resolveNow('2026-10-05T23:30:00').getHours(), 23);
  });

  it('menolak input yang tidak dimaknai', () => {
    assert.throws(() => resolveNow('nanti sore'), /tidak dimaknai/);
  });
});

describe('readRules', () => {
  it('file yang belum ada berarti "tidak ada rule", bukan error', async () => {
    const dir = tmpDir();
    const result = await readRules(path.join(dir, 'tidak-ada.json'));
    assert.deepEqual(result.rules, []);
    assert.equal(result.missing, true);
  });

  it('file rusak ditolak dengan nama file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'rules.json');
    fs.writeFileSync(file, '{rusak');
    await assert.rejects(() => readRules(file), /rules\.json: JSON tidak valid/);
  });
});

describe('CLI rules', () => {
  const setup = () => {
    const dir = tmpDir();
    return { dir, env: { RULES_FILE: path.join(dir, 'rules.json'), STATE_DIR: dir } };
  };

  it('add → list → update → remove', async () => {
    const { dir, env } = setup();
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'));

    const add = await runCli(['rules', 'add', 'Jam istirahat', '-m', 'aa:bb:cc:dd:ee:ff', '-s', '12:00', '-e', '13:00'], { env });
    assert.equal(add.code, 0, add.all);
    assert.deepEqual(read().rules[0].windows, [{ start: '12:00', end: '13:00' }]);

    // Tambah MAC kedua lewat add-mac, lalu ganti jam.
    assert.equal((await runCli(['rules', 'update', 'jam-istirahat', '--add-mac', '11:22:33:44:55:66'], { env })).code, 0);
    assert.equal((await runCli(['rules', 'update', 'jam-istirahat', '-s', '11:00', '-e', '11:30'], { env })).code, 0);
    const updated = read().rules[0];
    assert.equal(updated.macs.length, 2);
    assert.deepEqual(updated.windows, [{ start: '11:00', end: '11:30' }]);

    // --remove-mac hanya membuang yang disebut.
    assert.equal((await runCli(['rules', 'update', 'jam-istirahat', '--remove-mac', 'AA:BB:CC:DD:EE:FF'], { env })).code, 0);
    assert.deepEqual(read().rules[0].macs, ['11:22:33:44:55:66']);

    assert.equal((await runCli(['rules', 'remove', 'jam-istirahat'], { env })).code, 0);
    assert.deepEqual(read().rules, []);
  });

  it('menolak add yang tidak lengkap dan id bentrok', async () => {
    const { env } = setup();
    const noMac = await runCli(['rules', 'add', 'X', '-s', '1:00', '-e', '2:00'], { env });
    assert.equal(noMac.code, 2);
    assert.match(noMac.all, /--mac wajib/);

    const noTime = await runCli(['rules', 'add', 'X', '-m', 'aa:bb:cc:dd:ee:ff'], { env });
    assert.equal(noTime.code, 2);

    await runCli(['rules', 'add', 'X', '-m', 'aa:bb:cc:dd:ee:ff', '-s', '1:00', '-e', '2:00'], { env });
    const dup = await runCli(['rules', 'add', 'X', '-m', 'bb:bb:bb:bb:bb:bb', '-s', '3:00', '-e', '4:00'], { env });
    assert.equal(dup.code, 2);
    assert.match(dup.all, /sudah ada/);
  });

  it('remove rule yang tidak ada -> exit 2', async () => {
    const { env } = setup();
    const res = await runCli(['rules', 'remove', 'hantu'], { env });
    assert.equal(res.code, 2);
    assert.match(res.all, /tidak ada/);
  });

  it('list --at menandai rule yang aktif pada jam itu', async () => {
    const { dir, env } = setup();
    fs.writeFileSync(
      path.join(dir, 'rules.json'),
      json([
        { id: 'siang', name: 'Siang', macs: ['aa:aa:aa:aa:aa:aa'], windows: [{ start: '12:00', end: '13:00' }] },
        { id: 'malam', name: 'Malam', macs: ['bb:bb:bb:bb:bb:bb'], windows: [{ start: '17:30', end: '18:30' }] },
      ]),
    );

    const siang = await runCli(['rules', 'list', '--at', '12:30', '--json'], { env });
    assert.equal(siang.code, 0, siang.all);
    const aktifSiang = JSON.parse(siang.stdout).rules.filter((r) => r.active).map((r) => r.id);
    assert.deepEqual(aktifSiang, ['siang']);

    const malam = await runCli(['rules', 'active', '--at', '18:00', '--json'], { env });
    assert.deepEqual(JSON.parse(malam.stdout).macs, ['bb:bb:bb:bb:bb:bb']);
  });
});

describe('sync memakai rule', () => {
  it('MAC rule ikut diblokir, dan tidak dilepas oleh blacklist-sync', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    const listFile = path.join(state, 'blacklist.txt');

    // 00:00-24:00 = selalu aktif, jadi deterministik tanpa bergantung jam.
    fs.writeFileSync(
      rulesFile,
      json([{ id: 'selalu', name: 'Selalu', macs: ['de:ad:be:ef:00:01'], windows: [{ start: '00:00', end: '24:00' }] }]),
    );
    fs.writeFileSync(listFile, 'aa:bb:cc:dd:ee:ff\n');

    const mock = await startMock({ seed: [] });
    try {
      const env = cliEnv(mock, state, { RULES_FILE: rulesFile, BLACKLIST_FILE: listFile });

      const first = await runCli(['sync', '--json'], { env });
      assert.equal(first.code, 0, first.all);
      const hasil = JSON.parse(first.stdout);
      assert.deepEqual(hasil.blocked.sort(), ['aa:bb:cc:dd:ee:ff', 'de:ad:be:ef:00:01']);
      assert.deepEqual(hasil.fromRules, ['de:ad:be:ef:00:01']);
      assert.equal(hasil.permanent, 1);

      // Idempoten, dan MAC dari rule tidak dilepas di run kedua.
      const second = await runCli(['sync', '--json'], { env });
      assert.deepEqual(JSON.parse(second.stdout).blocked, []);
      assert.deepEqual(JSON.parse(second.stdout).unblocked, []);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('rule yang tidak aktif tidak memblokir apa pun', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    const listFile = path.join(state, 'blacklist.txt');

    fs.writeFileSync(
      rulesFile,
      json([{ id: 'malam', name: 'Malam', macs: ['de:ad:be:ef:00:01'], windows: [{ start: '03:00', end: '04:00' }] }]),
    );
    fs.writeFileSync(listFile, '');

    const mock = await startMock({ seed: [{ mac: 'de:ad:be:ef:00:01', disabled: 1 }] });
    try {
      const env = cliEnv(mock, state, { RULES_FILE: rulesFile, BLACKLIST_FILE: listFile });
      const res = await runCli(['sync', '--json'], { env });
      assert.equal(res.code, 0, res.all);
      // Di luar jam rule, MAC itu harus dilepas.
      assert.deepEqual(JSON.parse(res.stdout).unblocked, ['de:ad:be:ef:00:01']);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('rules.json rusak -> exit 2, AP tidak disentuh', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    const listFile = path.join(state, 'b.txt');
    fs.writeFileSync(rulesFile, '{rusak');
    fs.writeFileSync(listFile, '');

    const mock = await startMock({ seed: [] });
    try {
      const env = cliEnv(mock, state, { RULES_FILE: rulesFile, BLACKLIST_FILE: listFile });
      const res = await runCli(['sync'], { env });
      assert.equal(res.code, 2);
      assert.match(res.all, /JSON tidak valid/);
      assert.equal((await runCli(['list'], { env })).code, 0, 'tidak ada yang ditulis');
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('RULES_ENABLED=false mematikan semua rule', async () => {
    const state = tmpDir();
    const rulesFile = path.join(state, 'rules.json');
    const listFile = path.join(state, 'b.txt');
    fs.writeFileSync(
      rulesFile,
      json([{ id: 'selalu', name: 'Selalu', macs: ['de:ad:be:ef:00:01'], windows: [{ start: '00:00', end: '24:00' }] }]),
    );
    fs.writeFileSync(listFile, '');

    const mock = await startMock({ seed: [] });
    try {
      const env = cliEnv(mock, state, {
        RULES_FILE: rulesFile,
        RULES_ENABLED: 'false',
        BLACKLIST_FILE: listFile,
      });
      const res = await runCli(['sync', '--json'], { env });
      assert.deepEqual(JSON.parse(res.stdout).fromRules, []);
      assert.deepEqual(JSON.parse(res.stdout).blocked, []);
    } finally {
      await mock.stop();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('password tidak bocor lewat rules', () => {
  it('tidak ada nilai password di rules.json yang ditulis CLI', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'rules.json');
    await runCli(['rules', 'add', 'X', '-m', 'aa:bb:cc:dd:ee:ff', '-s', '1:00', '-e', '2:00'], {
      env: { RULES_FILE: file, STATE_DIR: dir, ADMIN_PASS: PASSWORD },
    });
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(PASSWORD));
  });
});