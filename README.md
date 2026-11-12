# pi-permission-rules

pi-permission-rules is a pi extension that checks tool calls against Claude Code–style `allow`, `ask`, and `deny` rules. It splits Bash commands into parts and checks each part and output redirect before execution, so approving one command cannot silently approve another command in a compound command. It also provides Claude-named permission modes and stores persistent grants outside the repository, shared by linked worktrees.

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-permission-rules"]
}
```

For local development, use a local package path instead:

```json
{
  "packages": ["../path/to/pi-permission-rules"]
}
```

## Rules

Rules use Claude Code syntax:

| Rule | Applies to | Example |
|---|---|---|
| `Bash(<command>)` | One parsed Bash command part | `Bash(git status)` |
| `Read(<glob>)` | `read`, `grep`, `find`, and `ls` paths | `Read(/home/u/project/src/**/*.ts)` |
| `Edit(<glob>)` | `edit` and `write` paths, and Bash output redirects | `Edit(/home/u/project/**/.env*)` |
| A bare tool name | Every call to that built-in tool family; custom-tool asks and denies match by name | `Bash`, `Read`, `Edit`, `mcp` |

A Bash rule without wildcards matches exactly after the shell lexer parses the part. A suffix `:*` matches a prefix on a word boundary: `Bash(git log:*)` matches `git log` and `git log -5`, but not `git logx`. Other `*` wildcards match within that command part. Path globs use `*` within one path segment, `?` for one non-slash character, and `**` across directories. Absolute and `~/` path patterns are used as given; relative path patterns are anchored at the project root. Relative tool-call paths are normalized from pi's current working directory; relative Bash redirect targets use the shell's current directory.

Rule lists of each kind are combined as a union. A matching deny blocks first, then a matching ask requires approval. Otherwise, allow rules, session grants, and the mode determine the result. In `plan` mode, non-read-only Bash parts and edits are denied regardless of allow rules. Custom tools are allowed unless a matching `ask` or `deny` rule applies; custom-tool `allow` rules are not needed because they are already allowed by default. A custom tool whose input has a string `command` (for example `job_run` from pi-jobs) is checked exactly like `bash` with that command, so `Bash` rules and redirect checks apply to it and `plan` mode denies its non-read-only commands; a name-matching ask or deny rule for the tool still wins when it is stricter. A custom tool without a string `command` keeps the tool-name behaviour. `powershell` is a special case: it always asks unless a bare `powershell` deny rule matches; `plan` denies it.

## Config files

The extension reads these files in order:

| # | File | Written by extension? | Accepted settings |
|---|---|---|---|
| 1 | `~/.pi/agent/permissions.json` (global) | No | All supported settings |
| 2 | `~/.pi/agent/permissions/<repo-key>.json` (per project) | Yes: persistent “don't ask again” Bash grants | All supported settings |
| 3 | `<project root>/.pi/permissions.json` (optional, team-shared) | Never | `permissions.ask` and `permissions.deny` only |

In files 1 and 2, rules and `defaultMode` are under `permissions`; `readOnlyCommands`, `unattended`, and `askTimeoutSec` are top-level settings. Rule arrays are unioned, and file 2 overrides file 1 for scalar settings. The repo file can only tighten policy: its `allow`, `defaultMode`, `readOnlyCommands`, `unattended`, and `askTimeoutSec` settings are ignored and reported. A cloned repo cannot grant itself permission or turn off the gate.

Only the “don't ask again” choice writes a persistent grant, and it writes to file 2. The extension creates the directory as needed, writes via a temporary file and rename, and does not duplicate existing rules. Invalid JSON is reported and that file is skipped; malformed entries and ignored settings are also reported.

The project root is the Git worktree root, or the current working directory outside Git. The repo key is the parent of Git's common directory, so linked worktrees share one settings file. Outside Git, the current directory is the key. The filename replaces every non-alphanumeric character in the key with `-` and adds `.json` (for example, `/home/u/project` becomes `-home-u-project.json`).

Example global or per-project settings:

```json
{
  "permissions": {
    "allow": ["Bash(./gradlew *)", "Bash(/home/u/project/scripts/check.sh)"],
    "ask": ["Edit(**/.env*)", "Edit(**/.ssh/**)"],
    "deny": ["Read(/home/u/project/**/local.properties)"],
    "defaultMode": "acceptEdits"
  },
  "readOnlyCommands": ["fumi"],
  "unattended": "auto",
  "askTimeoutSec": 60
}
```

The repo file may contain only `permissions.ask` and `permissions.deny` from this example. For global settings, keep `ask: ["Edit(**/.env*)", "Edit(**/.ssh/**)"]` to protect secrets; writes to any `.git` directory are protected by a built-in ask (and denied in `plan` mode), independent of configured rules. The extension's own permission files (`~/.pi/agent/permissions.json` and the files under `~/.pi/agent/permissions/`, or the same paths under `PI_CODING_AGENT_DIR` when set) are protected the same way: edits and Bash output redirects to them ask even when an allow or session rule matches, `plan` denies them, and the session edit-grant option is never offered for them.

## Modes

Mode precedence is `/permissions mode <mode>` for the current session, then `PI_PERMISSIONS_MODE`, then the configured `defaultMode` (file 2 overrides file 1), then the built-in default `acceptEdits`. An invalid `PI_PERMISSIONS_MODE` is ignored with a warning.

| Mode | Edit/write inside project root | Edit/write outside project root | Bash not covered by a rule |
|---|---|---|---|
| `default` | Ask | Ask | Ask |
| `acceptEdits` | Allow | Ask | Ask |
| `plan` | Deny | Deny | Deny unless every part is read-only |

Read tools are allowed inside and outside the project root by default, subject to matching ask or deny rules. Explicit rules cannot make a non-read-only Bash part or edit allowed in `plan` mode.

## How Bash commands are checked

A small shell lexer splits compound commands at `&&`, `||`, `;`, `|`, `&`, and newlines. Every part is evaluated; a deny takes precedence over an ask or allow. Single quotes, double quotes, and backslash escapes are handled; quoted text is data, not a command. Command substitutions using `$()` and backticks are parsed recursively, including inside double quotes, so their commands are checked too. Leading `NAME=value` assignments are stripped before matching. Dangerous environment assignments require approval, and assignments make a command ineligible for the read-only allowlist.

Heredoc bodies are skipped through their delimiter while the owning command is still checked. Command substitutions in an expandable heredoc body make the command unsafe. `#` comments at the start of a word are dropped. Output redirect targets are checked as edits and `<` input targets as reads; relative targets follow the shell's current directory, including a simple `cd` in the command sequence. `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/<n>`, and file-descriptor duplication are not treated as output-file edits.

