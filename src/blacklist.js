import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, EXIT, usageError } from './errors.js';

/** Normalize aa:bb:cc:dd:ee:ff / aa-bb-... / aabbccddeeff -> aa:bb:cc:dd:ee:ff (lowercase). */
export function normalizeMac(raw) {
  const hex = String(raw).toLowerCase().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Parse blacklist file: one MAC per line, comments after '#' ignored,
 * empty lines ignored. Non-MAC lines returned in `invalid` for reporting,
 * not silently dropped.
 */
export function parseMacList(text) {
  const macs = [];
  const invalid = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0].replace(/\s+/g, '');
    if (line === '') continue;
    const mac = normalizeMac(line);
    if (mac) macs.push(mac);
    else invalid.push(line);
  }

  return { macs: [...new Set(macs)].sort(), invalid };
}

export async function readMacList(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw usageError(`File not found: ${file}`);
    throw usageError(`Cannot read file: ${file} (${err.message})`);
  }
  return parseMacList(text);
}

/**
 * Like `readMacList`, but missing file means "no permanent MACs yet" —
 * not an error. Used for default file which is normal to be empty on fresh install.
 */
export async function readMacListOrEmpty(file) {
  try {
    return await readMacList(file);
  } catch (err) {
    if (err instanceof AppError && err.code === EXIT.USAGE && /File not found/.test(err.message)) {
      return { macs: [], invalid: [], missing: true };
    }
    throw err;
  }
}

/**
 * Add MACs to permanent blacklist. Creates file if missing.
 * Existing MACs not rewritten; only new ones returned so caller can
 * report "3 requested, 1 already exists".
 */
export async function addMacList(file, macs) {
  const { macs: existing } = await readMacListOrEmpty(file);

  const have = new Set(existing);
  const added = [...new Set(macs)].filter((mac) => !have.has(mac)).sort();

  if (added.length > 0) {
    const next = [...existing, ...added].sort();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${next.join('\n')}\n`, 'utf8');
  }

  return { added, already: macs.filter((mac) => have.has(mac)), total: existing.length + added.length };
}

/**
 * Reconcile desired state: file is the single source of truth.
 *   in file but not blocked on AP      -> block
 *   blocked on AP but not in file      -> unblock
 *   otherwise                          -> leave as-is
 */
export function reconcile(want, current) {
  const wantSet = new Set(want);
  const currentSet = new Set(current);

  return {
    toBlock: want.filter((mac) => !currentSet.has(mac)),
    toUnblock: current.filter((mac) => !wantSet.has(mac)),
  };
}
