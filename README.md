# wifictl — Automate MAC Blacklisting on D-Link DIR-612F Access Point

Node.js + Express.js. A single cron command (`schedule:run`) executes all scheduled tasks, plus a web dashboard built with TailwindCSS.

```bash
npm install
cp .env.example .env      # fill in ADMIN_PASS
npm start                 # dashboard at http://127.0.0.1:8080
```

## Documented Device

The URL `http://192.168.10.1/cgi-bin/luci` is **not** the original LuCI. The router serves a custom SPA called "WL-Router" (Vue + ElementUI + axios) under the path `/cgi-bin/luci`. Slightly ambiguous, but not an issue.

| Item | Value |
|---|---|
| Model | DIR-612F (D-Link, 2022) |
| Base API | `http://192.168.10.1/cgi-bin/luci/admin/routerweb` |
| User | `CMCCAdmin` (hard-coded in frontend; UI only asks for password) |
| Session | Cookies from server (`Set-Cookie` on successful login) |

### Endpoints Used

| Method | Path | Body / Result |
|---|---|---|
| POST | `/login` | `{"username","password"}` → `{"result":0}` success, `{"result":1,"err":1}` wrong password |
| POST | `/deny_dev` | `{"mac":"AA:BB:CC:DD:EE:FF","disabled":1}` → `{"result":0}`. `disabled:1` = block, `0` = unblock |
| GET | `/deny_dev_list` | → `{"list":[{"mac":"..."}]}`. When empty, firmware sends `{"list":{}}` — empty object, not `[]` |
| GET | `/associated_devs` | → `{"list":[{"mac","ip","hostname","time"}]}` |

These were discovered by reading `/routerweb/js/index.js` (functions `submitForm` and `setBlack`), not by guessing.

The HTTP client uses its own cookie jar, so there's no need to know the cookie name used by the firmware — it automatically follows name changes. Login is only retried if the AP responds with HTML (session lost), followed by a single retry attempt.

## Installation

```bash
git clone <repo> wifi-control && cd wifi-control
npm install
npm run build:css
```

1. Set the AP admin password:

   ```bash
   cp .env.example .env
   $EDITOR .env                   # fill in ADMIN_PASS
   ```

   `.env` is already in `.gitignore`. Never commit it.

2. Test login:

   ```bash
   node src/cli.js login-test
   ```

## Configuration

All configuration is read from environment variables, and `.env` is loaded into the environment at startup. Precedence: **defaults < `.env` < environment**.

- Variables already set in the environment **are not overridden** by `.env`, so `ADMIN_PASS=x npm start` or `STATE_DIR=/tmp npm test` still work.
- An empty value (`STATE_DIR=`) means "use default".
- Lines without `=` are silently ignored. If `ADMIN_PASS` is misspelled, it exits with code 2 and message `AP password not set`.
- If `.env` doesn't exist, it's not an error — all values can come from the environment.

| Key | Default | Description |
|---|---|---|
| `apHost` / `AP_HOST` | `192.168.10.1` | Can use `host:port` for mocks |
| `adminUser` / `ADMIN_USER` | `CMCCAdmin` | |
| `adminPass` / `ADMIN_PASS` | `""` | Required; empty → exit 2 |
| `stateDir` / `STATE_DIR` | `~/.local/state/wifictl` | Lock, scheduler state, logs |
| `logFile` / `LOG_FILE` | `<stateDir>/wifictl.log` | |
| `logMaxBytes` / `LOG_MAX_BYTES` | `1048576` | Rotate when file exceeds this size |
| `logMaxFiles` / `LOG_MAX_FILES` | `2` | `log`, `log.1` |
| `blacklistFile` / `BLACKLIST_FILE` | `./blacklist.txt` | Single source of truth for `sync` |
| `rulesFile` / `RULES_FILE` | `./rules.json` | Time-based blacklist rules |
| `rulesTz` / `RULES_TZ` | `""` (system time) | Timezone for evaluating rules |
| `rulesEnabled` / `RULES_ENABLED` | `true` | |
| `rulesCron` / `RULES_CRON` | `* * * * *` | Schedule for rules-apply task |
| `syncCron` / `SYNC_CRON` | `*/30 * * * *` | Schedule for sync task |
| `auditCron` / `AUDIT_CRON` | `5 * * * *` | Schedule for audit task |
| `syncEnabled`, `auditEnabled` | `true` | |
| `lockStaleMs` / `LOCK_STALE_MS` | `120000` | Minimum duration for a sync |
| `httpTimeoutMs` / `HTTP_TIMEOUT_MS` | `15000` | |
| `host` / `HOST` | `127.0.0.1` | Dashboard bind address |
| `port` / `PORT` | `8080` | |
| `apiToken` / `API_TOKEN` | `""` | Required if host is not loopback |
| `WIFI_CTL_ENV_FILE` | `./.env` | Alternative path to `.env` file |

