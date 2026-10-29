// Shell lexer: splits a bash command into parts so rules match per sub-command,
// never against raw text. Fails closed (`unsafe`) on anything it cannot vouch for.

export type Part = { argv: string[]; redirects: string[]; text: string };
export type ParseResult = { parts: Part[]; unsafe?: string };

type State = { unsafe?: string };
type Heredoc = { term: string; strip: boolean; expand: boolean };
type Mode = null | "redir" | "skip" | "heredoc";

const PLACEHOLDER = "$(…)";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

function scan(s: string, st: State, start: number, closer: ")" | null): { parts: Part[]; end: number } {
  const out: Part[] = [];
  let argv: string[] = [];
  let redirects: string[] = [];
  let inner: Part[] = [];
  let w = "";
  let inWord = false;
  let quoted = false;
  let mode: Mode = null;
  let hdStrip = false;
  let depth = 0;
  const heredocs: Heredoc[] = [];
  let i = start;

  const endWord = () => {
    if (!inWord) return;
    if (mode === "redir") {
      if (w !== "/dev/null") redirects.push(w);
    } else if (mode === "heredoc") {
      heredocs.push({ term: w, strip: hdStrip, expand: !quoted });
    } else if (mode === null && !(argv.length === 0 && !quoted && ASSIGNMENT.test(w))) {
      argv.push(w);
    }
    w = "";
    inWord = false;
    quoted = false;
    mode = null;
  };
  const endCmd = () => {
    endWord();
    mode = null;
    if (argv.length > 0 || redirects.length > 0) out.push({ argv, redirects, text: argv.join(" ") });
    out.push(...inner);
    argv = [];
    redirects = [];
    inner = [];
  };
  const sub = (parts: Part[]) => {
    w += PLACEHOLDER;
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
    sub(scan(r.text, st, 0, null).parts);
    i = r.end;
    return true;
  };
  const dollarParen = () => {
    const r = scan(s, st, i + 2, ")");
    sub(r.parts);
    i = r.end;
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
        if (hd.expand && (line.includes("$(") || line.includes("`"))) flag(st, "command substitution in heredoc body");
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
      endCmd();
      i++;
      eatHeredocs();
    } else if (c === "\\") {
      if (n === "\n") i += 2;
      else {
        if (n !== undefined) w += n;
        inWord = quoted = true;
        i += 2;
      }
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      inWord = quoted = true;
      if (e < 0) {
        flag(st, "unterminated single quote");
        i = s.length;
      } else {
        w += s.slice(i + 1, e);
        i = e + 1;
      }
    } else if (c === '"') {
      inWord = quoted = true;
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
        else if (d === "`") backtick();
        else {
          w += d;
          i++;
        }
      }
      if (!closed) flag(st, "unterminated double quote");
    } else if (c === "$" && n === "(") {
      dollarParen();
    } else if (c === "`") {
      backtick();
    } else if (c === "#" && !inWord) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "(" || c === ")") {
      endCmd();
      if (c === "(") depth++;
      else if (depth > 0) depth--;
      else if (closer === ")") return { parts: finish(), end: i + 1 };
      i++;
    } else if (c === ";" || c === "|") {
      endCmd();
      i++;
    } else if (c === "&") {
      if (n === ">") {
        endWord();
        i += s[i + 2] === ">" ? 3 : 2;
        mode = "redir";
      } else {
        endCmd();
        i += n === "&" ? 2 : 1;
      }
    } else if (c === ">" || c === "<") {
      if (n === "(") {
        flag(st, "process substitution");
        endCmd();
        depth++;
        i += 2;
        continue;
      }
      if (inWord && !quoted && /^\d+$/.test(w)) {
        w = "";
        inWord = false;
      } else endWord();
      let j = i + 1;
      if (c === ">") {
        if (s[j] === ">" || s[j] === "|") j++;
        else if (s[j] === "&") {
          const m = /^(\d+-?|-)/.exec(s.slice(j + 1));
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
        } else {
          hdStrip = s[j] === "-";
          if (hdStrip) j++;
          mode = "heredoc";
        }
      } else if (s[j] === "&") {
        const m = /^(\d+-?|-)/.exec(s.slice(j + 1));
        j += 1 + (m ? m[0].length : 0);
        mode = m ? null : "skip";
      } else mode = "skip";
      i = j;
    } else {
      w += c;
      inWord = true;
      i++;
    }
  }
  if (closer === ")") flag(st, "unterminated $(");
  return { parts: finish(), end: s.length };

  function finish(): Part[] {
    endCmd();
    if (heredocs.length > 0) flag(st, "unterminated heredoc");
    return out;
  }
}
