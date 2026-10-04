import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { AppError, EXIT, LockBusyError, usageError } from './errors.js';

const STATE_VERSION = 1;

/**
 * Scheduler for `schedule:run` — similar to `php artisan schedule:run` in
 * Laravel: crontab calls ONE command per minute; this command decides which tasks
 * are due.
 *
 * How "due" is determined: next run is calculated from task's `lastRunAt`, not from now.
 * If cron has downtime, tasks don't pile up to run multiple times — they run once,
 * then next schedule recalculated from that run time.
 *
 * Failed tasks are SKIPPED until next schedule so a dead AP doesn't trigger
 * retry every minute. Tasks held by lock (LockBusyError) don't advance state,
 * since it's temporary and retry next minute is cheap.
 */
export class Scheduler {
  #state;

  constructor({ tasks, stateFile, logger, now = () => new Date() }) {
    this.tasks = tasks;
    this.stateFile = stateFile;
    this.logger = logger;
    this.now = now;
    this.#state = this.#loadState();

    // Validate cron patterns on start: bad patterns should fail fast,
    // not silently cause tasks to never run.
    for (const task of tasks) this.#nextRunAfter(task, this.now());
  }

  /**
   * Slot cron berikutnya SETELAH `from`.
   *
   * `nextRun(from)` wajib dipakai, bukan `currentDate` di opsi Cron: croner
   * mengabaikan `currentDate`, sehingga hasil hitungannya selalu berdasarkan
   * jam sekarang dan `lastRunAt` jadi tidak pernah berpengaruh.
   */
  #nextRunAfter(task, from) {
    try {
      const next = new Cron(task.cron).nextRun(from);
      if (!next) {
        throw new Error('cron has no next slot (maybe limited by stopAt?)');
      }
      return next;
    } catch (err) {
      throw usageError(
        `Invalid cron pattern for task "${task.name}": ${task.cron} (${err.message})`,
      );
    }
  }

  #loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (raw?.version === STATE_VERSION && raw.tasks && typeof raw.tasks === 'object') {
        return raw;
      }
      this.logger?.warn(`Unknown scheduler state format, starting fresh: ${this.stateFile}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn(`Cannot read scheduler state, starting fresh: ${err.message}`);
      }
    }
    return { version: STATE_VERSION, tasks: {} };
  }

  #saveState() {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    // Write to temp file then rename: atomic rename, so state is never
    // partially written even if two `schedule:run` collide.
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.#state, null, 2)}\n`);
    fs.renameSync(tmp, this.stateFile);
  }

  #record(task) {
    return (this.#state.tasks[task.name] ??= {
      runs: 0,
      lastRunAt: null,
      lastStatus: null,
      lastDurationMs: null,
      lastError: null,
    });
  }

  nextRunFor(task) {
    const entry = this.#record(task);
    return this.#nextRunAfter(task, entry.lastRunAt ? new Date(entry.lastRunAt) : this.now());
  }

  isDue(task) {
    return this.nextRunFor(task) <= this.now();
  }

  /** Summary for `schedule:run --status` and `GET /api/schedule`. */
  status() {
    const now = this.now();
    return {
      now: now.toISOString(),
      stateFile: this.stateFile,
      tasks: this.tasks.map((task) => {
        const entry = this.#record(task);
        const next = this.nextRunFor(task);
        return {
          name: task.name,
          description: task.description ?? '',
          cron: task.cron,
          enabled: task.enabled !== false,
          due: task.enabled !== false && next <= now,
          nextRunAt: next.toISOString(),
          lastRunAt: entry.lastRunAt,
          lastStatus: entry.lastStatus,
          lastDurationMs: entry.lastDurationMs,
          lastError: entry.lastError,
          runs: entry.runs,
        };
      }),
    };
  }

  /**
   * Jalankan task yang jatuh tempo. `only` membatasi ke nama task tertentu,
   * `force` mengabaikan jadwal (tetapi tetap menghormati lock).
   */
  async runDue({ force = false, only = null } = {}) {
    const now = this.now();
    const results = [];
    let worstCode = EXIT.OK;

    for (const task of this.tasks) {
      if (only && !only.includes(task.name)) continue;
      if (task.enabled === false) {
        results.push({ name: task.name, ran: false, status: 'disabled' });
        continue;
      }

      if (!force && !this.isDue(task)) {
        results.push({
          name: task.name,
          ran: false,
          status: 'not-due',
          nextRunAt: this.nextRunFor(task).toISOString(),
        });
        continue;
      }

      const startedAt = Date.now();
      this.logger?.info(`Mulai task "${task.name}" (cron ${task.cron}).`);

      try {
        const data = await task.run();
        const entry = this.#record(task);
        entry.runs += 1;
        entry.lastRunAt = this.now().toISOString();
        entry.lastStatus = 'ok';
        entry.lastDurationMs = Date.now() - startedAt;
        entry.lastError = null;
        this.#saveState();

        this.logger?.info(`Task "${task.name}" selesai dalam ${entry.lastDurationMs}ms.`);
        results.push({
          name: task.name,
          ran: true,
          status: 'ok',
          durationMs: entry.lastDurationMs,
          nextRunAt: this.nextRunFor(task).toISOString(),
          data,
        });
      } catch (err) {
        const locked = err instanceof LockBusyError;
        const code = err instanceof AppError ? err.code : EXIT.API;
        const message = err?.message ?? String(err);

        this.logger?.error(`Task "${task.name}" ${locked ? 'skipped (locked)' : 'failed'}: ${message}`);

        if (!locked) {
          const entry = this.#record(task);
          entry.runs += 1;
          entry.lastRunAt = this.now().toISOString();
          entry.lastStatus = 'failed';
          entry.lastDurationMs = Date.now() - startedAt;
          entry.lastError = message;
          this.#saveState();
          if (code !== EXIT.OK) worstCode = code;
        }

        results.push({
          name: task.name,
          ran: !locked,
          status: locked ? 'skipped-locked' : 'failed',
          error: message,
          code,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    return { startedAt: now.toISOString(), exitCode: worstCode, results };
  }
}
