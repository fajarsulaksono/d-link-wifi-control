#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loadConfig, loadEnvFile } from './config.js';
import { AppError, EXIT, usageError } from './errors.js';
import { Logger } from './logger.js';
import { createScheduler } from './schedule.js';
import { Service } from './service.js';
import { DAY_LABELS, describe, parseRules, readRules, resolveNow, writeRules } from './rules.js';
import { createServer } from './server.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Print to stdout. Only DATA — diagnostic messages go to Logger (stderr). */
const out = (text) => process.stdout.write(`${text}\n`);

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '-').length)),
  );
  out(headers.map((h, i) => h.padEnd(widths[i])).join('  '));
  for (const row of rows) out(row.map((v, i) => String(v ?? '-').padEnd(widths[i])).join('  '));
}

function build({ quiet }) {
  const config = loadConfig();
  const logger = new Logger({
    logFile: config.logFile,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
    quiet,
  });

  return { config, logger, service: new Service({ config, logger }) };
}

/** `optsWithGlobals()` supaya `-q`/`--json` boleh sebelum ATAU sesudah subcommand. */
const opts = (cmd) => cmd.optsWithGlobals();

/**
 * Opsi bersama. Diulang di setiap subcommand (bukan hanya di program) karena
 * commander hanya mengenali opsi program sebelum nama subcommand — padahal
 * `wifictl sync blacklist.txt --quiet` adalah urutan yang paling natural.
 */
function common(command) {
  return command
    .option('-q, --quiet', 'do not print messages to stderr (for cron)')
    .option('--json', 'output JSON for use in scripts');
}

const program = new Command();

program
  .name('wifictl')
  .description(
    'MAC blacklist control for D-Link DIR-612F Access Point (WL-Router panel).\n\n' +
      'For cron, run only `wifictl schedule:run` — it decides which tasks\n' +
      'are due.',
  )
  .version(PKG.version)
  .showHelpAfterError()
  .exitOverride();

common(program);

/**
 * Action wrapper: build context (config + logger + service) and pass errors
 * to main() so exit codes don't leak into modules.
 */
function action(fn) {
  return async (...args) => {
    const cmd = args.at(-1);
    const ctx = build(opts(cmd));
    await fn(ctx, cmd, args.slice(0, -1));
  };
}

common(
  program
    .command('block')
    .description('block one or more MACs')
    .argument('<mac...>', 'MAC address')
    .option('-n, --dry-run', 'show actions without executing')
    .option('-p, --permanent', 'write to blacklist.txt so not removed on sync', false),
).action(
  action(async (ctx, cmd, [macs]) => {
    const r = opts(cmd);
    const result = await ctx.service.block(macs, { dryRun: r.dryRun, permanent: Boolean(r.permanent) });
    if (r.json) out(JSON.stringify(result, null, 2));
    else {
      out(`Added: ${result.macs.length} MAC(s).`);
      if (result.permanent) {
        out(`Permanent in ${result.savedTo} (new: ${result.added.length}, already: ${result.already.length}).`);
        if (!result.dryRun && result.added.length > 0) {
          out('Note: next sync only blocks what’s in the file — this is permanent.');
        }
      } else if (!result.dryRun) {
        out('Note: without --permanent, this block is lost on next sync/rules-apply.');
      }
    }
  }),
);

common(
  program
    .command('unblock')
    .description('unblock one or more MACs')
    .argument('<mac...>', 'MAC address')
    .option('-n, --dry-run', 'show actions without executing'),
).action(
  action(async (ctx, cmd, [macs]) => {
    const r = opts(cmd);
    const result = await ctx.service.unblock(macs, { dryRun: r.dryRun });
    if (r.json) out(JSON.stringify(result, null, 2));
    else out(`Unblocked: ${result.macs.length} MAC(s).`);
  }),
);

common(
  program
    .command('limit')
    .description('set speed limit (KB/s) for a client')
    .argument('<mac>', 'MAC address')
    .option('--down <kbps>', 'download limit in KB/s', (v) => Number(v))
    .option('--up <kbps>', 'upload limit in KB/s', (v) => Number(v))
    .option('-n, --dry-run', 'show actions without executing'),
).action(
  action(async (ctx, cmd, [mac]) => {
    const r = opts(cmd);
    const down = r.down ?? 0;
    const up = r.up ?? 0;
    const result = await ctx.service.clientLimit(mac, { downLimit: down, upLimit: up, dryRun: r.dryRun });
    if (r.json) out(JSON.stringify(result, null, 2));
    else {
      const dr = result.dryRun ? ' (dry-run)' : '';
      out(`Limit set${dr}: ${result.mac} down=${result.downLimit}KB/s up=${result.upLimit}KB/s`);
    }
  }),
);