## Commands

```
node src/cli.js <command> [arguments...]

  block <MAC>...       Block MACs (-p/--permanent to prevent unblocking on sync)
  unblock <MAC>...     Unblock MACs
  sync [file]          Reconcile AP blacklist with file contents
  list                 Show current AP blacklist
  clients              Show currently connected devices
  login-test           Test login and exit
  schedule:run         Run tasks that are due (for cron)
  serve                Run dashboard + API

  -n, --dry-run        Show actions, don't execute
  -q, --quiet          Don't print informational messages
      --json           Output JSON to stdout
```

```
  rules list              Show all time rules and which are currently active
  rules active            MACs currently blocked by rules
  rules add <name>        Add a new rule
  rules remove <rule>     Remove a rule
  rules update <rule>     Change hours / MACs / rule status
```

Options `--force`, `--task <name...>`, and `--status` belong to `schedule:run`. `rules list` and `rules active` accept `--at HH:MM` to see which rules are active at a specific time without waiting. MAC format accepts three forms: `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, and `aabbccddeeff`. Empty lines and lines starting with `#` in the blacklist file are ignored; invalid MACs are reported but don't stop synchronization.

## Sync Mode — Used for Cron

`sync` treats a file as the **single source of truth**:

- MACs in the file → blocked on AP
- MACs blocked on AP but **not** in the file → unblocked
- Otherwise → left as-is

So to unblock a device, just remove its line from the file. To block, add its line. `sync` is **idempotent** — running multiple times produces no repeated changes.

```bash
node src/cli.js sync            # use config.blacklistFile
node src/cli.js sync --dry-run  # show planned actions only
node src/cli.js sync --json     # detail per MAC, safe to pipe
```

Only the summary goes to stdout; per-MAC details go to logs so cron doesn't send a noisy email:

```
Sync complete. Added: 1, removed: 2, unchanged: 1.
```

## Time-Based Blacklist Rules

`blacklist.txt` = **permanent** blocks. Rules in `rules.json` = blocks **only during specific hours**, and are automatically removed once the time window passes.

```json
{
  "rules": [
    {
      "id": "break",
      "name": "Break time",
      "macs": ["aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66"],
      "windows": [
        { "start": "12:00", "end": "13:00" },
        { "start": "15:00", "end": "16:00" },
        { "start": "17:30", "end": "18:30" }
      ]
    },
    {
      "id": "night-work",
      "name": "Weekdays only, after midnight",
      "macs": ["de:ad:be:ef:00:01"],
      "windows": [{ "start": "23:00", "end": "01:00", "days": ["mon", "tue", "wed", "thu", "fri"] }]
    }
  ]
}
```

See `rules.json.example` for a complete example.

### Window Semantics

| Rule | Meaning |
|---|---|
| `[start, end)` | Starts at `start` **inclusive**, ends at `end` **exclusive** |
| `start > end` | Crosses midnight (`23:00`-`01:00`) |
| `end: "24:00"` | Midnight end — `00:00`-`24:00` means all day |
| `start == end` | **Rejected.** Use `00:00`-`24:00` for all day |
| `days` | 0=Sunday..6=Saturday, or `sun`..`sat`. Empty = every day |
| `days` + midnight crossing | `days` refers to the day the **window starts** — "fri 23:00-01:00" is also active Saturday 00:30 |

### Managing Rules

