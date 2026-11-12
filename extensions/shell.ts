// Shell lexer: splits a bash command into parts so rules match per sub-command,
// never against raw text. Fails closed (`unsafe`) on anything it cannot vouch for.

export type Part = { argv: string[]; assignments: string[]; redirects: string[]; inputs: string[]; globs: boolean[]; dynamic: boolean[]; redirectGlobs: boolean[]; inputGlobs: boolean[]; text: string; scope: string; compoundRedirect?: boolean; conditional?: boolean; loops?: number[] };
export type ParseResult = { parts: Part[]; unsafe?: string };

type State = { unsafe?: string; nextLoop?: number };
type Heredoc = { term: string; strip: boolean; expand: boolean };
type Mode = null | "redir" | "input" | "skip" | "heredoc";

const PLACEHOLDER = "$(…)";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Names that change how later commands resolve: shared with the decision logic.
export const DANGEROUS_ASSIGNMENT = /^(?:HOME|PI_CODING_AGENT_DIR|LD_.*|DYLD_.*|GIT_.*|SSH_.*|PATH|PAGER|.*_PAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHON.*|PERL5.*|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|.*_OPTS|PROMPT_COMMAND|IFS|SHELLOPTS|BASHOPTS)$/;
// Reserved words dropped at command position so the real command is matched.
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"]);
// Compound commands `time` would run in the current shell, out of the lexer's sight.
const TIME_COMPOUND = new Set(["if", "for", "select", "while", "until", "case", "function"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const FD_DUP = /^(\d+-?|-)(?![^\s;|&<>()])/;

export function parse(command: string): ParseResult {
  const st: State = {};
  let parts: Part[] = [];
  try {
    parts = scan(command, st, 0, null).parts;
  } catch (e) {
    st.unsafe ??= `parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return st.unsafe ? { parts, unsafe: st.unsafe } : { parts };
}

function flag(st: State, reason: string): void {
  st.unsafe ??= reason;
}

// Reads a backtick body starting after the opening backtick. Returns the
// unescaped inner source and the index after the closing backtick (-1 if none).
function readBacktick(s: string, start: number): { text: string; end: number } {
  let text = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "`") return { text, end: i + 1 };
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      text += n === "`" || n === "\\" || n === "$" ? n : c + n;
      i++;
    } else text += c;
  }
  return { text, end: -1 };
}

function scan(s: string, st: State, start: number, closer: ")" | null, scope = "", parentLoops: number[] = []): { parts: Part[]; end: number } {
  const out: Part[] = [];
  let argv: string[] = [];
  let assignments: string[] = [];
  let redirects: string[] = [];
  let redirectGlobs: boolean[] = [];
  let inputs: string[] = [];
  let inputGlobs: boolean[] = [];
  let globs: boolean[] = [];
  let dynamic: boolean[] = [];
  let inner: Part[] = [];
  let w = "";
  let wordGlob = false;
  let wordDynamic = false;
  let inWord = false;
  let quoted = false;
  let qAt = -1; // length of the unquoted prefix of the current word
  let stdinFed = false;
  let mode: Mode = null;
  let hdStrip = false;
  let depth = 0;
  let loopHeader: { phase: "name" | "after-name" | "words" | "body"; keyword: "for" | "select" } | undefined;
  let compoundEndPending = false;
  let compoundRedirect = false;
  let timePending = false;
  // A part after a list or pipeline operator may not run in this shell; sticky until the scan ends.
  let conditionalOp = false;
  const cases: { phase: "subject" | "patterns" | "body"; patternStarted: boolean }[] = [];
  // A cd inside these constructs is unknown: the body may not run, or run many times.
  type Control = { kind: "if" | "loop" | "brace" | "group" | "case"; loop?: number };
  const controls: Control[] = [];
  const scopes: { id: string; children: number }[] = [{ id: scope, children: 0 }];
  const heredocs: Heredoc[] = [];
  let i = start;

  const openControl = (kind: "if" | "loop" | "brace" | "group" | "case") => controls.push({ kind });
  // A loop body gets one id that nested scans inherit, so decide can judge it as a whole.
  const openLoop = (kind: "loop" | "brace") => {
    st.nextLoop = (st.nextLoop ?? 0) + 1;
    controls.push({ kind, loop: st.nextLoop });
  };
  const closeControl = (kind: "if" | "loop" | "brace" | "group" | "case") => {
    if (controls[controls.length - 1]?.kind === kind) controls.pop();
  };
  // `}` closes the brace it belongs to, never an enclosing loop body's brace.
  const closeBrace = () => {
    const kind = controls[controls.length - 1]?.kind;
    if (kind === "brace" || kind === "group") controls.pop();
  };
  const currentLoops = () => [...parentLoops, ...controls.flatMap((control) => control.loop === undefined ? [] : [control.loop])];

  const endWord = () => {
    if (!inWord) return;
    if (mode === "redir") {
      if (!/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(w)) {
        redirects.push(w);
        redirectGlobs.push(wordGlob);
      }
    } else if (mode === "input") {
      if (!/^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+)$/.test(w)) {
        inputs.push(w);
        inputGlobs.push(wordGlob);
      }
    } else if (mode === "heredoc") {
      heredocs.push({ term: w, strip: hdStrip, expand: !quoted });
    } else if (mode === null) {
      const raw = qAt < 0 ? w : w.slice(0, qAt);
      const atStart = argv.length === 0;
      const controlStart = atStart && assignments.length === 0;
      const caseState = cases[cases.length - 1];
      let handled = false;
      // `time` runs a following compound command in the current shell; the lexer cannot follow it.
      if (timePending) {
        if (!quoted && !w.startsWith("-")) {
          timePending = false;
          if (w === "{" || w === "!" || w === "[[" || TIME_COMPOUND.has(w)) flag(st, "time before a compound command");
        }
      }
      if (loopHeader && atStart) {
        if (loopHeader.phase === "name" && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) {
          if (DANGEROUS_ASSIGNMENT.test(w)) flag(st, `dangerous loop variable ${w}`);
          loopHeader.phase = "after-name";
          handled = true;
        } else if (loopHeader.phase === "after-name" && !quoted && w === "in") {
          loopHeader.phase = "words";
          handled = true;
        } else if (loopHeader.phase === "after-name" && !quoted && w === "do") {
          loopHeader = undefined;
          openLoop("loop");
          handled = true;
        } else if (loopHeader.phase === "words") {
          handled = true;
        } else if (loopHeader.phase === "body" && !quoted && (w === "do" || w === "{")) {
          loopHeader = undefined;
          openLoop(w === "{" ? "brace" : "loop");
          handled = true;
        } else {
          flag(st, "malformed for/select header");
          loopHeader = undefined;
        }
      }
      if (!handled && controlStart && !quoted && (w === "for" || w === "select")) {
        loopHeader = { phase: "name", keyword: w };
        compoundEndPending = false;
        handled = true;
      }
      if (!handled) {
        if (controlStart && !quoted && w === "case") {
          cases.push({ phase: "subject", patternStarted: false });
          openControl("case");
          compoundEndPending = false;
        } else if (controlStart && !quoted && w === "esac") {
          if (caseState && caseState.phase !== "subject") cases.pop();
          else flag(st, "esac without case body");
          closeControl("case");
          compoundEndPending = true;
        } else if (caseState?.phase === "subject") {
          if (!quoted && w === "in") caseState.phase = "patterns";
        } else if (caseState?.phase === "patterns") {
          caseState.patternStarted = true;
        } else if (controlStart && !quoted && w === "}") {
          closeBrace();
          compoundEndPending = true;
        } else if (controlStart && !quoted && (w === "fi" || w === "done")) {
          closeControl(w === "fi" ? "if" : "loop");
          compoundEndPending = true;
        } else if (controlStart && !quoted && RESERVED.has(w)) {
          if (w === "if") openControl("if");
          else if (w === "while" || w === "until") openLoop("loop");
          else if (w === "{") openControl("group");
          compoundEndPending = false;
        } else if (atStart && ASSIGNMENT.test(raw)) {
          compoundEndPending = false;
          assignments.push(w);
        } else {
          compoundEndPending = false;
          argv.push(w);
          globs.push(wordGlob);
          dynamic.push(wordDynamic);
        }
      }
      if (!handled && controlStart && !quoted && w === "time") timePending = true;
    }
    w = "";
    wordGlob = false;
    wordDynamic = false;
    inWord = false;
    quoted = false;
    qAt = -1;
    mode = null;
  };
  const childScope = () => {
    const parent = scopes[scopes.length - 1];
    return `${parent.id}/${++parent.children}`;
  };
  const endCmd = () => {
    endWord();
    timePending = false;
    if (mode === "heredoc") flag(st, "heredoc without delimiter");
    if (mode === "redir" || mode === "input") flag(st, `redirect without target`);
    mode = null;
    if (argv.length > 0) checkRunner(argv, stdinFed, st);
    stdinFed = false;
    if (argv.length > 0 || redirects.length > 0 || inputs.length > 0 || assignments.length > 0) {
      // `conditional`: may not run. `loops`: the loop bodies it re-runs in, inherited by nested scans.
      const conditional = conditionalOp || controls.some((control) => control.kind !== "group");
      const loops = currentLoops();
      out.push({ argv, assignments, redirects, inputs, globs, dynamic, redirectGlobs, inputGlobs, text: argv.length ? argv.join(" ") : assignments.join(" "), scope: scopes[scopes.length - 1].id, ...(compoundRedirect ? { compoundRedirect: true } : {}), ...(conditional ? { conditional: true } : {}), ...(loops.length > 0 ? { loops } : {}) });
    }
    out.push(...inner);
    argv = [];
    assignments = [];
    redirects = [];
    redirectGlobs = [];
    inputs = [];
    inputGlobs = [];
    globs = [];
    dynamic = [];
    inner = [];
    compoundRedirect = false;
    compoundEndPending = false;
  };
  const flushControlInner = () => {
    out.push(...inner);
    inner = [];
  };
  const mark = () => {
    if (!quoted) qAt = w.length;
    inWord = quoted = true;
  };
  const sub = (parts: Part[]) => {
    w += PLACEHOLDER;
    wordDynamic = true;
    inWord = true;
    inner.push(...parts);
  };
  const backtick = (): boolean => {
    const r = readBacktick(s, i + 1);
    if (r.end < 0) {
      flag(st, "unterminated backtick");
      i = s.length;
      return false;
    }
    sub(scan(r.text, st, 0, null, childScope(), currentLoops()).parts);
    i = r.end;
    return true;
  };
  const dollarParen = () => {
    if (s[i + 2] === "(") return arith();
    const r = scan(s, st, i + 2, ")", childScope(), currentLoops());
    sub(r.parts);
    i = r.end;
  };
  const parameterExpansion = () => {
    let depth = 1;
    let end = i + 2;
    for (; end < s.length; end++) {
      if (s[end] === "\\") end++;
      else if (s[end] === "$" && s[end + 1] === "{") { depth++; end++; }
      else if (s[end] === "}" && --depth === 0) break;
    }
    if (end >= s.length) {
      flag(st, "unterminated parameter expansion");
      i = s.length;
      return;
    }
    const body = s.slice(i + 2, end);
    wordDynamic = true;
    if (body.includes("$(") || body.includes("`")) flag(st, "command substitution in parameter expansion");
    if (body.includes("=")) flag(st, "parameter expansion assignment");
    if (body.startsWith("!")) flag(st, "indirect parameter expansion");
    for (const index of body.matchAll(/\[([^\]]*)\]/g)) {
      if (/[A-Za-z_]/.test(index[1])) flag(st, "variable array index expansion");
    }
    const colon = body.indexOf(":");
    if (colon >= 0) {
      const offset = body.slice(colon + 1);
      if (!/^[-+=?]/.test(offset)) {
        const [start, length, ...rest] = offset.split(":");
        if (!/^\s*[+-]?\d+\s*$/.test(start) || (length !== undefined && !/^\s*[+-]?\d+\s*$/.test(length)) || rest.length > 0) {
          flag(st, "parameter expansion uses a dynamic substring offset");
        }
      }
    }
    w += "$";
    inWord = true;
    i++;
  };
  const dollarBracket = () => {
    const end = s.indexOf("]", i + 2);
    if (end < 0) {
      flag(st, "unterminated arithmetic expansion");
      i = s.length;
      return;
    }
    const body = s.slice(i + 2, end);
    wordDynamic = true;
    if (/[A-Za-z_]/.test(body)) flag(st, "arithmetic expansion references variables");
    w += "$[ … ]";
    inWord = true;
    i = end + 1;
  };
  // $(( … )): consume to the balanced "))" without emitting a part; nested
  // substitutions inside still produce parts.
  const arith = () => {
    wordDynamic = true;
    let j = i + 3;
    let d = 0;
    let body = "";
    while (j < s.length) {
      const c = s[j];
      if (c === "$" && s[j + 1] === "(") {
        const r = scan(s, st, j + 2, ")", childScope(), currentLoops());
        inner.push(...r.parts);
        body += "$(…)";
        j = r.end;
      } else if (c === "`") {
        const r = readBacktick(s, j + 1);
        if (r.end < 0) break;
        inner.push(...scan(r.text, st, 0, null, childScope(), currentLoops()).parts);
        body += "`…`";
        j = r.end;
      } else if (c === "(") {
        d++;
        j++;
      } else if (c === ")") {
        if (d > 0) {
          d--;
          j++;
        } else if (s[j + 1] === ")") {
          if (/[A-Za-z_]/.test(body)) flag(st, "arithmetic expansion references variables");
          w += "$((…))";
          inWord = true;
          i = j + 2;
          return;
        } else break;
      } else {
        body += c;
        j++;
      }
    }
    flag(st, "unterminated arithmetic expansion");
    i = s.length;
  };
  const arithmeticFor = () => {
    let j = i + 2;
    let nested = 0;
    let body = "";
    while (j < s.length) {
      const c = s[j];
      if (c === "$" && s[j + 1] === "(") {
        if (s[j + 2] === "(") {
          flag(st, "nested arithmetic in for header");
          const end = s.indexOf("))", j + 3);
          if (end < 0) break;
          body += "$(())";
          j = end + 2;
        } else {
          const r = scan(s, st, j + 2, ")", childScope(), currentLoops());
          inner.push(...r.parts);
          body += "$(…)";
          j = r.end;
        }
      } else if (c === "`") {
        const r = readBacktick(s, j + 1);
        if (r.end < 0) break;
        inner.push(...scan(r.text, st, 0, null, childScope(), currentLoops()).parts);
        body += "`…`";
        j = r.end;
      } else if (c === "(") {
        nested++;
        j++;
      } else if (c === ")") {
        if (nested > 0) {
          nested--;
          j++;
        } else if (s[j + 1] === ")") {
          if (/[A-Za-z_]/.test(body)) flag(st, "arithmetic expansion references variables");
          if (loopHeader) loopHeader.phase = "body";
          i = j + 2;
          return;
        } else break;
      } else if (c === "$" && s[j + 1] === "{") {
        flag(st, "parameter expansion in for arithmetic");
        const end = s.indexOf("}", j + 2);
        if (end < 0) break;
        body += "${…}";
        j = end + 1;
      } else {
        body += c;
        j++;
      }
    }
    flag(st, "unterminated arithmetic for header");
    i = s.length;
  };
  const eatHeredocs = () => {
    for (const hd of heredocs.splice(0)) {
      let found = false;
      while (i < s.length) {
        const nl = s.indexOf("\n", i);
        const line = s.slice(i, nl < 0 ? s.length : nl);
        i = nl < 0 ? s.length : nl + 1;
        if ((hd.strip ? line.replace(/^\t+/, "") : line) === hd.term) {
          found = true;
          break;
        }
        if (hd.expand && (/\$\((?!\()/.test(line) || line.includes("`"))) flag(st, "command substitution in heredoc body");
      }
      if (!found) flag(st, "unterminated heredoc");
    }
  };

  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      if (loopHeader) {
        endWord();
        if (loopHeader?.phase === "name") {
          flag(st, "malformed for/select header");
          loopHeader = undefined;
        } else if (loopHeader && (loopHeader.phase === "after-name" || loopHeader.phase === "words")) {
          loopHeader.phase = "body";
        }
        flushControlInner();
      } else {
        endCmd();
      }
      i++;
      eatHeredocs();
    } else if (c === "\\") {
      if (n === "\n") i += 2;
      else {
        mark();
        if (n !== undefined) w += n;
        i += 2;
      }
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      mark();
      if (e < 0) {
        flag(st, "unterminated single quote");
        i = s.length;
      } else {
        w += s.slice(i + 1, e);
        i = e + 1;
      }
    } else if (c === '"') {
      mark();
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          if (e === "\n") {
            /* continuation */
          } else if (e === '"' || e === "\\" || e === "$" || e === "`") w += e;
          else w += d + e;
          i += 2;
        } else if (d === "$" && s[i + 1] === "(") dollarParen();
        else if (d === "$" && s[i + 1] === "{") parameterExpansion();
        else if (d === "$" && s[i + 1] === "[") dollarBracket();
        else if (d === "$" && /[A-Za-z0-9_?$@*#!-]/.test(s[i + 1] ?? "")) { wordDynamic = true; w += d; i++; }
        else if (d === "`") backtick();
        else {
          w += d;
          i++;
        }
      }
      if (!closed) flag(st, "unterminated double quote");
    } else if (c === "$" && n === "(") {
      dollarParen();
    } else if (c === "$" && n === "{") {
      parameterExpansion();
    } else if (c === "$" && n === "[") {
      dollarBracket();
    } else if (c === "$" && /[A-Za-z0-9_?$@*#!-]/.test(n ?? "")) {
      wordDynamic = true;
      w += c;
      inWord = true;
      i++;
    } else if (c === "`") {
      backtick();
    } else if (c === "#" && !inWord) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "(" && loopHeader?.phase === "name" && loopHeader.keyword === "for" && !inWord && s[i + 1] === "(") {
      arithmeticFor();
    } else if (c === "(" || c === ")") {
      const caseState = cases[cases.length - 1];
      if (c === ")" && caseState?.phase === "patterns") {
        endWord();
        flushControlInner();
        caseState.phase = "body";
        caseState.patternStarted = false;
        i++;
      } else if (c === "(" && caseState?.phase === "patterns") {
        endWord();
        if (caseState.patternStarted) flag(st, "unsupported case pattern parentheses");
        i++;
      } else {
        endCmd();
        if (c === "(") {
          depth++;
          const id = childScope();
          scopes.push({ id, children: 0 });
        } else if (depth > 0) {
          depth--;
          scopes.pop();
          compoundEndPending = true;
        } else if (closer === ")") return { parts: finish(), end: i + 1 };
        else flag(st, "unmatched )");
        i++;
      }
    } else if (c === ";" || c === "|") {
      const caseState = cases[cases.length - 1];
      if (loopHeader && c === ";") {
        endWord();
        if (loopHeader?.phase === "name") {
          flag(st, "malformed for/select header");
          loopHeader = undefined;
        } else if (loopHeader && (loopHeader.phase === "after-name" || loopHeader.phase === "words")) {
          loopHeader.phase = "body";
        }
        flushControlInner();
        i++;
      } else if (loopHeader) {
        flag(st, "malformed for/select header");
        loopHeader = undefined;
        endCmd();
        i++;
      } else if (c === "|" && caseState?.phase === "patterns") {
        endWord();
        i++;
      } else if (c === ";" && caseState?.phase === "body" && (n === ";" || n === "&")) {
        endCmd();
        if (n === ";" && s[i + 2] === "&") i += 3;
        else i += 2;
        caseState.phase = "patterns";
        caseState.patternStarted = false;
      } else {
        // `||` and `;` run their left side here, but a pipe member runs in a subshell.
        if (c === "|" && n !== "|") conditionalOp = true;
        endCmd();
        if (c === "|") conditionalOp = true;
        i++;
      }
    } else if (c === "&") {
      if (n === ">") {
        endWord();
        if (compoundEndPending && argv.length === 0) {
          compoundRedirect = true;
          compoundEndPending = false;
        }
        i += s[i + 2] === ">" ? 3 : 2;
        mode = "redir";
      } else {
        // A single `&` backgrounds its left side; `&&` runs it here.
        if (n !== "&") conditionalOp = true;
        endCmd();
        conditionalOp = true;
        i += n === "&" ? 2 : 1;
      }
    } else if (c === ">" || c === "<") {
      if ((mode === "redir" || mode === "input") && !inWord) flag(st, "redirect without target");
      if (n === "(") {
        flag(st, "process substitution");
        endCmd();
        depth++;
        const id = childScope();
        scopes.push({ id, children: 0 });
        i += 2;
        continue;
      }
      if (inWord && !quoted && /^\d+$/.test(w)) {
        w = "";
        inWord = false;
      } else endWord();
      if (compoundEndPending && argv.length === 0) {
        compoundRedirect = true;
        compoundEndPending = false;
      }
      let j = i + 1;
      if (c === ">") {
        if (s[j] === ">" || s[j] === "|") j++;
        else if (s[j] === "&") {
          const m = FD_DUP.exec(s.slice(j + 1));
          if (m) {
            i = j + 1 + m[0].length;
            continue;
          }
          j++;
        }
        mode = "redir";
      } else if (s[j] === "<") {
        j++;
        if (s[j] === "<") {
          j++;
          mode = "skip";
          stdinFed = true;
        } else {
          stdinFed = true;
          hdStrip = s[j] === "-";
          if (hdStrip) j++;
          mode = "heredoc";
        }
      } else if (s[j] === "&") {
        const m = FD_DUP.exec(s.slice(j + 1));
        j += 1 + (m ? m[0].length : 0);
        mode = m ? null : "skip";
      } else {
        mode = "input";
      }
      i = j;
    } else {
      if ("*?[".includes(c)) wordGlob = true;
      if (c === "{" && s[i - 1] !== "$") {
        const close = s.indexOf("}", i + 1);
        const body = close < 0 ? "" : s.slice(i + 1, close);
        if (body.includes(",") || body.includes("..")) wordGlob = true;
      }
      w += c;
      inWord = true;
      i++;
    }
  }
  if (closer === ")") flag(st, "unterminated $(");
  if (depth > 0) flag(st, "unmatched (");
  const finished = finish();
  if (loopHeader) flag(st, "malformed for/select header");
  if (cases.length > 0) flag(st, "unterminated case statement");
  return { parts: finished, end: s.length };

  function finish(): Part[] {
    endCmd();
    if (heredocs.length > 0) flag(st, "unterminated heredoc");
    return out;
  }
}

