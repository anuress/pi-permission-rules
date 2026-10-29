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

test("assignments stripped", () => {
  assert.deepEqual(texts("FOO=1 BAR=2 ./gradlew :app:test"), ["./gradlew :app:test"]);
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

test("fuzz never throws", () => {
  const alpha = ["a", "'", '"', "`", "$", "(", ")", "<", ">", "|", "&", ";", "\\", "\n", " ", "#", "="];
  for (let i = 0; i < 2000; i++) {
    let s = "";
    const n = Math.floor(Math.random() * 30);
    for (let j = 0; j < n; j++) s += alpha[Math.floor(Math.random() * alpha.length)];
    const r = parse(s);
    assert.ok(r.unsafe !== undefined || Array.isArray(r.parts), s);
  }
});