common(
  program
    .command('sync')
    .description('reconcile AP blacklist with file contents (file = single source of truth)')
    .argument('[file]', 'blacklist file', (v) => path.resolve(v))
    .option('-n, --dry-run', 'show actions without executing'),
).action(
  action(async (ctx, cmd, [file]) => {
    const r = opts(cmd);
    const result = await ctx.service.sync({ file, dryRun: r.dryRun });

    // Summary to stdout (data), not logs: so cron can mail via MAILTO
    // without per-MAC noise.
    const summary =
      `Sync complete. Added: ${result.blocked.length}, removed: ${result.unblocked.length}, ` +
      `unchanged: ${result.unchanged}.`;

    if (r.json) out(JSON.stringify(result, null, 2));
    else out(summary);
  }),
);

/* ---------------------------------------------------------------- rules -- */

/** Find rule by exact id, then by name (case-insensitive, unique). */
function findRule(rules, key) {
  const byId = rules.findIndex((r) => r.id === key);
  if (byId >= 0) return byId;
  const needle = key.trim().toLowerCase();
  const hits = rules
    .map((r, i) => [r, i])
    .filter(([r]) => r.name.toLowerCase() === needle || r.id.toLowerCase() === needle);
  if (hits.length === 1) return hits[0][1];
  if (hits.length > 1) {
    throw usageError(`"${key}" cocok dengan ${hits.length} rule: ${hits.map(([r]) => r.id).join(', ')}`);
  }
  return -1;
}

/** Bentuk yang disimpan di rules.json (dibuang fields turunan dari parser). */
function toStored({ id, name, macs, enabled, windows }) {
  return {
    id,
    name,
    macs,
    ...(enabled === false ? { enabled: false } : {}),
    windows: windows.map((w) => ({
      start: w.label.split('-')[0],
      end: w.label.split('-')[1],
      ...(w.days ? { days: w.days } : {}),
    })),
  };
}

/** "mon,tue" atau "1,2" -> array; undefined kalau flag tidak dipakai. */
function parseDayOption(value) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((v) => String(v).trim()).filter(Boolean);
}

const rules = program
  .command('rules')
  .description('kelola blacklist berbasis jam (rules.json)');

common(rules.command('list').description('tampilkan semua rule dan mana yang sedang aktif'))
  .option('--file <path>', 'file rules.json', (v) => path.resolve(v))
  .option('--at <waktu>', 'tinjau seolah-olah sekarang HH:MM atau YYYY-MM-DDTHH:MM')
  .action(
    action(async (ctx, cmd) => {
      const file = cmd.opts().file ?? ctx.config.rulesFile;
      const ruleset = await readRules(file);
      const view = describe(ruleset, { now: resolveNow(cmd.opts().at), timeZone: ctx.config.rulesTz });

      if (cmd.optsWithGlobals().json) return out(JSON.stringify({ file, ...view }, null, 2));
      if (view.rules.length === 0) {
        return out(ruleset.missing ? `Belum ada ${file}.` : 'Tidak ada rule.');
      }

      out(`File : ${file}`);
      out(`Zona : ${view.timeZone}  (sekarang ${view.now})`);
      out('');
      for (const r of view.rules) {
        out(`${r.active ? '[AKTIF] ' : r.enabled ? '[siap]   ' : '[off]    '}${r.name}  (${r.id})`);
        for (const w of r.windows) out(`           ${w.days ? w.days.map((d) => DAY_LABELS[d]).join(',') : 'setiap hari'} ${w.start}`);
        out(`           MAC: ${r.macs.join(', ')}`);
      }
    }),
  );

common(rules.command('active').description('MAC yang sedang diblokir karena rule'))
  .option('--at <waktu>', 'tinjau seolah-olah sekarang HH:MM atau YYYY-MM-DDTHH:MM')
  .action(
    action(async (ctx, cmd) => {
      const result = await ctx.service.activeRules({ now: resolveNow(cmd.opts().at) });
      const r = cmd.optsWithGlobals();
      if (r.json) return out(JSON.stringify(result, null, 2));
      if (result.macs.length === 0) return out('Tidak ada rule yang sedang aktif.');
      out(`Aktif: ${result.activeRules.map((x) => x.name).join(', ')}`);
      out(result.macs.join('\n'));
      out(`Total: ${result.macs.length} MAC address`);
    }),
  );

