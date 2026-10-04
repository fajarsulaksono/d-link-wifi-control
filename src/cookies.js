/**
 * Minimal cookie jar.
 *
 * Key behavior: doesn't care about cookie names. D-Link firmware uses `sysauth`,
 * others may use anything; just attach whatever server sends. Mimics curl -b/-c
 * behavior from wlmac.sh.
 *
 * Not persisted to disk. wlmac.sh clears cookie jar before login anyway,
 * so keeping it adds nothing — and storing expired sessions just adds failure points.
 */
export class CookieJar {
  #cookies = new Map();

  absorb(response) {
    // getSetCookie() mengembalikan semua header Set-Cookie terpisah; Headers
    // yang biasa menyatukannya dengan koma yang bisa merusak nilai.
    const raw =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);

    for (const line of raw) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();

      // Respect cookie deletion (Max-Age=0 / expired in past).
      const expired = attrs.some((a) => {
        const t = a.trim().toLowerCase();
        if (t.startsWith('max-age=')) return Number(t.slice(8)) <= 0;
        if (t.startsWith('expires=')) return new Date(t.slice(8)) <= new Date();
        return false;
      });

      if (value === '' || expired) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header() {
    if (this.#cookies.size === 0) return null;
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.#cookies.clear();
  }

  get size() {
    return this.#cookies.size;
  }
}
