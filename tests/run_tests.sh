#!/usr/bin/env bash
#
# run_tests.sh — uji wlmac.sh terhadap mock API (tidak menyentuh AP nyata).
#
# Jalankan:  ./tests/run_tests.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WLMAC="$ROOT/wlmac.sh"
MOCK="$HERE/mock_router.py"

PW="test123"
WORK="$(mktemp -d)"
MOCK_PID=""

PORT_FILE="$WORK/port"
PORT=0   # 0 = biarkan OS memilih port bebas (hindari race reuse-port)

PASS=0
FAIL=0

cleanup() {
    [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

start_mock() {
    # start_mock <seed_json> [ENV=VAL ...]
    local seed="$1"; shift
    [[ -n "$MOCK_PID" ]] && {
        kill "$MOCK_PID" 2>/dev/null
        wait "$MOCK_PID" 2>/dev/null
        MOCK_PID=""
    }
    rm -f "$PORT_FILE"
    # env dipakai eksplisit: assignment dari "$@" TIDAK bisa diproses sebagai
    # env-prefix oleh bash (diperlakukan sebagai argumen perintah).
    env MOCK_SEED="$seed" MOCK_PASSWORD="$PW" MOCK_PORT_FILE="$PORT_FILE" "$@" \
        python3 "$MOCK" 0 >"$WORK/mock.log" 2>&1 &
    MOCK_PID=$!

    for _ in $(seq 1 60); do
        if [[ -s "$PORT_FILE" ]]; then
            PORT="$(cat "$PORT_FILE")"
            if python3 -c "
import socket,sys
s=socket.socket(); s.settimeout(0.3)
sys.exit(0 if s.connect_ex(('127.0.0.1',$PORT))==0 else 1)"; then
                return 0
            fi
        fi
        sleep 0.1
    done
    echo "Gagal menyalakan mock server" >&2
    cat "$WORK/mock.log" >&2
    exit 1
}

run_wlmac() {   # run_wlmac <state_dir> <args...>
    local sd="$1"; shift
    env AP_HOST="127.0.0.1:$PORT" ADMIN_PASS="$PW" STATE_DIR="$sd" \
        CURL_TIMEOUT=5 "$WLMAC" "$@" 2>&1
}

check() {       # check <nama> <exit_aktual> <exit_harapan> [output] [harus_memuat]
    local name="$1" got="$2" want="$3" out="${4:-}" needle="${5:-}"
    local ok=1
    [[ "$got" == "$want" ]] || ok=0
    if [[ -n "$needle" ]] && [[ "$out" != *"$needle"* ]]; then ok=0; fi
    if [[ "$ok" -eq 1 ]]; then
        printf '  \033[32mPASS\033[0m %s\n' "$name"; PASS=$((PASS+1))
    else
        printf '  \033[31mFAIL\033[0m %s (exit %s, harap %s)\n' "$name" "$got" "$want"
        [[ -n "$out" ]] && printf '        output: %s\n' "${out//$'\n'/ | }"
        FAIL=$((FAIL+1))
    fi
}

printf '\n=== 1. Autentikasi ===\n'
echo '[{"mac":"aa:bb:cc:dd:ee:ff"}]' >"$WORK/seed.json"
start_mock "$WORK/seed.json"
out="$(run_wlmac "$WORK/s1" login-test)"; check "login password benar" "$?" 0 "$out" "Login berhasil"
out="$(env AP_HOST="127.0.0.1:$PORT" ADMIN_PASS=salah STATE_DIR="$WORK/s1" "$WLMAC" login-test 2>&1)"
check "login password salah -> exit 3" "$?" 3 "$out" "password error"

printf '\n=== 2. Validasi input ===\n'
out="$(run_wlmac "$WORK/s1" block)"; check "block tanpa argumen" "$?" 2 "$out"
out="$(run_wlmac "$WORK/s1" block bukan-mac)"; check "MAC tidak valid" "$?" 2 "$out" "tidak valid"
out="$(run_wlmac "$WORK/s1" block aa:bb:cc:dd:ee:ff 11-22-33-44-55-66 112233445566 --dry-run)"
check "dry-run block 3 format MAC" "$?" 0 "$out" "dry-run"
n="$(grep -c 'BLOCK' "$WORK/mock.log")"
[[ "$n" == "0" ]] && { printf '  \033[32mPASS\033[0m dry-run tidak menulis ke AP\n'; PASS=$((PASS+1)); } \
                  || { printf '  \033[31mFAIL\033[0m dry-run menulis %s kali\n' "$n"; FAIL=$((FAIL+1)); }

printf '\n=== 3. block / unblock ===\n'
start_mock "$WORK/seed.json"
out="$(run_wlmac "$WORK/s2" block de:ad:be:ef:00:01)"; check "block MAC baru" "$?" 0 "$out" "OK blokir"
out="$(run_wlmac "$WORK/s2" list)"; check "MAC baru muncul di list" "$?" 0 "$out" "de:ad:be:ef:00:01"
out="$(run_wlmac "$WORK/s2" unblock de:ad:be:ef:00:01)"; check "unblock MAC" "$?" 0 "$out" "OK lepas-blokir"
out="$(run_wlmac "$WORK/s2" list)"; check "MAC hilang dari list" "$?" 0 "$out" "Total: 1"

printf '\n=== 4. sync (rekonsiliasi desired-state) ===\n'
echo '[{"mac":"aa:bb:cc:dd:ee:ff"},{"mac":"11:22:33:44:55:66"},{"mac":"99:88:77:66:55:44"}]' >"$WORK/seed2.json"
start_mock "$WORK/seed2.json"
# desired: aa:bb:cc:dd:ee:ff (sudah diblokir) + 00:11:22:33:44:55 (baru)
printf '# daftar\nAA-BB-CC-DD-EE-FF\n\n00:11:22:33:44:55\n' >"$WORK/want.txt"

out="$(run_wlmac "$WORK/s3" sync "$WORK/want.txt")"
check "sync pass 1" "$?" 0 "$out" "Ditambah: 1, dilepas: 2"
[[ "$out" == *"OK blokir 00:11:22:33:44:55"* ]] \
    && { printf '  \033[32mPASS\033[0m sync memblokir MAC baru\n'; PASS=$((PASS+1)); } \
    || { printf '  \033[31mFAIL\033[0m sync tidak memblokir MAC baru\n'; FAIL=$((FAIL+1)); }
[[ "$out" == *"OK lepas-blokir 11:22:33:44:55:66"* ]] \
    && { printf '  \033[32mPASS\033[0m sync melepas MAC tak di file\n'; PASS=$((PASS+1)); } \
    || { printf '  \033[31mFAIL\033[0m sync tidak melepas MAC tak di file\n'; FAIL=$((FAIL+1)); }

out="$(run_wlmac "$WORK/s3" sync "$WORK/want.txt")"
check "sync pass 2 idempoten" "$?" 0 "$out" "Ditambah: 0, dilepas: 0"

out="$(run_wlmac "$WORK/s3" list)"
[[ "$out" == *aa:bb:cc:dd:ee:ff* && "$out" == *00:11:22:33:44:55* && "$out" != *11:22:33:44:55:66* ]] \
    && { printf '  \033[32mPASS\033[0m blacklist akhir sesuai desires\n'; PASS=$((PASS+1)); } \
    || { printf '  \033[31mFAIL\033[0m blacklist akhir salah: %s\n' "${out//$'\n'/ | }"; FAIL=$((FAIL+1)); }

printf '\n=== 5. clients ===\n'
out="$(run_wlmac "$WORK/s3" clients)"
check "clients" "$?" 0 "$out" "LAPTOP-1"

printf '\n=== 6. Guard format data ===\n'
start_mock "$WORK/seed2.json" MOCK_MALFORMED=1
out="$(run_wlmac "$WORK/s4" list)"
check "list gagal keras saat .list bukan array" "$?" 5 "$out" "format API berubah"
out="$(run_wlmac "$WORK/s4" sync "$WORK/want.txt")"
check "sync gagal keras, bukan diam-diam" "$?" 5 "$out" "format API berubah"

printf '\n=== 7. AP tak terjangkau ===\n'
out="$(env AP_HOST=127.0.0.1:1 ADMIN_PASS=x STATE_DIR="$WORK/s5" CURL_TIMEOUT=2 "$WLMAC" login-test 2>&1)"
check "timeout / TCP gagal -> exit 4" "$?" 4 "$out" "Tidak bisa menghubungi"

printf '\n=== 8. Pemisahan stdout/stderr ===\n'
# Regression: log() pernah menulis ke stdout, sehingga pesan "Login berhasil"
# tercampur ke daftar MAC dan sync sempat mengirim MAC kosong ke AP.
# Stdout HARUS berisi data saja, tanpa pesan log.
start_mock "$WORK/seed2.json"
only_out="$(env AP_HOST="127.0.0.1:$PORT" ADMIN_PASS="$PW" STATE_DIR="$WORK/s8" \
              CURL_TIMEOUT=5 "$WLMAC" list 2>/dev/null)"
rc=$?
check "list ke stdout tetap exit 0" "$rc" 0 "$only_out"
[[ "$only_out" != *"Login berhasil"* ]] \
    && { printf '  \033[32mPASS\033[0m stdout bersih dari pesan log\n'; PASS=$((PASS+1)); } \
    || { printf '  \033[31mFAIL\033[0m stdout tercemar log: %s\n' "${only_out//$'\n'/ | }"; FAIL=$((FAIL+1)); }
[[ "$only_out" == *"aa:bb:cc:dd:ee:ff"* ]] \
    && { printf '  \033[32mPASS\033[0m stdout berisi data MAC\n'; PASS=$((PASS+1)); } \
    || { printf '  \033[31mFAIL\033[0m stdout tidak berisi data MAC\n'; FAIL=$((FAIL+1)); }

printf '\n=== 9. Locking (aman untuk cron) ===\n'
mkdir -p "$WORK/s9"
: >"$WORK/s9/wlmac.lock"
flock -x "$WORK/s9/wlmac.lock" -c 'sleep 2' &
HOLDER=$!
sleep 0.6
out="$(run_wlmac "$WORK/s9" list 2>&1)"
check "instansi kedua ditolak -> exit 6" "$?" 6 "$out" "sedang berjalan"
# Jangan kill wrapper flock: child 'sleep' mewarisi fd lock, jadi lock tetap
# tertahan sampai child itu selesai. Tunggu saja.
wait "$HOLDER" 2>/dev/null
out="$(run_wlmac "$WORK/s9" list 2>&1)"
check "lock dilepas, jalan lagi" "$?" 0 "$out"

printf '\n========================================\n'
printf '  Lulus: %s   Gagal: %s\n' "$PASS" "$FAIL"
printf '========================================\n\n'
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0