// Commands that run code the lexer cannot see: fail closed.
const WRAPPERS = new Set(["env", "command", "nohup", "time", "nice", "timeout"]);
const OPTION_VALUE = new Set(["-n", "-s", "-k", "-u", "-C"]);

function checkRunner(argv: string[], stdinFed: boolean, st: State): void {
  let i = 0;
  let name = "";
  for (;;) {
    const word = argv[i] ?? "";
    if (word.includes("$")) return flag(st, "command word is a variable");
    name = word.split("/").pop() ?? "";
    if (!WRAPPERS.has(name)) break;
    i++;
    while (i < argv.length) {
      const a = argv[i];
      if (a.startsWith("-")) i += OPTION_VALUE.has(a) ? 2 : 1;
      else if (name === "env" && ASSIGNMENT.test(a)) i++;
      else if (name === "timeout" && /^\d/.test(a)) i++;
      else break;
    }
    if (i >= argv.length) return;
  }
  if (["eval", "source", ".", "exec"].includes(name)) return flag(st, `${name} runs unparsed code`);
  if (!SHELLS.has(name)) return;
  const args = argv.slice(i + 1);
  if (args.some((a) => /^-[a-z]*c[a-z]*$/.test(a))) flag(st, `${name} -c runs unparsed code`);
  else if (stdinFed || !args.some((a) => !a.startsWith("-")) || args.includes("-s")) {
    flag(st, `${name} reads script from stdin`);
  }
}
