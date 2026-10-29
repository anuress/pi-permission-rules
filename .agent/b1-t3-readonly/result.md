Status: succeeded

Implemented Task 3 in `extensions/readonly.ts` and `test/readonly.test.ts`. The allowlist handles command basenames, extra-command basenames, conditional safety checks, git global options, and the specified `CODE_RUNNERS` set. Initial commit: `775c2c9 feat: read-only command allowlist`; Fix round 1: `fda2383 fix: close read-only allowlist write and exec paths`.

Evidence:
- TDD RED: `node --test test/readonly.test.ts` initially failed with `ERR_MODULE_NOT_FOUND` for the not-yet-created `extensions/readonly.ts`.
- Focused RED: the new table test caught `find . -fls x` incorrectly returning true; the implementation now rejects `-fls` as well as `-fprint*` and `-okdir`.
- GREEN: `node --test test/readonly.test.ts` — 3 tests passed, 0 failed.
- Acceptance: `node --test test/` — 40 tests passed, 0 failed.
- `git log --oneline main..HEAD`: `775c2c9 feat: read-only command allowlist`.
- Commit author and committer: `Ahmad Nur Salim <nurskediri@gmail.com>`.
- `git status --short --branch`: `## agent/b1-t3-readonly` (clean).
- `git diff HEAD --check`: clean.

### Fix round 1

1. **sed script parsing:** replaced the unaddressed `w/W/e` regex heuristic with a scanner that skips substitution/transliteration bodies and slash/escaped-delimiter addresses, rejects `s///` `w`/`e` flags, remaining `w/W/e` commands, and unterminated forms. Added the requested addressed execution/write rows (`1e`, `$w`, `/x/w`, addressed ranges), safe addressed/substitution examples, escaped-delimiter cases, malformed forms, and `-ni`/`-E -i`/`-iE` checks. Pre-fix review probes showed addressed commands auto-allowed; the new table rows now fail closed.
2. **git global options:** reject split/glued `-c` and `--config-env[=]` before an allowlisted subcommand; preserve `-C`, `--no-pager`, `--git-dir=`, and `--work-tree=`. Added rows for `diff.external`, `core.fsmonitor`, `color.ui`, glued `-c`, config-env, and retained global options. The TDD RED run below showed `GIT_EXTERNAL_DIFF=/x git diff` was auto-allowed; all added cases now pass.
3. **shell assignments:** added `assignments: string[]` to `Part`; the lexer retains leading assignment words after quote removal, and `isReadOnly` rejects parts with assignments. Added rows for `GIT_EXTERNAL_DIFF`, `LD_PRELOAD`, and `PAGER`, plus `FOO=1 BAR="x y" ls` and empty assignments assertions. The RED run below showed the expected assignments property was missing and the environment assignment command was allowed.
4. **sort outputs and execution:** reject `--compress-program`, temporary-directory options, and `-o` including short clusters. Added separate/equals, attached, and clustered (`-uo`, `-no`, `-ro`) table rows; pre-fix review probes showed compressor and clustered output forms auto-allowed.
5. **file, awk, uniq:** reject `file -C`/`--compile`; reject awk include/load/exec/profile options and programs containing `@load`/`@include`; accept the required value-less long `uniq` flags and optional-equals forms. Added rows for all listed options, including the orchestrator's `-p`/`--profile` and `@load`/`@include` ruling.
6. **reviewer regressions:** added `git --git-dir=/x log`, `git --work-tree=/x log`, and glued `gh api -XGET`/`-XPOST` rows, alongside the sed glued-in-place forms. The read-only forms remain allowed and the unsafe forms are denied.

**Fix round TDD evidence:**
- RED: `node --test test/readonly.test.ts test/shell.test.ts test/rules.test.ts` — 28 tests, 26 passed, 2 failed. Decisive failures: `GIT_EXTERNAL_DIFF=/x git diff` returned `true !== false`; the assignment assertion received `undefined` instead of `["FOO=1", "BAR=x y"]`.
- GREEN: `node --test test/readonly.test.ts test/shell.test.ts test/rules.test.ts` — 28 passed, 0 failed.
- Acceptance: `node --test test/` — 40 passed, 0 failed.
- Commit `fda2383`; author/committer `Ahmad Nur Salim <nurskediri@gmail.com>`; commit trailer is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git status --short --branch`: clean; `git diff HEAD --check`: clean.

### Fix round 2

1. **GNU long-option abbreviations (R16):** added explicit full-name safe sets for `sed`, `sort`, `date`, `awk`, `uniq`, and `file`; each `--name=value` is checked by the exact name before `=`, and every unknown or abbreviated long option fails closed. Required separate values are consumed only when present and not option-looking, so a following `--out=...` cannot be hidden as a safe option's value. Kept the exact safe names from the ruling; existing option-specific checks still reject sort output/compressor/temp options, sed in-place/file/script-execution cases, awk profile/include/load/exec, and file compile mode. Added tests for safe options across every list and the supplied unsafe abbreviations.
2. **Git output/pager abbreviations:** inspect the long-option name before `=` and reject names of length at least four that prefix `--output` or `--open-files-in-pager`; this intentionally denies `git log --open` as required while keeping `git log --oneline -5` allowed. Added `--out=f`, `--outp=...`, `--open`, and oneline rows.
3. **file clustered compile option and coverage:** reject `C` anywhere in a short-option cluster (`file -bC ...`); added `file -bC`/`file -b` rows and the missing positive `sed 's/hello/world/g' f` row.

**Fix round 2 TDD evidence:**
- RED: `node --test test/readonly.test.ts` — 3 tests, 2 passed and 1 failed; decisive case `sort --num=f` returned `true !== false`.
- Additional RED: after adding the separate-value regression, the same command failed because `sort --parallel --out=/tmp/x in` returned `true !== false`. The guard now rejects the option-looking value instead of swallowing it.
- Additional RED: the Git abbreviation case `git log --open` returned `true !== false` before the controller-required prefix guard was restored across Git read subcommands.
- GREEN: `node --test test/readonly.test.ts` — 3 passed, 0 failed.
- Acceptance: `node --test test/` — 40 passed, 0 failed.
- `git diff --check`: clean.
- Commit subject: `fix: fail closed on unknown and abbreviated long options` (author/committer and required trailer verified after commit).

Next: review