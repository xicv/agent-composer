---
name: composer
description: Enable, disable, or check Composer global enforcement (the boundary_guard hook that forces main-thread edits to route through Composer). Use when the user says /composer, "enable composer", "disable composer", "turn composer on/off", or "is composer enabled". Toggles ~/.claude/composer.disabled live — no session restart needed.
---

# Composer Enforcement Toggle

Use this skill to toggle Composer's global boundary enforcement in the
current session. The boundary_guard hook reads the switch files fresh on
every tool call, so changes take effect immediately: no restart, no `/mcp`
reconnect.

This does not affect the MCP server (`dist/index.js`). It only flips hook
enforcement for main-thread tool calls.

## Commands

### enable / on

Re-arm Composer enforcement.

Run:

```bash
rm -f ~/.claude/composer.disabled
if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -e "$CLAUDE_PROJECT_DIR/.composer-disabled" ]]; then
  rm -f "$CLAUDE_PROJECT_DIR/.composer-disabled"
fi
```

Confirm: `Composer enforcement is ON.`

### disable / off

Suspend Composer enforcement so direct Edit/Write works.

Run:

```bash
touch ~/.claude/composer.disabled
```

Confirm: `Composer enforcement is OFF.`

### status

Check both switch files.

Run:

```bash
if [[ -e ~/.claude/composer.disabled ]]; then
  echo "OFF: ~/.claude/composer.disabled is active"
elif [[ -n "${CLAUDE_PROJECT_DIR:-}" && -e "$CLAUDE_PROJECT_DIR/.composer-disabled" ]]; then
  echo "OFF: $CLAUDE_PROJECT_DIR/.composer-disabled is active"
else
  echo "ON: no Composer disable switch is active"
fi
```

Report ON/OFF and name the active switch when enforcement is disabled.

## Notes

- When ON, enforcement is GLOBAL: main-thread Edit/Update/Write/NotebookEdit
  are denied in every repo and every path.
- Subagents and `composer_code_cli` are unaffected.
- Do not restart the session after toggling. The next tool call sees the
  updated switch state.
