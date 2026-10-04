import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from './helpers.mjs';

// Tailwind hanya menghasilkan class yang benar-benar dipakai. Kalau ada class
// salah tulis di HTML, dashboard akan tampil tanpa styling dan tidak ada error
// sama sekali. Test ini menutup lubang itu.

const html = fs.readFileSync(path.join(ROOT, 'src', 'views', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src', 'views', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'tailwind.css'), 'utf8');

/** Kumpulkan nama class dari atribut class="..." dan className = '...'. */
function classesFrom(source) {
  const found = new Set();
  for (const m of source.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) found.add(c);
  }
  // Class yang disisipkan dari JS (tombol di dalam tabel).
  for (const m of source.matchAll(/className = '([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c) found.add(c);
  }
  return found;
}

/**
 * Nama-nama class selector yang benar-benar ada di CSS.
 *
 * CSS meloloskan karakter khusus di dalam nama (`gap-1\.5`, `lg\:grid-cols-4`,
 * `bg-bad\/15`), jadi dibalik dulu sebelum dibandingkan. `:` dan `)` sengaja
 * tidak ikut karena dalam selector minified keduanya pemisah
 * (pseudo-class, `calc(var(...))`) — bukan bagian nama class.
 */
function builtClasses() {
  const names = new Set();
  for (const m of css.matchAll(/\.((?:\\.|[^\s{},>+~:()[\];])+)/g)) {
    names.add(m[1].replace(/\\(.)/g, '$1'));
  }
  return names;
}

describe('build Tailwind', () => {
  it('public/tailwind.css ada dan tidak kosong', () => {
    assert.ok(css.length > 2000, 'CSS kosong? jalankan `npm run build:css`');
  });

  it('utility kustom & tema warna ikut ter-build', () => {
    const built = builtClasses();
    for (const selector of ['card', 'card-title', 'btn-primary', 'btn-danger', 'btn-ghost', 'field', 'badge', 'th', 'td']) {
      assert.ok(built.has(selector), `.${selector} hilang dari CSS — @source tidak mencakup views/`);
    }
    for (const token of ['--color-ok', '--color-warn', '--color-bad']) {
      assert.ok(css.includes(token), `${token} hilang dari CSS`);
    }
  });

  it('setiap class yang dipakai di HTML/JS benar-benar ada di CSS', () => {
    const built = builtClasses();
    const used = [...new Set([...classesFrom(html), ...classesFrom(appJs)])];

    const missing = used.filter((name) => {
      // Nama variabel/id HTML (id, nama input) bukan class.
      if (name.startsWith('#')) return false;
      return !built.has(name);
    });

    assert.deepEqual(missing, [], `class tidak ter-build: ${missing.join(', ')}`);
  });

  it('halaman memuat CSS dan JS dari path yang memang dilayani server', () => {
    assert.match(html, /href="\/tailwind\.css"/);
    assert.match(html, /src="\/assets\/app\.js"/);
  });

  it('app.js tidak menyisipkan HTML mentah (data perangkat = input tak dipercaya)', () => {
    assert.doesNotMatch(appJs, /innerHTML/, 'pakai textContent');
    assert.doesNotMatch(appJs, /insertAdjacentHTML/, 'pakai textContent');
  });

  it('dashboard tidak memuat script dari CDN', () => {
    // Server ini bisa jalan di jaringan tanpa internet; semua asset harus lokal.
    assert.doesNotMatch(html, /https?:\/\/(cdn|unpkg|cdnjs)/i);
  });
});
