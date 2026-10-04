import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeMac } from './blacklist.js';
import { usageError } from './errors.js';

/**
 * Time-based blacklist rules.
 *
 * `blacklist.txt` always applies. Rules here apply ONLY during their time
 * windows, so `sync` must treat both as a single desired state:
 * `permanent ∪ currently active rules`. Otherwise, `blacklist-sync` would
 * unblock MACs currently blocked by rules.
 *
 * File shape (ALL required so typos are caught, not ignored):
 *
 *   {
 *     "rules": [{
 *       "id": "break",                   // optional; auto-generated if empty
 *       "name": "Break time",            // required, display only
 *       "macs": ["aa:bb:cc:dd:ee:ff"],   // required
 *       "enabled": true,                 // optional, default true
 *       "windows": [                     // required (or use start/end at rule level)
 *         { "start": "12:00", "end": "13:00" },
 *         { "start": "17:30", "end": "18:30", "days": ["mon","tue"] }
 *       ]
 *     }]
 *   }
 *
 * Window semantics:
 *   - `[start, end)` — starts at start inclusive, ends at end exclusive.
 *   - `start > end` = crosses midnight (23:00-01:00).
 *   - `end` may be "24:00" (= midnight).
 *   - `days` optional = days rule applies, 0=Sun..6=Sat or sun..sat.
 *     For midnight-crossing windows, `days` refers to the day the window STARTS,
 *     so "sat 23:00-02:00" is also active Sunday 01:00.
 *   - `start === end` REJECTED. Use "00:00-24:00" for all day.
 *
 * Timezone: local machine time, or `RULES_TZ` if set.
 */

/** 0 = Sunday, per Date#getDay(). */
export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MINUTES_PER_DAY = 1440;

/** "9:05" / "09:05" -> 545. "24:00" only valid as `end`. */
function parseClock(value, { allow24, where }) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(value).trim());
  if (!m) throw usageError(`${where}: time must be HH:MM format, got "${value}"`);

  const h = Number(m[1]);
  const min = Number(m[2]);

  if (h === 24 && min === 0 && allow24) return MINUTES_PER_DAY;
  if (h > 23) throw usageError(`${where}: hour ${h} invalid (max 23, or 24:00 for midnight)`);
  return h * 60 + min;
}

function parseDays(value, where) {
  if (value === undefined || value === null) return null;

  const list = Array.isArray(value) ? value : [value];
  const days = new Set();

  for (const raw of list) {
    const token = String(raw).trim().toLowerCase();
    if (/^[0-6]$/.test(token)) {
      days.add(Number(token));
      continue;
    }
    const asName = DAY_NAMES.indexOf(token);
    if (asName >= 0) {
      days.add(asName);
      continue;
    }
    throw usageError(`${where}: day "${raw}" unknown (use 0-6 or ${DAY_NAMES.join('/')})`);
  }

  if (days.size === 0) throw usageError(`${where}: days cannot be empty`);
  return [...days].sort((a, b) => a - b);
}

function parseWindow(raw, where) {
  if (raw === null || typeof raw !== 'object') {
    throw usageError(`${where}: window harus objek { "start": "12:00", "end": "13:00" }`);
  }

  const start = parseClock(raw.start, { allow24: false, where: `${where}.start` });
  const end = parseClock(raw.end, { allow24: true, where: `${where}.end` });
  const days = parseDays(raw.days, `${where}.days`);

  if (start === end) {
    throw usageError(`${where}: start dan end sama (${raw.start}) — tulis "00:00"-"24:00" untuk sepanjang hari`);
  }

  return {
    start,
    end,
    days,
    overnight: start > end,
    label: `${raw.start}-${raw.end}`,
  };
}

function parseMacs(raw, where) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw usageError(`${where}: macs required and cannot be empty`);
  }

  const macs = [];
  for (const item of raw) {
    const mac = normalizeMac(item);
    if (!mac) throw usageError(`${where}: Invalid MAC: "${item}"`);
    if (!macs.includes(mac)) macs.push(mac);
  }
  return macs;
}

/** Slug stabil untuk `id`: dari nama, huruf kecil, tanpa spasi aneh. */
function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'rule'
  );
}

/**
 * Parse rules.json. Gagal keras pada apa pun yang ambigu — melihatkan rule
 * berisi `enabled: false` lebih baik daripada memblokir perangkat pada jam
 * yang salah karena typo.
 */