The lexer fails closed: parse errors, unbalanced quotes, unterminated heredocs or substitutions, process substitutions (`<(...)` and `>(...)`), and commands whose behavior it cannot inspect require approval (or are denied in `plan`). This includes `eval`, `source`/`.`, `exec`, `bash`/`sh`/`zsh -c`, and shells reading a script from stdin. It detects these cases through common wrappers (`env`, `command`, `nohup`, `time`, `nice`, and `timeout`) and treats a variable command name as unsafe. In `plan`, any Bash part that is not read-only is denied, even if an allow rule matches it.

## Read-only commands

The built-in list includes `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `fd`, `pwd`, `echo`, `printf`, `which`, `file`, `stat`, `du`, `df`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff`, `cmp`, `basename`, `dirname`, `realpath`, `true`, `test`, `[`, `date`, and `cd`, plus checked forms of `find`, `sed`, `awk`, `git`, `gh`, and constrained `xargs`. `xargs` is read-only only with `-0`/`--null`, `-r`/`--no-run-if-empty`, `-n N`, `-L N`, `-P N`, and `-d X` options (values may be attached or separate), and a bare wrapped command among `grep`, `egrep`, `fgrep`, `cat`, `wc`, `head`, `tail`, `ls`, `stat`, and `du`. Replacement, input-file, interactive, output, prompt, and end-of-file options are not accepted. The built-in xargs allowance is disabled when any Read ask/deny rule is active because stdin can supply file operands the gate cannot inspect. `readOnlyCommands` does not bypass these xargs checks. Known file-writing and code-execution forms are excluded from the built-in read-only forms; command-specific option checks are conservative, not a complete sandbox for every utility version. For commands with checked option allowlists, GNU long options must match the full safe option name; an abbreviation is not accepted merely because it shares a prefix with a safe option.

The checked forms include:

- `find` without `-exec`, `-execdir`, `-delete`, `-ok`, `-okdir`, `-fls`, or `-fprint*`; `sed` without in-place or script-file options; and `awk` without code execution, file loading, output redirection, or pipelines.
- Read-only Git queries: `status`, `log`, `show`, `diff`, `blame`, `rev-parse`, `ls-files`, `ls-tree`, `grep`, `merge-base`, `cat-file`, `describe`, and `shortlog`. `branch` allows no arguments or the listed query flags; `remote` allows no arguments or exactly `-v`; `stash` allows exactly `list`; and `config` requires a read option (`--get`, `--get-all`, `--get-regexp`, `--list`, or `-l`) and no write option. `reflog` is allowed except for `expire`, `delete`, `drop`, `exists`, or `--` forms.
- `gh pr view|list|diff|checks`, `gh issue view|list`, and `gh api` only when the method is GET and no form fields or input file are supplied.