```bash
node src/cli.js rules add "Break time" \
  -m aa:bb:cc:dd:ee:ff -m 11:22:33:44:55:66 \
  -s 12:00 -e 13:00
node src/cli.js rules add "Break 2" \
  -m aa:bb:cc:dd:ee:ff -s 15:00 -e 16:00

node src/cli.js rules add "Evening" -m de:ad:be:ef:00:01 -s 17:30 -e 18:30 -d mon,tue
node src/cli.js rules update evening --start 18:00 --end 19:00
node src/cli.js rules update evening --add-mac 00:11:22:33:44:55
node src/cli.js rules update evening --remove-mac 00:11:22:33:44:55
node src/cli.js rules update evening --disable
node src/cli.js rules remove evening
```

All write back to `rules.json` in a clean, human-readable format that's safe for `git diff`. `update` can only modify one window; for rules with multiple windows, edit the file directly (the command rejects instead of guessing).

### Checking Rules Without Waiting

```bash
node src/cli.js rules list                    # [ACTIVE] / [pending] / [off]
node src/cli.js rules list --at 12:30         # which are active if it's 12:30?
node src/cli.js rules active --at 2026-10-05T23:30
```

### Timezone

Rule times are compared against the **local machine time**, or against `RULES_TZ` if set (e.g., `Asia/Jakarta`). If your machine is already in `Asia/Jakarta`, `RULES_TZ` can usually be left empty. Only set it if this repo is moved to a machine with a different timezone.

### What Actually Happens on the AP

The desired state is recomputed every minute:

```
must be blocked = blacklist.txt ∪ rules that are CURRENTLY active
```

`rules-apply` (cron `* * * * *`) evaluates the current time, and `blacklist-sync` (`*/30 * * * *`) does the same for the permanent file. Both use the same diff logic, so they won't undo each other: MACs from rules remain blocked even if `blacklist-sync` runs during the window.

As a consequence, blocking via the dashboard **only lasts until the next sync/rules-apply** — this is intentional, not a bug. If you want it to be permanent, check the **Permanent** checkbox (or use `block --permanent`), which writes the MAC to `blacklist.txt` first, then blocks it on the AP.

```bash
node src/cli.js block aa:bb:cc:dd:ee:ff --permanent
```

`--permanent` writes the file **before** touching the AP, so if the process dies in the middle, that MAC will still be blocked on the next sync. MACs that already exist in the file are not rewritten; only new MACs are added. This flag interacts with `--dry-run`: combining them only shows what *would* be written.

Malformed rules are not silently ignored — `schedule:run` exits with code 2 and a message pointing to the offending line.

## `schedule:run` — Single Cron Command

Available tasks (src/schedule.js):

| Task | Default | Purpose |
|---|---|---|
| `blacklist-sync` | `*/30 * * * *` | Reconcile with `blacklist.txt` + active rules |
| `rules-apply` | `* * * * *` | Evaluate time rules every minute, block/unblock accordingly |
| `blacklist-audit` | `5 * * * *` | Log current AP blacklist for tracking external changes |

Cron calls `schedule:run` **every minute**; the command itself checks the time and runs only tasks that are due. Schedules are in config, not in crontab — so changing the schedule just means editing `.env`, no need for `crontab -e`.

```cron
* * * * * cd /home/fjr/Codes/XProject/wifi-control && /usr/bin/node src/cli.js schedule:run
```

See `crontab.example` for a complete example. If `HOME` is not set in cron's environment, `STATE_DIR` may resolve incorrectly — add `HOME=` or explicitly set `STATE_DIR`.

Things to know:

- Tasks that have never run **wait for the next cron slot** — they are not executed immediately on the first call to `schedule:run`.
- If another process holds the lock, the task is **skipped** and logged to retry next minute — `lastRunAt` is not updated.
- Tasks that fail still update `lastRunAt` so they aren't retried every minute without pause. Failures are recorded in `<stateDir>/schedule-state.json`.
- Status can be checked without running anything:

  ```bash
  node src/cli.js schedule:run --status --json
  node src/cli.js schedule:run --task blacklist-sync --force
  ```

## Dashboard

