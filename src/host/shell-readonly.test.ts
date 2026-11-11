import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShell } from "./shell-readonly.ts";

test("commands that only read are said to, and everything uncertain is not", () => {
  for (const command of [
    "ls -la",
    "cat README.md | head -50",
    "git status && git log --oneline -5",
    "git diff HEAD~1 -- src/",
    "grep -rn 'TODO' src | wc -l",
    "find . -name '*.ts' -newer package.json",
    "sed -n '1,20p' file.txt",
    "docker ps -a; docker logs agentbox-box",
    "npm ls --depth=0",
    "ps aux | grep node",
    "echo 'a > b in quotes' | tr a-z A-Z",
    "git branch -a",
    "git stash list",
    "sort notes.txt",
    "xxd in.bin",
    "rg TODO src",
    "mount",
  ]) {
    assert.deepEqual(classifyShell(command), { readOnly: true }, command);
  }
  const notReadOnly: [string, RegExp][] = [
    ["ls > out.txt", /redirection/],
    ["cat $(which node)", /substitution/],
    ["sudo ls", /sudo/],
    ["rm -rf /tmp/x", /rm/],
    ["find . -name '*.log' -delete", /find with an action flag/],
    ["sed -i 's/a/b/' file", /sed -i/],
    ["git push origin main", /git push/],
    ["git branch -D old", /changes refs/],
    ["git checkout -b x", /git checkout/],
    ["docker run -it ubuntu", /docker run/],
    ["npm install left-pad", /npm install/],
    ["node script.js", /running code/],
    ["FOO=1 ls", /environment prefix/],
    ["curl https://example.com", /curl/],
    ["somebinary --flag", /not a known reader/],
    ["ls 'unterminated", /unbalanced quotes/],
    ["awk '{ system(\"rm x\") }' file", /awk/],
    ["echo hi | tee log", /tee/],
    ["sort -o /tmp/out.txt in.txt", /sort -o/],
    ["sort -ro /tmp/out.txt in.txt", /sort -o/],
    ["sort --output=/tmp/out.txt in.txt", /sort -o/],
    ["sort --compress-program=/tmp/evil in.txt", /sort --compress-program/],
    ["xxd in.bin out.hex", /xxd writing a file/],
    ["rg --pre ./evil x", /rg --pre/],
    ["rg --pre=./evil x", /rg --pre/],
    ["rg --pre-glob '*.ts' TODO src", /rg --pre/],
    ["ag --pre ./evil x", /ag --pre/],
    ["git diff --output=/tmp/out.txt", /git --output/],
    ["git log --output /tmp/out.txt", /git --output/],
    ["mount /dev/disk1s1 /Volumes/x", /mount attaching a filesystem/],
    ["mount -a", /mount attaching a filesystem/],
    ["", /empty/],
  ];
  for (const [command, why] of notReadOnly) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});
