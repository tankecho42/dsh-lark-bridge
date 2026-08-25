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

## M2 deployment checklist

- Review `codex/m2-hardening` and its test/CI changes.
- Configure `allowedUserIds`, `allowedChatIds`, `adminUserIds`, and
  `workspaceRoots` before exposing the bridge to production chats.
- Record the current production commit and process details as the rollback
  point.
- Install from a clean lockfile and run `npm test`, `npm audit --omit=dev`, and
  `npm pack --dry-run`.
- Restart one bridge instance only; confirm the old WebSocket closes before the
  replacement accepts traffic.
- Verify p2p chat, a real group mention, ignored non-mentions, `/cwd`, `/tools`,
  `/stop`, approval allow/reject/session-allow, duplicate event suppression,
  and one HMR/reload cycle.
- Observe bridge logs and WebSocket state before widening access.

Rollback by reverting the reviewed deployment commit and restarting the single
bridge instance. Do not restore a leaked secret or merge pre-rewrite history.
