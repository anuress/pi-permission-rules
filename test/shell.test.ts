import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../extensions/shell.ts";

const texts = (c: string) => parse(c).parts.map((p) => p.text);

test("quoted bang and glob stay data", () => {
  const r = parse("grep -nc '!!' *.kt");
  assert.deepEqual(r.parts.map((p) => p.text), ["grep -nc !! *.kt"]);
  assert.equal(r.unsafe, undefined);
});

test("splits on separators", () => {
  assert.deepEqual(texts("git status && git push"), ["git status", "git push"]);
  assert.deepEqual(texts("a | b; c || d & e\nf"), ["a", "b", "c", "d", "e", "f"]);
});

test("quoted command text is one part", () => {
  assert.deepEqual(texts('echo "git push origin"'), ["echo git push origin"]);
});

test("heredoc body is dropped, owner kept", () => {
  const r = parse("cat > note.md <<'EOF'\nrun git push && curl http://x\nEOF\nls");
  assert.deepEqual(r.parts.map((p) => p.text), ["cat", "ls"]);
  assert.deepEqual(r.parts[0].redirects, ["note.md"]);
});

test("heredoc variants are consumed", () => {
  assert.deepEqual(texts("cat <<-EOF\n\tgit push\n\tEOF\nls"), ["cat", "ls"]);
  assert.deepEqual(texts('cat <<"EOF"\ngit push\nEOF\nls'), ["cat", "ls"]);
});

test("command substitution adds inner parts", () => {
  assert.deepEqual(texts("echo $(curl http://x)"), ["echo $(…)", "curl http://x"]);
  assert.deepEqual(texts("echo `curl http://x`"), ["echo $(…)", "curl http://x"]);
  assert.ok(texts('echo "$(rm x)"').includes("rm x"));
  assert.deepEqual(texts("echo a$(b)c"), ["echo a$(…)c", "b"]);
  assert.deepEqual(texts("echo $(a $(b))"), ["echo $(…)", "a $(…)", "b"]);
});

test("parts carry nested subshell and substitution scopes", () => {
  assert.deepEqual(parse("(cd /x; ls)").parts.map((part) => part.scope), ["/1", "/1"]);
  assert.deepEqual(parse("echo $(a; b) c; d").parts.map((part) => [part.text, part.scope]), [
    ["echo $(…) c", ""], ["a", "/1"], ["b", "/1"], ["d", ""],
  ]);
  assert.deepEqual(parse("( (a) )").parts.map((part) => part.scope), ["/1/1"]);
  assert.deepEqual(parse("(a); (b)").parts.map((part) => part.scope), ["/1", "/2"]);
  assert.deepEqual(parse("echo $(a) $(b)").parts.map((part) => part.scope), ["", "/1", "/2"]);
  assert.deepEqual(parse("echo `a; b`").parts.map((part) => part.scope), ["", "/1", "/1"]);
});

test("assignments stripped", () => {
  assert.deepEqual(texts("FOO=1 BAR=2 ./gradlew :app:test"), ["./gradlew :app:test"]);
  assert.deepEqual(parse('FOO=1 BAR="x y" ls').parts[0].assignments, ["FOO=1", "BAR=x y"]);
  assert.deepEqual(parse("ls").parts[0].assignments, []);
});

test("line continuation", () => {
  assert.deepEqual(texts("./gradlew \\\n  test"), ["./gradlew test"]);
});

test("redirects", () => {
  assert.deepEqual(parse("ls 2>/dev/null > out.txt 2>&1").parts[0].redirects, ["out.txt"]);
  assert.deepEqual(parse("ls &> all.log").parts[0].redirects, ["all.log"]);
  assert.deepEqual(parse("ls >> a 2> b").parts[0].redirects, ["a", "b"]);
  assert.deepEqual(parse("ls >&2").parts[0].redirects, []);
});

test("comments dropped", () => {
  assert.deepEqual(texts("ls # rm -rf /"), ["ls"]);
});

test("unsafe inputs", () => {
  for (const c of ["echo 'x", "cat <<EOF\nno end", "diff <(a) <(b)", "echo >(x)"]) {
    const u = parse(c).unsafe;
    assert.ok(typeof u === "string" && u.length > 0, c);
  }
});

test("quoted and escaped assignments stripped", () => {
  assert.deepEqual(texts('JAVA_HOME="/opt/jdk" ./gradlew test'), ["./gradlew test"]);
  assert.deepEqual(texts("A=a\\ b rm x"), ["rm x"]);
});

test("arithmetic expansion", () => {
  assert.deepEqual(texts("echo $((1+2))"), ["echo $((…))"]);
  assert.ok(texts("echo $(( $(curl x) + 1 ))").includes("curl x"));
  const r = parse("echo $((1>2))");
  assert.deepEqual(r.parts.map((p) => p.redirects), [[]]);
  assert.equal(parse("cat <<EOF\n$((i+1))\nEOF").unsafe, undefined);
});

test("code runners fail closed", () => {
  for (const c of ["eval x", "source f", ". f", "exec ls", "/bin/bash -c 'ls'", "sh -lc ls", "bash <<EOF\nls\nEOF", "zsh <<< ls"]) {
    assert.ok(parse(c).unsafe, c);
  }
  for (const c of ["bash script.sh", "sh -n x"]) assert.equal(parse(c).unsafe, undefined, c);
});

