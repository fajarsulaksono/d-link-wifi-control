const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('wifictl.token') ?? '',
  busy: new Set(),
};

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }

  if (!res.ok) {
    if (res.status === 401) askToken();
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

function askToken() {
  const value = prompt('API_TOKEN diperlukan untuk endpoint ini:');
  if (value) {
    state.token = value.trim();
    localStorage.setItem('wifictl.token', state.token);
  }
}

function toast(message, kind = 'info') {
  const tone = {
    info: 'bg-slate-900 text-white',
    ok: 'bg-ok text-white',
    bad: 'bg-bad text-white',
  }[kind];

  const el = document.createElement('div');
  el.className = `pointer-events-auto rounded-lg px-3 py-2 text-sm shadow-lg ${tone}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 8000 : 4000);
}

/** Cegah klik ganda: tombol nonaktif selama request, lalu baris tabel flash. */
async function run(btn, label, fn) {
  const key = btn ?? label;
  if (state.busy.has(key)) return null;
  state.busy.add(key);
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'bad');
    return null;
  } finally {
    state.busy.delete(key);
    if (btn) btn.disabled = false;
  }
}

function td(text, cls = '') {
  const el = document.createElement('td');
  el.className = `td ${cls}`;
  el.textContent = text;
  return el;
}

function actionButton(label, cls, onClick, { title } = {}) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

function flash(row) {
  row.classList.remove('flash-ok');
  void row.offsetWidth; // paksa reflow supaya animasi bisa diputar ulang
  row.classList.add('flash-ok');
}

async function unblock(mac, btn, row) {
  await run(btn, `unblock:${mac}`, async () => {
    await api('/api/blacklist/unblock', { method: 'POST', body: { macs: [mac] } });
    toast(`Lepas blokir ${mac}`, 'ok');
    flash(row);
    await load();
  });
}

async function block(mac, btn, row) {
  const permanent = $('#permanent').checked;
  const suffix = permanent
    ? ' dan tandai permanen di blacklist.txt'
    : ' (sampai sync berikutnya saja)';
  if (!confirm(`Blokir ${mac} dari jaringan${suffix}?`)) return;
  await run(btn, `block:${mac}`, async () => {
    await api('/api/blacklist/block', { method: 'POST', body: { macs: [mac], permanent } });
    toast(permanent ? `Blokir permanen ${mac}` : `Blokir ${mac}`, 'ok');
    flash(row);
    await load();
  });
}

function renderBlacklist(data) {
  const body = $('#bl-body');
  body.replaceChildren();

  $('#bl-count').textContent = data.count;
  $('#bl-empty').classList.toggle('hidden', data.count > 0);
  $('#s-blocked').textContent = data.count;

  for (const mac of data.macs) {
    const row = document.createElement('tr');
    row.append(td(mac));

    const cell = document.createElement('td');
    cell.className = 'td text-right';
    cell.append(
      actionButton('Lepas', 'btn-ghost', (btn) => unblock(mac, btn, row)),
    );
    row.append(cell);
    body.append(row);
  }
}

function renderClients(data) {
  const body = $('#cl-body');
  body.replaceChildren();

  $('#cl-count').textContent = data.count;
  $('#cl-empty').classList.toggle('hidden', data.count > 0);
  $('#s-clients').textContent = data.count;

  for (const c of data.clients) {
    const row = document.createElement('tr');
    row.append(td(c.mac ?? '-'), td(c.ip ?? '-'), td(c.hostname ?? '-'));

    const cell = document.createElement('td');
    cell.className = 'td text-right';
    cell.append(
      actionButton('Blokir', 'btn-danger', (btn) => block(c.mac, btn, row), {
        title: 'Blokir, dan jadikan permanen kalau checkbox "Permanen" dicentang',
      }),
    );
    row.append(cell);
    body.append(row);
  }
}

function renderSchedule(data) {
  const list = $('#task-list');
  list.replaceChildren();

  const sync = data.tasks.find((t) => t.name === 'blacklist-sync');
  if (sync) {
    $('#s-next').textContent = new Date(sync.nextRunAt).toLocaleString('id-ID');
    $('#s-last').textContent = sync.lastRunAt
      ? `${new Date(sync.lastRunAt).toLocaleString('id-ID')} · ${sync.lastStatus}`
      : 'belum pernah';
  }

  for (const task of data.tasks) {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-center gap-3 p-4';

    const left = document.createElement('div');
    left.className = 'min-w-56 flex-1';

    const title = document.createElement('p');
    title.className = 'text-sm font-semibold';
    title.textContent = task.name;
    if (!task.enabled) title.classList.add('text-slate-400');

    const desc = document.createElement('p');
    desc.className = 'text-xs text-slate-500';
    desc.textContent = `${task.cron} · ${task.description}`;

    const meta = document.createElement('p');
    meta.className = 'mt-1 font-mono text-xs text-slate-400';
    meta.textContent =
      `next ${new Date(task.nextRunAt).toLocaleString('id-ID')}` +
      ` · last ${task.lastRunAt ? new Date(task.lastRunAt).toLocaleString('id-ID') : '-'} ` +
      `(${task.lastStatus ?? 'belum pernah'})` +
      (task.lastError ? ` · error: ${task.lastError}` : '');

    left.append(title, desc, meta);

    const badges = document.createElement('div');
    badges.className = 'flex items-center gap-1.5';
    if (!task.enabled) {
      const b = document.createElement('span');
      b.className = 'badge bg-slate-200 text-slate-500';
      b.textContent = 'nonaktif';
      badges.append(b);
    }
    if (task.due) {
      const b = document.createElement('span');
      b.className = 'badge bg-warn/15 text-warn';
      b.textContent = 'due';
      badges.append(b);
    }
    if (task.lastStatus === 'failed') {
      const b = document.createElement('span');
      b.className = 'badge bg-bad/15 text-bad';
      b.textContent = 'gagal';
      badges.append(b);
    }

    const btn = actionButton('Jalankan', 'btn-ghost', (b) =>
      run(b, `task:${task.name}`, async () => {
        const summary = await api('/api/schedule/run', {
          method: 'POST',
          body: { force: true, task: [task.name] },
        });
        const r = summary.results.find((x) => x.name === task.name);
        toast(`${task.name}: ${r?.status ?? 'selesai'}`, r?.status === 'ok' ? 'ok' : 'bad');
        await load();
      }),
    );

    row.append(left, badges, btn);
    list.append(row);
  }
}

function renderLogs(data) {
  $('#log-file').textContent = data.file;
  $('#log').textContent = data.lines.join('\n');
}

function renderSyncOutput(result) {
  const el = $('#sync-out');
  el.classList.remove('hidden');
  el.textContent = [
    `file     ${result.file}${result.dryRun ? '  (dry-run)' : ''}`,
    `diminta  ${result.want} MAC diblokir`,
    `sebelum  ${result.currentBefore} MAC terblokir di AP`,
    `ditambah ${result.blocked.length}${result.blocked.length ? `  ${result.blocked.join(', ')}` : ''}`,
    `dilepas  ${result.unblocked.length}${result.unblocked.length ? `  ${result.unblocked.join(', ')}` : ''}`,
    ...(result.invalidLines.length
      ? [`diabaikan ${result.invalidLines.length} baris bukan MAC: ${result.invalidLines.join(', ')}`]
      : []),
  ].join('\n');
}

const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

function renderRules(data) {
  $('#rules-file').textContent = data.file;
  $('#rules-now').textContent = `${data.now} · zona ${data.timeZone}`;

  const list = $('#rules-list');
  list.replaceChildren();

  if (data.count === 0) {
    const empty = document.createElement('p');
    empty.className = 'p-4 text-sm text-slate-400';
    empty.textContent = 'Belum ada rule. Semua MAC di sini hanya diblokir di dalam jam yang ditentukan.';
    list.append(empty);
    return;
  }

  for (const rule of data.rules) {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-start gap-3 p-4';

    const dot = document.createElement('span');
    dot.className = rule.active
      ? 'badge bg-ok/15 text-ok'
      : rule.enabled
        ? 'badge bg-slate-100 text-slate-500'
        : 'badge bg-slate-100 text-slate-400';
    dot.textContent = rule.active ? 'AKTIF' : rule.enabled ? 'siap' : 'off';

    const body = document.createElement('div');
    body.className = 'min-w-56 flex-1';

    const title = document.createElement('p');
    title.className = 'text-sm font-semibold';
    title.textContent = rule.name;
    if (!rule.enabled) title.classList.add('text-slate-400');
    body.append(title);

    const when = document.createElement('p');
    when.className = 'mt-1 text-xs text-slate-500';
    when.textContent = rule.windows
      .map((w) => {
        const days = w.days ? w.days.map((d) => DAY_SHORT[d]).join(',') : 'setiap hari';
        return `${days} ${w.start}${w.overnight ? ' (lewat tengah malam)' : ''}`;
      })
      .join('  ·  ');
    body.append(when);

    const macs = document.createElement('p');
    macs.className = 'mt-1 font-mono text-xs text-slate-400';
    macs.textContent = rule.macs.join(', ');
    body.append(macs);

    row.append(dot, body);
    list.append(row);
  }
}

async function load() {
  try {
    const [cfg, blacklist, clients, schedule, logs, rules] = await Promise.all([
      api('/api/config'),
      api('/api/blacklist'),
      api('/api/clients'),
      api('/api/schedule'),
      api('/api/logs?lines=120'),
      api('/api/rules'),
    ]);

    $('#ap-host').textContent = `AP ${cfg.apHost}`;    $('#conn').textContent = 'terhubung';
    $('#conn').className = 'badge bg-ok/15 text-ok';
    if (!$('#sync-file').value) $('#sync-file').value = cfg.blacklistFile;

    renderBlacklist(blacklist);
    renderClients(clients);
    renderSchedule(schedule);
    renderRules(rules);
    renderLogs(logs);
  } catch (err) {
    $('#conn').textContent = 'error';
    $('#conn').className = 'badge bg-bad/15 text-bad';
    if (err.status !== 401) toast(err.message, 'bad');
  }
}

$('#form-block').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#mac-input');
  const value = input.value.trim();
  if (!value) return;

  const btn = ev.submitter;
  const permanent = $('#permanent').checked;
  const result = await run(btn, `add:${value}`, async () => {
    const data = await api('/api/blacklist/block', {
      method: 'POST',
      body: { macs: [value], permanent },
    });
    input.value = '';
    toast(
      permanent
        ? `Blokir permanen ${data.macs.join(', ')} -> ${data.savedTo}`
        : `Blokir ${data.macs.join(', ')}`,
      'ok',
    );
    if (permanent && data.already.length > 0) {
      toast(`${data.already.length} MAC sudah ada di file, tidak ditulis ulang`, 'info');
    }
  });
  if (result) await load();
});

$('#form-sync').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter;
  await run(btn, 'sync', async () => {
    const body = { file: $('#sync-file').value.trim(), dryRun: $('#sync-dry').checked };
    const result = await api('/api/sync', { method: 'POST', body });
    renderSyncOutput(result);
    toast(
      `Sync: +${result.blocked.length} / -${result.unblocked.length}` +
        (result.dryRun ? ' (dry-run)' : ''),
      'ok',
    );
  });
  await load();
});

$('#refresh').addEventListener('click', () => load());

$('#run-all').addEventListener('click', async (ev) => {
  await run(ev.currentTarget, 'run-all', async () => {
    const summary = await api('/api/schedule/run', { method: 'POST', body: { force: true } });
    const ok = summary.results.filter((r) => r.status === 'ok').length;
    toast(`${ok}/${summary.results.length} task sukses`, ok === summary.results.length ? 'ok' : 'bad');
  });
  await load();
});

setInterval(() => {
  if ($('#auto').checked && !state.busy.size) load();
}, 20000);

load();
