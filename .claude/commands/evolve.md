# /evolve — autoresearch loop for composer-mastermind

Note: gated behind `COMPOSER_ENABLE_EVOLVE=1`; parked/experimental per ADR 0010 after zero promotions across 6+ real runs. Enable only for deliberate autoresearch experiments.

Kick off GEPA-lite autoresearch to evolve the orchestrator skill (`.claude/skills/composer-mastermind/SKILL.md`). Runs a synthetic v1 scorer to propose improvements; writes the candidate to `.claude/skills/composer-mastermind/SKILL.candidate.md` for manual review.

## Usage

```bash
/evolve
# Defaults: budget $2.00, max 10 rounds.

/evolve --budget-usd 1.00 --max-rounds 5
# Custom spend cap and round limit.
```

## What it runs

Invokes `./node_modules/.bin/tsx scripts/run-evolve.ts` with parsed CLI arguments. The driver wires real providers (GLM 5.1 for reflection, `agy` CLI for research) and a synthetic scorer into `runEvolve()`.

## Winner

If the evolve loop finds an improvement, the candidate is written to:
```
.claude/skills/composer-mastermind/SKILL.candidate.md
```

Promote manually after review:
```bash
mv .claude/skills/composer-mastermind/SKILL.candidate.md \
   .claude/skills/composer-mastermind/SKILL.md
```

If no improvement is detected, the file is not written; the original SKILL.md stands.

## Cost

Each provider call costs ~$0.025 (GLM reflection). The default $2.00 budget covers ~80 calls. Real spend routes through GLM coder and `agy` CLI per `composer.config.json` spend authorization settings.

## Output

The summary prints to stdout:

- Round history table: `| round | operator | parentScore | candidateScore | promoted | reason |`
- `stoppedAt: <plateau|budget|maxRounds>`
- `postflight: accept=<true|false> reason="..."`
- `budgetStats: calls=N usd=$X.XXXX`
- Parent vs. winner score improvement

## Safety

- Respects `composer.config.json` `spendAuthorization.maxUsdPerSession`. If `--budget-usd` exceeds the cap, the script exits with an error message and exit code 1 before spending.
- Loop termination is governed by `runEvolve()` itself: whichever of budget, plateau, or `--max-rounds` hits first. To abort mid-loop, send SIGINT (Ctrl-C); the script exits without writing `SKILL.candidate.md` unless the write step already completed.
- Task descriptions in `evals/tasks.jsonl` are passed verbatim to the reflection provider — keep that file under version control to retain a clear trust boundary.
- **SKILL.md edits are safe during a real-mode run.** Each task eval runs in a throwaway `git worktree` at `/tmp/composer-eval-<pid>-<taskId>`. The candidate skill is written only into the worktree copy; the real repo's SKILL.md is never touched during evaluation. You can freely edit SKILL.md in your editor while `/evolve --eval-mode real` is running.

## Evidence

The reflection mutator now receives recent route/audit failures from the durable audit trail (`composer_audit({action:"record"})` → `readAuditFailures`). Up to 20 recent failures (events with `status=failed` or `userCorrection=true`) are extracted from the audit log and injected into the reflection prompt before the current-ecosystem section. This means proposed skill rewrites are driven by real routing and outcome failures — wrong route choice, unnecessary Oracle use, issues a review caught after the fact, user-corrected routes — not just synthetic scorer signals.

## v1 caveat

The v1 scorer is synthetic (heuristic-based):
- 0.4 points for substring "dispatch" (case-insensitive)
- 0.2 points for substring "Read" (case-sensitive, the tool name)
- 0.4 points scaled by character count (peak at 4000 chars, linear falloff to 0 outside 2000–6000)

Real eval-against-eval-tasks lands in v2.
