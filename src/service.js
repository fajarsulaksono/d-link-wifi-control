import { readMacList, readMacListOrEmpty, normalizeMac, reconcile, addMacList } from './blacklist.js';
import { RouterClient } from './client.js';
import { evaluate, readRules } from './rules.js';
import { Lock } from './lock.js';
import { usageError } from './errors.js';

/**
 * Operation layer: the only place knowing order (read state -> compute diff -> write).
 * CLI, scheduler, and Express all call this so behavior stays consistent.
 *
 * All methods return DATA, not print. Printing is CLI's responsibility;
 * keeps stdout clean and HTTP endpoints can serialize results.
 */
export class Service {
  constructor({ config, logger, client, lock }) {
    this.config = config;
    this.logger = logger;
    this.client = client ?? new RouterClient({
      apiBase: config.apiBase,
      adminUser: config.adminUser,
      adminPass: config.adminPass,
      timeoutMs: config.httpTimeoutMs,
      logger,
    });
    this.lock = lock ?? new Lock({
      stateDir: config.stateDir,
      staleMs: config.lockStaleMs,
      logger,
    });
  }

  /** Convert input list to canonical MACs; fail hard if any invalid. */
  #parseInput(input) {
    const macs = [];
    const bad = [];
    for (const raw of input) {
      const mac = normalizeMac(raw);
      if (mac) macs.push(mac);
      else bad.push(String(raw));
    }
    if (bad.length > 0) {
      throw usageError(`Invalid MAC: ${bad.join(', ')}`);
    }
    const unique = [...new Set(macs)];
    if (unique.length === 0) throw usageError('No valid MACs to process');
    return unique;
  }

  async loginTest() {
    await this.client.login();
    return { ok: true, host: this.config.apHost, user: this.config.adminUser };
  }

  async list() {
    const macs = await this.client.fetchBlacklist();
    return { macs, count: macs.length };
  }

  async clients() {
    const list = await this.client.fetchClients();
    return {
      clients: list.map((e) => ({
        mac: e.mac ?? null,
        ip: e.ip ?? null,
        hostname: e.hostname ?? null,
        upSeconds: e.time ?? null,
        downLimit: e.down_limit ?? null,
        upLimit: e.up_limit ?? null,
        downSpeed: e.down_speed ?? null,
        upSpeed: e.up_speed ?? null,
      })),
      count: list.length,
    };
  }

  async clientLimit(mac, { downLimit, upLimit, dryRun } = {}) {
    const macs = this.#parseInput([mac]);
    const result = await this.client.setSpeedLimit(macs[0], {
      downLimit,
      upLimit,
      dryRun: Boolean(dryRun),
    });
    return result;
  }

  /** Hold lock during write operations to avoid undoing each other. */
  async #withWriteLock(fn) {
    return this.lock.withLock(fn);
  }

  /**
   * `permanent: true` writes MACs to `blacklist.txt` first, then blocks on AP.
   * Without it, block lasts only until next sync/rules-apply because both force
   * desired state = permanent file ∪ active rules.
   *
   * File written before touching AP: if process dies mid-way, MAC remains blocked
   * on next sync.
   */
  async block(input, { dryRun = false, permanent = false } = {}) {
    const macs = this.#parseInput(input);
    return this.#withWriteLock(async () => {
      let saved = null;
      if (permanent && !dryRun) {
        saved = await addMacList(this.config.blacklistFile, macs);
        this.logger?.info(
          `Marked permanent: ${saved.added.length} new${saved.already.length ? `, ${saved.already.length} already` : ''} -> ${this.config.blacklistFile}`,
        );
      }

      const done = [];
      for (const mac of macs) {
        await this.client.setDeny(mac, 1, 'block', { dryRun });
        done.push(mac);
      }
      return {
        action: 'block',
        permanent,
        requested: macs.length,
        macs: done,
        dryRun,
        ...(permanent ? { savedTo: this.config.blacklistFile, added: saved?.added ?? [], already: saved?.already ?? [] } : {}),
      };
    });
  }

  async unblock(input, { dryRun = false } = {}) {
    const macs = this.#parseInput(input);
    return this.#withWriteLock(async () => {
      const done = [];
      for (const mac of macs) {
        await this.client.setDeny(mac, 0, 'unblock', { dryRun });
        done.push(mac);
      }
      return { action: 'unblock', requested: macs.length, macs: done, dryRun };
    });
  }

  /** Currently active rules. Missing file = no rules. */
  async activeRules({ now } = {}) {
    if (!this.config.rulesEnabled) return { macs: [], activeRules: [], skippedRules: [] };

    const ruleset = await readRules(this.config.rulesFile);
    return evaluate(ruleset, { now, timeZone: this.config.rulesTz });
  }

  /**
   * Reconcile AP blacklist with desired state.
   *
   * Desired state = `blacklist.txt` (permanent) ∪ currently active rules.
   * Both must be combined in one diff: if `blacklist-sync` only knew about
   * permanent file, it would unblock MACs currently blocked by `rules-apply`
   * in the next minute.
   */
  async sync({ file = this.config.blacklistFile, dryRun = false, now } = {}) {
    // File default yang belum ada = "belum ada MAC permanen", bukan error —
    // sync ini jalan tiap menit, jadi harus tetap berhasil di instalasi baru.
    // Path yang diminta user secara eksplisit tetap error kalau tidak ada,
    // karena itu hampir pasti salah ketik.
    const isDefault = file === this.config.blacklistFile;
    const { macs: permanent, invalid, missing } = isDefault
      ? await readMacListOrEmpty(file)
      : await readMacList(file);

    if (missing) this.logger?.info(`No ${file} yet — treating as no permanent MACs.`);
    for (const line of invalid) {
      this.logger?.warn(`Skipping invalid line (not a MAC): ${line}`);
    }

    const rules = await this.activeRules({ now });
    const want = [...new Set([...permanent, ...rules.macs])];

    if (rules.activeRules.length > 0) {
      this.logger?.info(
        `Rule aktif: ${rules.activeRules.map((r) => `${r.name} [${r.windows.join(', ')}]`).join('; ')}`,
      );
    }

    // fetchBlacklist gagal keras kalau bentuk .list tidak dikenal — itu
    // disengaja, supaya sync tidak melanjutkan dengan state kosong dan
    // mengarang diff yang akan melepas semua blokir.
    const current = await this.client.fetchBlacklist();

    const { toBlock, toUnblock } = reconcile(want, current);

    this.logger?.info(
        `Sync: ${want.length} MACs requested to block (${permanent.length} permanent` +
          `${rules.macs.length ? ` + ${rules.macs.length} from rules` : ''}), ` +
          `${current.length} MACs blocked on AP. ` +
          `Will add: ${toBlock.length}, remove: ${toUnblock.length}.`,
      );

    return this.#withWriteLock(async () => {
      const blocked = [];
      const unblocked = [];
      for (const mac of toBlock) {
        await this.client.setDeny(mac, 1, 'block', { dryRun });
        blocked.push(mac);
      }
      for (const mac of toUnblock) {
        await this.client.setDeny(mac, 0, 'unblock', { dryRun });
        unblocked.push(mac);
      }

      return {
        file,
        rulesFile: this.config.rulesFile,
        dryRun,
        want: want.length,
        permanent: permanent.length,
        fromRules: rules.macs,
        activeRules: rules.activeRules,
        currentBefore: current.length,
        blocked,
        unblocked,
        unchanged: want.length - blocked.length,
        invalidLines: invalid,
      };
    });
  }
}
