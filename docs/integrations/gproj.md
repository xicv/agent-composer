# gproj integration

Composer consumes the standalone `gproj` CLI (repo: /Users/xicao/Projects/gproj). It does NOT absorb gproj's logic.

- Planner lane: Composer's `oraclePlanner` (oracle CLI) → `GPROJ_PLANNER=oracle-browser`.
- Executor lane: `composer_code_cli` (codex) → `GPROJ_EXECUTOR=codex`.
- Spend + boundary: gproj dispatches inherit Composer's `spendAuthorization` and `boundary_guard` because Composer invokes `gproj` via Bash.
- State: `.gproj/` lives in the target repo, git-versioned. The orchestrator runs `gproj advance`, surfaces the review verdict, and asks the user before `gproj decide`.
