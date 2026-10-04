import fs from 'node:fs';
import path from 'node:path';

/**
 * Logger without dependencies: writes to file (with rotation) and to stderr.
 *
 * IMPORTANT: never writes to stdout. Stdout is for DATA (list/clients results,
 * or --json) so callers can capture cleanly without noise. Old regression in
 * wlmac.sh: log() wrote to stdout, so "Login successful" mixed with MAC list
 * and sync could send empty MAC list to device.
 */
export class Logger {
  constructor({
    logFile,
    maxBytes = 1048576,
    maxFiles = 2,
    quiet = false,
    stream = process.stderr,
    toFile = true,
  }) {
    this.logFile = logFile;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.quiet = quiet;
    this.stream = stream;
    this.toFile = toFile;
  }

  #rotate() {
    try {
      if (fs.statSync(this.logFile).size < this.maxBytes) return;
    } catch {
      return; // file belum ada
    }
    // All renames checked first: ENOENT during rotation would prevent
    // moving main file, causing old log file to be lost silently.
    fs.rmSync(`${this.logFile}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      if (fs.existsSync(`${this.logFile}.${i}`)) {
        fs.renameSync(`${this.logFile}.${i}`, `${this.logFile}.${i + 1}`);
      }
    }
    fs.renameSync(this.logFile, `${this.logFile}.1`);
  }

  log(level, message) {
    const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${level}] ${message}`;

    try {
      if (this.toFile) {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        this.#rotate();
        fs.appendFileSync(this.logFile, `${line}\n`);
      }
    } catch {
      // Log tidak boleh menggagalkan operasi: AP mungkin butuh diakses
      // sementara filesystem sedang read-only.
    }

    if (!this.quiet) this.stream.write(`${message}\n`);
    return line;
  }

  info(msg) {
    return this.log('INFO', msg);
  }

  warn(msg) {
    return this.log('WARN', msg);
  }

  error(msg) {
    return this.log('ERROR', msg);
  }
}