common(
  rules
    .command('add')
    .description('tambah rule baru')
    .argument('<name>', 'nama rule')
    .option('-m, --mac <mac...>', 'MAC address yang diblokir', [])
    .option('-s, --start <jam>', 'mulai, HH:MM')
    .option('-e, --end <jam>', 'selesai, HH:MM')
    .option('-d, --days <hari>', 'hari berlaku, mis. mon,tue (default setiap hari)')
    .option('--id <id>', 'id rule (default dari nama)')
    .option('--disabled', 'tambah dalam keadaan mati'),
).action(
  action(async (ctx, cmd, [name]) => {
    const c = cmd.opts();
    if (c.mac.length === 0) throw usageError('Minimal satu --mac wajib diisi');
    if (!c.start || !c.end) throw usageError('--start dan --end wajib diisi');

    const file = ctx.config.rulesFile;
    const ruleset = await readRules(file);

    // Susun ulang lewat parser supaya validasi yang dipakai `add` persis
    // sama dengan yang dipakai scheduler saat membaca file.
    const draft = parseRules(
      JSON.stringify({
        rules: [{
          name,
          id: c.id,
          enabled: !c.disabled,
          macs: c.mac,
          windows: [{ start: c.start, end: c.end, days: parseDayOption(c.days) }],
        }],
      }),
      { where: 'rules add' },
    ).rules[0];

    if (findRule(ruleset.rules, draft.id) >= 0) {
      throw usageError(`Rule with id "${draft.id}" already exists — use \`rules update\` to modify it`);
    }

    await writeRules(file, [...ruleset.rules.map(toStored), toStored(draft)]);
    out(`Rule "${draft.name}" (${draft.id}) ditambahkan ke ${file}`);
  }),
);

common(rules.command('remove').description('hapus rule').argument('<rule>', 'id atau nama rule')).action(
  action(async (ctx, cmd, [key]) => {
    const file = ctx.config.rulesFile;
    const ruleset = await readRules(file);
    const i = findRule(ruleset.rules, key);
    if (i < 0) {
      throw usageError(`Rule "${key}" tidak ada di ${file}`);
    }

    const [removed] = ruleset.rules.splice(i, 1);
    await writeRules(file, ruleset.rules.map(toStored));
    out(`Rule "${removed.name}" (${removed.id}) dihapus dari ${file}`);
  }),
);

common(
  rules
    .command('update')
    .description('ubah rule yang ada')
    .argument('<rule>', 'id atau nama rule')
    .option('-m, --mac <mac...>', 'ganti daftar MAC')
    .option('-a, --add-mac <mac...>', 'tambah MAC')
    .option('-r, --remove-mac <mac...>', 'lepas MAC')
    .option('-s, --start <jam>', 'ganti jam mulai')
    .option('-e, --end <jam>', 'ganti jam selesai')
    .option('-d, --days <hari>', 'ganti hari berlaku')
    .option('--enable', 'nyalakan rule')
    .option('--disable', 'matikan rule')
    .option('--rename <nama>', 'ganti nama'),
).action(
  action(async (ctx, cmd, [key]) => {
    const c = cmd.opts();
    const file = ctx.config.rulesFile;
    const ruleset = await readRules(file);
    const i = findRule(ruleset.rules, key);
    if (i < 0) throw usageError(`Rule "${key}" tidak ada di ${file}`);

    const target = ruleset.rules[i];
    const next = { ...target };

    if (c.rename) next.name = c.rename;
    if (c.mac) next.macs = c.mac;
    if (c.addMac) next.macs = [...new Set([...next.macs, ...c.addMac])];
    if (c.removeMac) next.macs = next.macs.filter((m) => !c.removeMac.map((x) => x.toLowerCase()).includes(m));
    if (c.enable) next.enabled = true;
    if (c.disable) next.enabled = false;

    if (c.start || c.end || c.days) {
      if (next.windows.length !== 1) {
        throw usageError(
          `Rule "${next.name}" punya ${next.windows.length} window — \`update\` hanya mengubah satu. Edit ${file} langsung untuk yang lain.`,
        );
      }
      const w = next.windows[0];
      const days = parseDayOption(c.days) ?? w.days;
      next.windows = [parseRules(JSON.stringify({ rules: [{ ...next, windows: [{ start: c.start ?? w.label.split('-')[0], end: c.end ?? w.label.split('-')[1], days }] }] }), { where: 'rules update' }).rules[0].windows[0]];
    }

    if (next.macs.length === 0) throw usageError('Daftar MAC tidak boleh kosong — rule tanpa MAC tidak ada gunanya');

    ruleset.rules[i] = next;
    await writeRules(file, ruleset.rules.map(toStored));
    out(`Rule "${next.name}" (${next.id}) diperbarui di ${file}`);
  }),
);

