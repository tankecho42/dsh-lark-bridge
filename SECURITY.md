# Security and release runbook

This project previously committed live Feishu application credentials in two
manual WebSocket test files. The current tree reads `LARK_APP_ID` and
`LARK_APP_SECRET` from the environment, but deleting the literals in a later
commit does not remove them from Git history.

## Required order of operations

1. Freeze pushes and notify every collaborator before rewriting history.
2. Rotate the Feishu App Secret in the developer console.
3. Update the private DSH bridge profile with the new secret. Never paste it
   into an issue, commit, task comment, build log, or shell command that will be
   retained in history.
4. Restart the bridge in a planned maintenance window and verify the new
   credential before touching Git history.
5. Back up the repository to a restricted location, then obtain explicit human
   approval for the destructive history rewrite.
6. Rewrite and force-push history, invalidate old clones, and have every
   collaborator re-clone.

## History cleanup strategy

The least error-prone cleanup is to remove both historical manual test files
from every ref without placing the leaked value in a replacement file:

```bash
git clone --mirror <repository-url> dsh-lark-bridge-sanitized.git
cd dsh-lark-bridge-sanitized.git
git filter-repo \
  --path test/ws-hold.mjs \
  --path test/ws-live.mjs \
  --invert-paths \
  --force
```

Inspect the rewritten mirror and run a secret scanner before any push. After
approval, force-push branches and tags, then re-add the environment-only manual
tests in a clean commit. Do not merge an old clone back into the rewritten
history.

## Deployment checklist

### DSH credential format compatibility gate

The bridge does not read, migrate, or write `~/.dsh/.credentials.yaml`. Credential
format belongs to the DSH host, so host and credential changes must be released as
one coordinated unit:

| DSH host/toolchain | Supported credential format | Release rule |
| --- | --- | --- |
| `0.1.0-rc.8` production rollback line | legacy flat mapping | Keep the current flat file; do not restore a `version: 1` + `refs` backup while this host is active. |
| a verified `0.1.1-rc.x` or newer build with refs support | `version: 1` + `refs` | Restore the reviewed new-format backup only inside the same maintenance window as the host upgrade. Never let this bridge auto-migrate it. |

Before changing either side, preserve both the known-good flat file and the
reviewed new-format backup in a restricted location, record their exact target
versions, and prepare a paired rollback. After starting the upgraded host, read
`dataDir/health-endpoint.json`, require `/readyz` to return 200, then run
`/doctor` before accepting traffic. If either check fails, stop the new process,
restore the previous host plus its matching flat credential file, and verify the
old readiness path. Never test a credential format by repeatedly restarting the
production process.

### General release checks

- Review the release-candidate branch and its test/CI changes.
- Configure `allowedUserIds`, `allowedChatIds`, `adminUserIds`, and
  `workspaceRoots` before exposing the bridge to production chats.
- Record the current production commit and process details as the rollback
  point.
- Install from a clean lockfile and run `npm test`, `npm audit --omit=dev`, and
  `npm pack --dry-run`.
- Restart one bridge instance only; confirm the old WebSocket closes before the
  replacement accepts traffic.
- Read `health-endpoint.json`, require `/healthz` and `/readyz` to return 200,
  and confirm `dsh_lark_bridge_ready 1` on `/metrics` before widening traffic.
- Verify p2p chat, a real group mention, ignored non-mentions, `/cwd`, `/tools`,
  `/doctor`, `/stop`, approval allow/reject/session-allow, duplicate event
  suppression, retry behavior, log rotation, and one HMR/reload cycle.
- Observe bridge logs and WebSocket state before widening access.

Rollback by reverting the reviewed deployment commit and restarting the single
bridge instance. Do not restore a leaked secret or merge pre-rewrite history.