Read rules are applied to explicit file operands of recognized read-only commands and to `<` input redirects. Directory operands to `grep`, `find`, and `ls` are not expanded into individual files, so rules for files nested under those directories may not be applied; use explicit file operands when those rules must be enforced.

A rule such as `deny: ["Bash(git push:*)"]` matches the parsed command words exactly. `command git push` and `/usr/bin/git push` do not match that deny rule; they are not built-in read-only commands and require approval in interactive modes (or are denied in `plan`).

Global and per-project `readOnlyCommands` settings can add command names without checking their arguments; use them only for commands trusted to be read-only. The repo file cannot set this list.

## Prompt

When a human is available, the prompt shows the tool, the command parts or paths that triggered the ask, and the matching rule (or `no allow rule`). Available options are:

1. `Yes` — allow this call once.
2. `Yes, and don't ask again for <rules> in this project` — for eligible Bash parts, save suggested or exact-command rules to the per-project file and apply them to the session. Exact `Bash(<part>)` rules match only that same parsed part; they are offered only for fully parsed static commands, not code runners or wrappers (`bash`, `python`, `npx`, `xargs`, `command`, `env`, and similar), package managers and build runners (`npm`, `pnpm`, `yarn`, `bun`, `deno`, `uv`, `make`, and `gradlew`, including a path-qualified `./gradlew`), assignments, dynamic text (variables, backticks, or substitutions), unquoted globs, `gh ... api`, `git config`, or text containing `*`.
3. `Yes, and allow edits in <dir> during this session` — for an outside-project edit or output redirect in `acceptEdits`, add an in-memory `Edit(<dir>/**)` rule. The directory is the target worktree root (or target parent when outside Git); it is never saved and is not offered for `/`, the home directory, its ancestors, or when matching policy asks or denies.
4. `Yes, allow all edits during this session` — for edits in `default` mode, switch this session to `acceptEdits`.
5. `No, and tell pi what to do differently` — deny; optional text is included in the block reason.

Only applicable choices are shown. Unattended asks remain blocked without opening a prompt. There is no timeout by default. Set `askTimeoutSec` to a positive number of seconds to make an unanswered prompt count as a denial.

## Unattended mode

`unattended` accepts `"auto"` (the default), `true`, or `false`. In `auto`, a call is unattended when pi has no UI, `PI_PERMISSIONS_UNATTENDED=1`, or `NAKAMA_AGENT` is set. No-UI sessions remain unattended even if the setting is `false`. An unattended ask does not open a prompt or save grants; it blocks the tool and gives the model a reason. Ask and deny reasons use this format:

```text
permission: `<part>` needs approval (<matched rule>). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.
permission: `<part>` is denied (<matched rule>). It was not run. Use a read-only alternative, or report that this step needs the orchestrator.
```

For an ask with no matching rule, the rule text is `no allow rule`; an explicit denial uses the matching deny rule.

## `/permissions` commands

- `/permissions` shows the project root, repo key, config sources, effective rules and their sources, ignored entries, mode, session grants, and unattended state.
- `/permissions test <command>` shows each parsed Bash part, redirect, and its decision without running it.
- `/permissions mode <default|acceptEdits|plan>` changes the mode for this session.

## Deviations from Claude Code

| Claude Code | Here | Why |
|---|---|---|
| Default mode `default` (edits ask) | Default `acceptEdits` | pi users and nakama builders edit freely today, and asking on every edit would be a big regression. nakama already launches Claude write workers in `acceptEdits`. Set `defaultMode: "default"` for strict behavior. |
| Reads outside the working directory ask (`additionalDirectories`) | Always allowed | User decision 5: nakama researchers read sibling repos. |
| Prefix suggested by a model call | Deterministic heuristic | No model call inside a permission hook: faster and testable. |
| Unattended (`-p`): unapproved tools are refused | Same, plus `NAKAMA_AGENT`/env detection | pi's `hasUI` lies inside herdr panes. |
| Settings in `.claude/settings*.json`; local grants in the repo's `.claude/settings.local.json` | `~/.pi/agent/permissions.json` + `~/.pi/agent/permissions/<repo-key>.json`; the repo file is read-only and limited to ask/deny | Decision 7: never write into a repo or worktree; per-project state must survive worktree deletion and be shared across worktrees. Claude settings are never read (decision 6). |
| Project settings trusted after a workspace-trust prompt | No trust prompt; the repo file can only tighten | Smaller design with the same safety: a cloned repo can't loosen the gate. |

## Development

The extension has no additional runtime dependencies; the pi extension API is a peer dependency. Run the tests with:

```sh
node --test test/
```

Enable the privacy pre-commit hook and run its history scan with:

```sh
git config core.hooksPath .githooks
node scripts/privacy-scan.mjs --history
```

The hook scans staged changes. Keep local sensitive strings, one per line, in `.git/info/privacy-denylist`; this file is not committed.

## License

MIT