common(program.command('list').description('tampilkan blacklist yang aktif di AP')).action(
  action(async (ctx, cmd) => {
    const r = opts(cmd);
    const result = await ctx.service.list();
    if (r.json) return out(JSON.stringify(result, null, 2));
    if (result.count === 0) return out('Blacklist kosong.');
    return out(`${result.macs.join('\n')}\nTotal: ${result.count} MAC address`);
  }),
);

common(program.command('clients').description('tampilkan device yang sedang terhubung')).action(
  action(async (ctx, cmd) => {
    const r = opts(cmd);
    const result = await ctx.service.clients();
    if (r.json) return out(JSON.stringify(result, null, 2));
    if (result.count === 0) return out('Tidak ada client terhubung.');

    printTable(
      ['MAC', 'IP', 'HOSTNAME', 'UP'],
      result.clients.map((c) => [c.mac, c.ip, c.hostname, c.upSeconds]),
    );
    return out(`Total: ${result.count} device`);
  }),
);

common(program.command('login-test').description('uji login ke AP lalu keluar')).action(
  action(async (ctx, cmd) => {
    const result = await ctx.service.loginTest();
    ctx.logger.info('Login test OK — password benar.');
    if (opts(cmd).json) out(JSON.stringify(result, null, 2));
  }),
);

common(
  program
    .command('schedule:run')
    .description('jalankan task yang jatuh tempo (satu-satunya perintah yang dipanggil cron)')
    .option('--force', 'jalankan semua task aktif, abaikan jadwal')
    .option('--task <nama...>', 'batasi ke task tertentu')
    .option('--status', 'cetak status jadwal lalu keluar tanpa menjalankan apa pun'),
).action(
  action(async (ctx, cmd) => {
    const r = opts(cmd);
    const scheduler = createScheduler({ config: ctx.config, logger: ctx.logger, service: ctx.service });

    if (r.status) {
      const status = scheduler.status();
      if (r.json) return out(JSON.stringify(status, null, 2));
      return out(
        [
          `Scheduler state: ${status.stateFile}`,
          `Sekarang: ${status.now}`,
          '',
          ...status.tasks.flatMap((t) => [
            `  ${t.name}${t.enabled ? (t.due ? ' [due]' : '') : ' [nonaktif]'}`,
            `    cron       ${t.cron}`,
            `    deskripsi  ${t.description}`,
            `    next run   ${t.nextRunAt}`,
            `    last run   ${t.lastRunAt ?? '-'} (${t.lastStatus ?? 'pernah belum'})`,
            ...(t.lastError ? [`    error      ${t.lastError}`] : []),
          ]),
        ].join('\n'),
      );
    }

    const summary = await scheduler.runDue({ force: r.force, only: r.task });
    const ran = summary.results.filter((x) => x.ran);

    if (r.json) out(JSON.stringify(summary, null, 2));
    else
      out(
        [
          `schedule:run — ${ran.length} task dijalankan dari ${summary.results.length} task aktif.`,
          ...ran.map((x) =>
            x.status === 'ok'
              ? `  OK      ${x.name} (${x.durationMs}ms)`
              : `  FAILED  ${x.name}: ${x.error}`,
          ),
          ...summary.results
            .filter((x) => !x.ran && x.status !== 'not-due' && x.status !== 'disabled')
            .map((x) => `  SKIP    ${x.name}: ${x.error}`),
        ].join('\n'),
      );

    // Cron/laravel monitoring butuh tahu ada task yang gagal.
    if (summary.exitCode !== EXIT.OK) process.exitCode = summary.exitCode;
  }),
);

common(program.command('serve').description('jalankan HTTP API + dashboard (Express)')).action(
  action(async (ctx) => {
    await createServer({ config: ctx.config, logger: ctx.logger, service: ctx.service });
  }),
);

async function main() {
  try {
    // `.env` dimuat sebelum config apa pun dibaca, dan sebelum Commander
    // complain soal argumen — supaya `--help` juga tidak misleading.
    loadEnvFile();
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander memakai exit code sendiri (1) dan menulis pesannya sendiri.
    // Samakan jadi EXIT.USAGE supaya konsisten dengan error domain.
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return; // --help / --version
      process.stderr.write(`${err.message}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }

    const code = err instanceof AppError ? err.code : EXIT.USAGE;

    // Error SELALU ke stderr, bahkan saat --quiet: cron yang gagal diam-diam
    // membuat blacklist tidak sinkron tanpa ada yang tahu.
    process.stderr.write(`wifictl: ${err?.message ?? err}\n`);
    process.exitCode = code;
  }
}

await main();