export function parseRules(text, { where = 'rules.json' } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw usageError(`${where}: invalid JSON — ${err.message}`);
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw usageError(`${where}: file must be object { "rules": [...] }`);
  }
  if (doc.rules === undefined) throw usageError(`${where}: field "rules" missing`);
  if (!Array.isArray(doc.rules)) throw usageError(`${where}: "rules" must be array`);

  const seenIds = new Set();
  const rules = doc.rules.map((raw, i) => {
    const at = `${where}.rules[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw usageError(`${at}: must be object`);
    }

    const name = String(raw.name ?? '').trim();
    if (name === '') throw usageError(`${at}: "name" required`);

    // Bentuk ringkas: start/end di level rule berarti satu window.
    const rawWindows = raw.windows ?? (raw.start !== undefined || raw.end !== undefined
      ? [{ start: raw.start, end: raw.end, days: raw.days }]
      : undefined);

    if (!Array.isArray(rawWindows) || rawWindows.length === 0) {
      throw usageError(`${at} ("${name}"): "windows" required, at least one`);
    }

    let id = String(raw.id ?? '').trim() || slugify(name);
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    seenIds.add(id);

    return {
      id,
      name,
      macs: parseMacs(raw.macs, `${at} ("${name}")`),
      enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
      windows: rawWindows.map((w, j) => parseWindow(w, `${at} ("${name}").windows[${j}]`)),
    };
  });

  return { rules };
}

export async function readRules(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rules: [], missing: true };
    throw usageError(`Cannot read file: ${file} (${err.message})`);
  }
  return { ...parseRules(text, { where: path.basename(file) }), missing: false };
}

/** Zone name for display; empty string means system time. */
export function zoneLabel(timeZone) {
  return timeZone || '(system time)';
}

/** "2026-10-04 12:30" dalam zona yang dipakai rules — untuk tampilan. */
export function formatWhen(date, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Tanggal yang dipakai untuk menghitung "hari ini", dalam zona rules. */
function nowInZone(now, timeZone) {
  if (!timeZone) return now;

  // Format tanggal+jam di zona target, lalu parsing ulang sebagai waktu lokal
  // supaya seluruh aritmetika berjalan di satu zona tanpa pustaka eksternal.
  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  const [date, clock = '00:00:00'] = shown.split(', ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = clock.split(':').map(Number);
  return new Date(y, m - 1, d, hh % 24, mm, ss);
}

/**
 * Apakah `window` sedang aktif pada `now`.
 *
 * `@param now` Date; `@param window` hasil parseWindow.
 */
export function isWindowActive(window, now) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();

  if (!window.overnight) {
    if (minutes < window.start || minutes >= window.end) return false;
    return !window.days || window.days.includes(today);
  }

  // Melewati tengah malam: dua segmen, dan `days` selalu menunjuk ke hari
  // saat jendela dimulai.
  if (minutes >= window.start) {
    return !window.days || window.days.includes(today);
  }
  if (minutes < window.end) {
    const startedYesterday = (today + 6) % 7;
    return !window.days || window.days.includes(startedYesterday);
  }
  return false;
}

export function isRuleActive(rule, now) {
  return rule.enabled && rule.windows.some((w) => isWindowActive(w, now));
}

/**
 * Rule yang sedang aktif + MAC yang akibatnya harus diblokir.
 *
 * `now` boleh di-inject supaya scheduler dan test bisa menguji jam tertentu
 * tanpa menunggu.
 */
export function evaluate(ruleset, { now = new Date(), timeZone } = {}) {
  const at = nowInZone(now, timeZone);
  const activeRules = ruleset.rules.filter((r) => isRuleActive(r, at));

  const macs = new Set();
  for (const rule of activeRules) {
    for (const mac of rule.macs) macs.add(mac);
  }

  return {
    now: at,
    timeZone: zoneLabel(timeZone),
    macs: [...macs].sort(),
    activeRules: activeRules.map((r) => ({
      id: r.id,
      name: r.name,
      windows: r.windows
        .filter((w) => isWindowActive(w, at))
        .map((w) => w.label),
    })),
    skippedRules: ruleset.rules.filter((r) => !r.enabled).map((r) => r.id),
  };
}

/**
 * Ubah `--at` jadi Date.
 *
 * `HH:MM` berarti hari ini di jam itu (zona sistem) — cukup untuk
 * "apakah rule 17:30-18:30 benar?" tanpa menunggu sampai jam 17:30.
 * Untuk menguji Across midnight atau zona lain, pakai timestamp lengkap.
 */
export function resolveNow(at) {
  if (at === undefined || at === null || at === '') return new Date();

  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(String(at).trim());
  if (clock) {
    const d = new Date();
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return d;
  }

  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    throw usageError(`Time "${at}" not understood — use HH:MM or "YYYY-MM-DDTHH:MM"`);
  }
  return parsed;
}

/** Rewrite rules.json with stable indentation for readable diffs. */
export async function writeRules(file, rules) {
  const body = `${JSON.stringify({ rules }, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
  return body;
}

/** Bentuk yang bisa diserialisasi (dipakai API + CLI --json). */
export function describe(ruleset, { now = new Date(), timeZone } = {}) {
  const at = nowInZone(now, timeZone);
  return {
    now: formatWhen(at, timeZone),
    timeZone: zoneLabel(timeZone),
    rules: ruleset.rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      macs: r.macs,
      active: isRuleActive(r, at),
      windows: r.windows.map((w) => ({
        start: w.label,
        days: w.days,
        overnight: w.overnight,
      })),
    })),
  };
}