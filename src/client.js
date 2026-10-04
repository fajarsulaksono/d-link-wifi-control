import { CookieJar } from './cookies.js';
import { apiError, authError, networkError, usageError } from './errors.js';

const MISSING_PASS = 'GANTI_DENGAN_PASSWORD_AP';

/**
 * Read `.list` from AP response and ensure it has a sane shape.
 *
 * Firmware DIR-612F sends `{"list":{}}` — empty object, not array —
 * when no MACs are blocked (confirmed on 192.168.10.1, 2026-10-04).
 * The frontend just does `self.blackList = data.list`, so no other contract
 * is reliable. We interpret that as "empty"; anything else is treated as an
 * error so firmware changes don't silently slip through.
 */
function asRowList(data, endpoint) {
  const list = data?.list;

  if (Array.isArray(list)) return list.filter((e) => e && typeof e === 'object');

  const emptyObject =
    list !== null &&
    typeof list === 'object' &&
    !Array.isArray(list) &&
    Object.keys(list).length === 0;
  if (emptyObject) return [];

  const got = list === undefined ? '<none>' : Array.isArray(list) ? 'array' : typeof list;
  throw apiError(`${endpoint}: .list must be an array (got: ${got}) — API format changed?`);
}

/**
 * API client for "WL-Router" panel (D-Link DIR-612F).
 *
 * Endpoints were reverse-engineered from router frontend
 * (/routerweb/js/index.js) — see README, don't guess.
 *
 *   POST /login          {"username","password"} -> {"result":0} = success
 *   POST /deny_dev       {"mac","disabled"}      -> {"result":0}; 1=block 0=unblock
 *   GET  /deny_dev_list  -> {"list":[{"mac":...}]}
 *   GET  /associated_devs-> {"list":[{mac,ip,hostname,time}]}
 *
 * Important rules inherited from wlmac.sh:
 *   - Without a session, device responds with HTML (not JSON), not 401/403.
 *     So "non-JSON response" means "session lost", must trigger re-login,
 *     not be reported as format error.
 *   - .list MUST be an array. If shape changes, fail hard (exit 5)
 *     to avoid silently treating all MACs as blocked/unblocked.
 *
 * "Session lost" comes in TWO forms on this firmware (confirmed directly):
 *   1. Empty/unrecognized cookie -> 200 text/html, LuCI login page (starts with `<`)
 *   2. Cookie present but invalid/expired -> 500 text/plain:
 *        /usr/lib/lua/luci/sauth.lua:76: Security Exception: Session ID is invalid!
 *        /usr/lib/lua/luci/sauth.lua:87: Session data invalid!
 *     With Lua stack trace. Form #2 used to slip through: JSON.parse failed,
 *     body didn't start with `<`, so it fell to apiError (exit 5) and never retried login.
 */
/**
 * Tanda tangan halaman error LuCI. Dicocokkan ke 400 byte pertama saja:
 * stack traceback bisa panjang; yang penting path sauth.lua-nya.
 */
const LUCI_SESSION_ERROR = /\/usr\/lib\/lua\/luci\/sauth\.lua|Session data invalid|Security Exception/i;

export class RouterClient {
  #sessionOk = false;
  #loginPromise = null;
  #jar = new CookieJar();

  constructor({ apiBase, adminUser, adminPass, timeoutMs = 15000, logger, fetchImpl = fetch }) {
    this.apiBase = apiBase;
    this.adminUser = adminUser;
    this.adminPass = adminPass;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
  }

  get sessionOk() {
    return this.#sessionOk;
  }

  /**
   * @param {'json'|'sessionLost'|'unreachable'} htmlAs
   *  - respons non-JSON yang diawali `<` artinya berbeda tergantung konteks:
   *   - saat login  -> AP sedang reboot / IP berubah  => EXIT_NETWORK
   *   - saat aktif  -> sesi hilang                   => coba login ulang
   */
  async #request(method, path, body, { htmlAs = 'sessionLost' } = {}) {
    const url = `${this.apiBase}${path}`;
    const headers = { Accept: 'application/json' };
    const cookie = this.#jar.header();
    if (cookie) headers.Cookie = cookie;