```bash
npm start                    # build CSS then run server
node src/cli.js serve        # without rebuilding
```

Open `http://127.0.0.1:8080`. It shows: statistics, blacklist list, connected devices, block/unblock buttons, sync (including dry-run), time rules (read-only), scheduler status, and logs.

All `/api/*` endpoints are behind a bearer token if `API_TOKEN` is set. If `HOST` is not loopback and the token is empty, the server **refuses to start** — these endpoints can block devices from the network.

| Method | Path |
|---|---|
| GET | `/health` (no token, for monitoring) |
| GET | `/api/config` |
| GET | `/api/blacklist` |
| GET | `/api/clients` |
| POST | `/api/blacklist/block` (`permanent: true` writes to `blacklist.txt`) |
| POST | `/api/blacklist/unblock` |
| POST | `/api/sync` |
| POST | `/api/login-test` |
| GET | `/api/rules` (supports `?at=HH:MM`) |
| GET | `/api/schedule` |
| POST | `/api/schedule/run` |
| GET | `/api/logs` |

`POST /api/sync` only accepts files inside the repo directory or `stateDir`; other paths are rejected with 400.

### TailwindCSS

Styles are built locally — no CDN, so the dashboard still works on networks without internet.

```bash
npm run build:css   # src/styles.css -> public/tailwind.css (minified)
npm run dev:css     # watch mode for development
```

`public/tailwind.css` is committed so the server can run without building.

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | invalid argument / invalid MAC / malformed `rules.json` |
| 3 | login failed, or session rejected twice in a row |
| 4 | AP not responding (timeout / TCP failure) |
| 5 | API response format unexpected |
| 6 | another process is already running (lock) |

All error messages go to stderr, data to stdout, so `--json` is safe to pipe.

### Expired Sessions

The LuCI session on this router has a timeout, so long-running daemons (`serve`) or processes running `rules-apply` may encounter an expired session mid-operation. The firmware responds with "session lost" in **two forms**, and both are recognized and trigger a single login retry:

| Form | Status | Content-Type | Example |
|---|---|---|---|
| Login page | 200 | `text/html` | `<!DOCTYPE html>...` (starts with `<`) |
| Lua error | 500 | `text/plain` | `/usr/lib/lua/luci/sauth.lua:87: Session data invalid!` |

The second form used to leak through as exit 5 (JSON.parse failed, body didn't start with `<`), so it wasn't retried — even though it just needed re-login. Now both are treated as "session lost".

If the session is rejected **twice** after a genuinely fresh login, it exits with code 3 and a message that the AP may be restarting — it does not retry login indefinitely.

## Security

- Password is never written to `crontab`. Keep it in `.env` (already `.gitignore`) or environment.
- Password never appears in logs. `schedule:run` state only stores task name, exit code, and error messages.
- If `.env` is ever committed, rotate the AP password.
- Dashboard only listens on loopback unless `API_TOKEN` is set.

## Logs

Default is `~/.local/state/wifictl/wifictl.log`, rotated when it exceeds 1 MiB to `wifictl.log.1`. Never written to stdout.

## Testing

Does not touch a real AP. Includes a mock server (`tests/mock_router.py`) that mimics the API contract exactly, including both "session lost" forms and "format changed" conditions.

```bash
npm test
```

```
# tests 147
# pass 147
# fail 0
```

The old Bash tests for `wlmac.sh` are still in `tests/run_tests.sh` (`./tests/run_tests.sh`) — used as a regression check for the API contract.

## Legacy Implementation (`wlmac.sh`)

`wlmac.sh` (Bash) and `tests/run_tests.sh` are kept as a reference for the API contract. The password is embedded in that file, so it remains in `.gitignore`. Use `node src/cli.js` for day-to-day operations.

## Maintenance Notes

If the AP firmware is updated, the API contract may change. Symptom: exit code 5 with message `format API berubah?` (or "API format changed?"). To re-inspect, fetch the latest `index.js`:

```bash
curl -s http://192.168.10.1/routerweb/js/index.js -o /tmp/index.js
grep -oE "hostUrl[A-Za-z]* *\+ *'[^']+'" /tmp/index.js | sort -u
```