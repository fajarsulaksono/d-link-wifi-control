import fs from 'node:fs';
import path from 'node:path';
import plock from 'proper-lockfile';
import { LockBusyError, networkError } from './errors.js';

/**
 * Cross-process lock to prevent two blacklist writers from running simultaneously.
 *
 * Replaces `flock -n` in wlmac.sh. Used by CLI, scheduler, and Express,
 * so cron's `schedule:run` won't race with HTTP requests or manual CLI runs.
 */
export class Lock {
  constructor({ stateDir, staleMs = 120000, logger }) {
    this.targetDir = stateDir;
    this.staleMs = staleMs;
    this.logger = logger;
    // proper-lockfile mengunci FILE, jadi arahkan ke file sentral agar semua
    // entrypoint berebut lock yang sama.
    this.lockfile = path.join(stateDir, 'wifictl.lock');
  }

  #ensureFile() {
    fs.mkdirSync(this.targetDir, { recursive: true });
    if (!fs.existsSync(this.lockfile)) fs.writeFileSync(this.lockfile, '');
  }

  #acquire() {
    this.#ensureFile();
    return plock
      .lock(this.lockfile, {
        stale: this.staleMs,
        update: Math.max(1000, Math.floor(this.staleMs / 4)),
        retries: { retries: 0 },
      })
      .catch((err) => {
        if (err.code === 'ELOCKED') {
          throw new LockBusyError('Another wifictl instance is running. Skipping.');
        }
        throw networkError(`Cannot lock ${this.lockfile}: ${err.message}`, { cause: err });
      });
  }

/** Run `fn` while holding the lock, release even if `fn` throws. */
  async withLock(fn) {
    const release = await this.#acquire();
    try {
      return await fn();
    } finally {
      try {
        await plock.unlock(this.lockfile);
      } catch (err) {
        this.logger?.warn(`Gagal lepas lock: ${err.message}`);
      }
    }
  }
}