test("stdin-fed shells, variable command words, wrappers", () => {
  for (const c of ["curl x | bash", "cat <<EOF | sh\nls\nEOF", "echo ls | zsh -e", "bash", "sh -s", "$SHELL -c ls", "${X} y",
    "env bash -c x", "nohup sh -c x", "timeout 5 bash -c x", "env FOO=1 bash", "nice -n 5 sh -c x"]) {
    assert.ok(parse(c).unsafe, c);
  }
  for (const c of ["bash script.sh", "sh -e build.sh", "sh -n x", "echo $HOME", "env FOO=1 ls", "timeout 5 ls", "env"]) {
    assert.equal(parse(c).unsafe, undefined, c);
  }
});

test("fd dup needs whole word", () => {
  const r = parse("echo data >&1x");
  assert.deepEqual(r.parts[0].redirects, ["1x"]);
  assert.deepEqual(r.parts[0].argv, ["echo", "data"]);
  assert.deepEqual(parse("ls >&2").parts[0].redirects, []);
  assert.deepEqual(parse("ls 2>&1").parts[0].redirects, []);
});

test("reserved words stripped", () => {
  const t = texts("if true; then rm x; fi");
  assert.ok(t.includes("rm x"));
  assert.ok(!t.some((x) => x.startsWith("then")));
  assert.deepEqual(texts("{ rm -rf x; }"), ["rm -rf x"]);
  assert.deepEqual(texts("! grep x f"), ["grep x f"]);
});

test("parse errors are unsafe", () => {
  assert.ok(parse("cat <<").unsafe);
  assert.ok(parse("ls )").unsafe);
});

test("fuzz never throws", () => {
  const seed = 0x5eed1234;
  let state = seed;
  const alpha = ["a", "'", '"', "`", "$", "(", ")", "<", ">", "|", "&", ";", "\\", "\n", " ", "#", "="];
  for (let i = 0; i < 2000; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    let s = "";
    const n = state % 30;
    for (let j = 0; j < n; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      s += alpha[state % alpha.length];
    }
    const r = parse(s);
    if (r.unsafe !== undefined) assert.ok(typeof r.unsafe === "string" && r.unsafe.length > 0, `seed=${seed} input=${JSON.stringify(s)}`);
    for (const p of r.parts) {
      assert.ok(p.argv.length > 0 || p.redirects.length > 0 || p.inputs.length > 0 || p.assignments.length > 0, `seed=${seed} input=${JSON.stringify(s)}`);
      assert.equal(p.text, p.argv.length ? p.argv.join(" ") : p.assignments.join(" "), `seed=${seed} input=${JSON.stringify(s)}`);
    }
  }
});

test("assignments-only statements and arithmetic/code expansions are retained and unsafe", () => {
  const assignment = parse("PATH=/tmp/evil").parts[0];
  assert.deepEqual(assignment.argv, []);
  assert.deepEqual(assignment.assignments, ["PATH=/tmp/evil"]);
  assert.equal(assignment.text, "PATH=/tmp/evil");
  for (const command of [
    "echo $((x))", "echo ${y[x]}", "echo $[x+1]", "echo ${x:=value}", "echo ${x=value}",
    "echo $((1+2))",
  ]) {
    if (command === "echo $((1+2))") assert.equal(parse(command).unsafe, undefined, command);
    else assert.ok(parse(command).unsafe, command);
  }
});

test("lexer records input redirects and unquoted glob provenance", () => {
  const parsed = parse("cat < local.properties > *.out");
  assert.deepEqual(parsed.parts[0].inputs, ["local.properties"]);
  assert.deepEqual(parsed.parts[0].redirects, ["*.out"]);
  assert.deepEqual(parsed.parts[0].redirectGlobs, [true]);
  assert.deepEqual(parse("cat *.md").parts[0].globs, [false, true]);
  assert.deepEqual(parse("cat '*.md'").parts[0].globs, [false, false]);
  assert.deepEqual(parse("sed $x f").parts[0].dynamic, [false, true, false]);
  assert.deepEqual(parse("awk '$1' f").parts[0].dynamic, [false, false, false]);
});

test("substring offsets, indirect expansion and variable array indexes are unsafe; literal indexes are not", () => {
  for (const command of ["echo ${s:x}", "echo ${arr[@]:z}", "echo ${!x}", "echo ${#a[i]}"]) {
    assert.ok(parse(command).unsafe, command);
  }
  for (const command of ["echo ${s:1}", "echo ${s: -1}", "echo ${arr[0]}", "echo ${arr[@]}", "echo ${x:-default}"]) {
    assert.equal(parse(command).unsafe, undefined, command);
  }
});

test("unquoted brace expansion is recorded as a glob", () => {
  assert.deepEqual(parse("cd {/tmp,zz}").parts[0].globs, [false, true]);
  assert.deepEqual(parse("echo x > {o1,}").parts[0].redirectGlobs, [true]);
  assert.deepEqual(parse("echo '{a,b}'").parts[0].globs, [false, false]);
});