    const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetch(url, init);
    } catch (err) {
      throw networkError(
        `Tidak bisa menghubungi AP ${this.apiBase} (timeout/TCP gagal): ${err.message}`,
        { cause: err },
      );
    }

    this.#jar.absorb(response);

    const text = await response.text().catch(() => '');
    if (text.trim() === '') {
      throw networkError(`Respons kosong dari ${method} ${path} (AP sedang reboot?)`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Perangkat membalas non-JSON dalam dua bentuk berbeda, dan KEDUA-nya
      // berarti "sesi hilang" — lihat docblock kelas ini. Bentuk HTML sudah
      // lama ditangani; bentuk 500 text/plain dari sauth.lua yang terlewat.
      const isHtml = text.trimStart().startsWith('<');
      const isLuciSessionError = !isHtml && LUCI_SESSION_ERROR.test(text.slice(0, 400));

      if (isHtml && htmlAs === 'unreachable') {
        throw networkError(
          `Respons ${method} ${path} bukan JSON — AP mungkin sedang reboot atau IP berubah`,
        );
      }

      if (isHtml || isLuciSessionError) {
        const asal = isLuciSessionError
          ? `dibalas ${response.status} error sauth.lua (sesi kedaluwarsa)`
          : 'dibalas HTML';
        const err = apiError(`Sesi tidak berlaku untuk ${method} ${path} (${asal})`);
        err.sessionLost = true;
        throw err;
      }

      throw apiError(`Respons ${method} ${path} bukan JSON: ${text.slice(0, 120)}`);
    }

    return data;
  }

  /** Login sekali. Promise dipakai bersama supaya request paralel tidak login 5 kali. */
  async login() {
    if (this.#loginPromise) return this.#loginPromise;

    this.#loginPromise = (async () => {
      if (!this.adminPass || this.adminPass === MISSING_PASS) {
        throw usageError(
          'Password AP belum diisi. Set ADMIN_PASS di .env atau environment.',
        );
      }

      this.#jar.clear();
      this.logger?.info(`Login ke ${this.apiBase} sebagai ${this.adminUser}...`);

      let data;
      try {
        data = await this.#request(
          'POST',
          '/login',
          { username: this.adminUser, password: this.adminPass },
          { htmlAs: 'unreachable' },
        );
      } catch (err) {
        this.#loginPromise = null;
        throw err;
      }

      if (String(data?.result) === '0') {
        this.#sessionOk = true;
        this.logger?.info('Login berhasil.');
        return;
      }

      this.#loginPromise = null;
      const msg = String(data?.msg ?? 'ditolak').replace(/\.$/, '');
      throw authError(`Login gagal (err=${data?.err ?? '?'}): ${msg} — periksa password AP.`);
    })();

    try {
      await this.#loginPromise;
    } finally {
      this.#loginPromise = null;
    }
  }

  /**
   * Jalankan operasi yang butuh sesi. Login otomatis bila belum, dan coba
   * login ulang SEKALI kalau perangkat membalas HTML (sesi kadaluwarsa di
   * tengah jalan — hal yang biasa di server yang hidup lama, tidak pernah di
   * wlmac.sh karena tiap proses selalu login baru).
   */
  async withSession(fn) {
    await this.login();
    try {
      return await fn();
    } catch (err) {
      if (!err.sessionLost) throw err;

      this.logger?.warn(`Sesi hilang (${err.message}), login ulang sekali...`);
      this.#sessionOk = false;
      await this.login();

      try {
        return await fn();
      } catch (retryErr) {
        // Sesi hilang dua kali berturut-turut setelah login yang benar-benar
        // baru = bukan sekadar kedaluwarsa. Kalau login-nya sendiri sukses,
        // ini biasanya AP sedang restart atau memblokir banyak sesi.
        if (!retryErr.sessionLost) throw retryErr;
        this.#sessionOk = false;
        throw authError(
          `Sesi ditolak dua kali berturut-turut setelah login berhasil — ${retryErr.message}. ` +
            'Coba lagi beberapa saat lagi; kalau tetap begitu, AP mungkin sedang restart.',
        );
      }
    }
  }

  /** Panggil /deny_dev <mac> <0|1>. Pada dry-run tidak ada request tulis sama sekali. */
  async setDeny(mac, disabled, verb, { dryRun = false } = {}) {
    if (dryRun) {
      this.logger?.info(`[dry-run] ${verb} ${mac}`);
      return { mac, action: verb, dryRun: true };
    }

    return this.withSession(async () => {
      let data;
      try {
        data = await this.#request('POST', '/deny_dev', { mac, disabled });
      } catch (err) {
        // sessionLost harus diteruskan apa adanya supaya withSession() bisa
        // login ulang; sisanya dibungkus konteks verb + MAC.
        if (err.sessionLost) throw err;
        throw networkError(`Failed to contact AP during ${verb} ${mac}`, { cause: err });
      }

      if (String(data?.result) === '0') {
        this.logger?.info(`OK ${verb} ${mac}`);
        return { mac, action: verb };
      }

      throw apiError(
        `Failed ${verb} ${mac}: result=${data?.result ?? 'absent'} msg=${data?.msg ?? 'unknown'}`,
      );
    });
  }

  /**
   * MACs currently blocked on AP.
   *
   * `.list` fails hard if shape is invalid, with one proven exception:
   * DIR-612F firmware sends `{"list":{}}` (empty object, not array) when no
   * MACs blocked. Treat as empty blacklist ([]).
   *
   * Other unknown shapes remain errors. If silently returned [], sync would
   * think all file MACs need re-blocking and all foreign AP MACs need unblocking.
   */
  async fetchBlacklist() {
    return this.withSession(async () => {
      const data = await this.#request('GET', '/deny_dev_list');
      const list = asRowList(data, '/deny_dev_list');

      return list
        .map((e) => String(e.mac ?? '').toLowerCase())
        .filter(Boolean);
    });
  }

  async fetchClients() {
    return this.withSession(async () => {
      const data = await this.#request('GET', '/associated_devs');
      return asRowList(data, '/associated_devs');
    });
  }
}
