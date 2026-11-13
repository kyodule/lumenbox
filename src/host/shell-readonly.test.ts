import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShell, GUARDED_NAMES, scanShell, segments, stripDiscardRedirects, unmodelledSyntax, words, wordSpans } from "./shell-readonly.ts";

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
    "cd /tmp",
    "cd ..",
    "cd /tmp && ls",
    "git -C /tmp/repo status",
    "git -C a -C b log -1",
    "command -v node",
    "command -V ls",
    "ls 2>/dev/null",
    "ls >/dev/null",
    "ls >>/dev/null",
    "ls &>/dev/null",
    "ls 2>&1",
    "ls >&2",
    "ls 1>&2",
    "cat </dev/null",
    "ls 2>/dev/null 2>&1 >/dev/null",
    "echo hi >/dev/null && ls",
    'grep "2>/dev/null" f',
    // F3: a dangerous word among the arguments is a pattern or a file, not a command.
    "grep -rn source src",
    "grep -rn time src",
    "cat make",
    "grep -rn rm /tmp",
    "rg --column 'exec' src",
    // F1 and F2: what stays a read after the new rules.
    "echo x 2>&1",
    "echo x >&2",
    "ls 2>&1 | head -3",
    "git grep pattern",
    "tree src",
    "uniq in.txt",
    "uniq -f 2 in.txt",
    "file notes.txt",
    "awk '{print $1}' data",
    "awk '$3 > 100' data",
    "sed -n '1,20p' f",
    "sed 's/a/b/' f",
    "sed 's/a/b/g' f",
    "sed '1,20d' f",
    "sed '$p' f",
    "sed -e 's/a/b/' -e '1p' f",
    "less notes.txt",
    "date",
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
    // E3: what looks like a harmless read is still a write, or still runs something.
    ["cd /x && rm -rf .", /rm/],
    ["git -C /tmp/repo push origin", /git push/],
    ["git -c core.pager=less status", /git -c/],
    ["git branch -C old new", /changes refs/],
    ["command ls", /command running a program/],
    ["command rm x", /command running a program/],
    ["ls >/dev/null/../x", /redirection/],
    ["ls >/dev/nullx", /redirection/],
    ["ls >&file", /redirection/],
    ["echo x >> file", /redirection/],
    ["VAR=1; ls", /environment prefix/],
    ["bash -c ls", /bash/],
    ["perl -e 1", /not a known reader/],
    ["for i in a; do echo $i; done", /for is not a known reader/],
    // F1: `>&1file` is a file called 1file, not a descriptor copy.
    ["echo x >&1file", /redirection/],
    ["echo x 2>&1file", /redirection/],
    // F2: options that write a file or run a program.
    ["git grep -O'touch /tmp/pwn' x", /git grep running a program/],
    ["git grep --open-files-in-pager=sh x", /git grep running a program/],
    ["git --config-env=core.pager=X log", /git global option --config-env/],
    ["git --paginate log", /git global option/],
    ["rg --hostname-bin ./evil x", /rg --hostname-bin/],
    ["ag --pager 'touch /tmp/x' x", /ag --pager/],
    ["tree -o /tmp/out.txt", /tree -o/],
    ["tree --output /tmp/out.txt", /tree -o/],
    ["uniq in.txt out.txt", /uniq writing its second file/],
    ["file -C -m magic", /file -C/],
    ["file --compile -m magic", /file -C/],
    ["less -o /tmp/log notes.txt", /less writing a log file/],
    ["more -O /tmp/log notes.txt", /more writing a log file/],
    ["date -s '2020-01-01'", /date setting the clock/],
    ["hostname evil", /hostname setting the name/],
    ["diff --paginate a b", /diff running a pager/],
    ["awk 'BEGIN{\"touch /tmp/pwn\" | getline}'", /awk piping into getline/],
    ["awk -f evil.awk data", /awk reading a program from a file/],
    ["awk '{print > $1}' data", /awk writing a file or a pipe/],
    ["awk 'BEGIN{system(\"touch /tmp/pwn\")}'", /awk system/],
    ["sed 's/a/b/w out.txt' f", /sed script that may write or run/],
    ["sed -n 'w out.txt' f", /sed script that may write or run/],
    ["sed -f script.sed f", /sed -f/],
    ["sed '1e touch /tmp/pwn' f", /sed script that may write or run/],
    ["sed -e 's/a/b/' -e 'w out.txt' f", /sed script that may write or run/],
    ["git log --ext-diff", /external diff/],
    ["", /empty/],
  ];
  for (const [command, why] of notReadOnly) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});

test("words are joined the way zsh joins them (G1): adjacent pieces are one word, escapes are resolved", () => {
  assert.deepEqual(words('-"delete"'), ["-delete"]);
  assert.deepEqual(words("-de\\lete"), ["-delete"]);
  assert.deepEqual(words('gr""ep'), ["grep"]);
  assert.deepEqual(words('l"s"'), ["ls"]);
  assert.deepEqual(words("r\\m"), ["rm"]);
  assert.deepEqual(words("\"a b\""), ["a b"]);
  assert.deepEqual(words("'a b'"), ["a b"], "a quoted space does not split a word");
  assert.equal(words("'unclosed"), null, "an open quote cannot be read");
  // `$` and backticks outside single quotes mean the word is built at run time.
  assert.deepEqual(wordSpans("cat $HOME/f"), [{ text: "cat", expands: false }, { text: "$HOME/f", expands: true }]);
  assert.deepEqual(wordSpans("cat '$HOME'"), [{ text: "cat", expands: false }, { text: "$HOME", expands: false }], "single quotes are literal");
  assert.deepEqual(wordSpans('cat "$HOME"'), [{ text: "cat", expands: false }, { text: "$HOME", expands: true }]);
  assert.deepEqual(wordSpans("cat \\$HOME"), [{ text: "cat", expands: false }, { text: "$HOME", expands: false }], "an escaped $ is literal");
  assert.deepEqual(wordSpans("find . -de\\lete"), [{ text: "find", expands: false }, { text: ".", expands: false }, { text: "-delete", expands: false }]);
});

test("segments, the redirect stripper and the words agree on where the quotes are (G1)", () => {
  // zsh does not split on these separators: they are inside quotes or escaped.
  assert.deepEqual(segments("echo 'a;b' && ls"), ["echo 'a;b'", "ls"]);
  assert.deepEqual(segments('echo "x|y" ; ls'), ['echo "x|y"', "ls"]);
  assert.deepEqual(segments("echo a\\;b"), ["echo a\\;b"]);
  // the stripper leaves a quoted /dev/null alone, as the scanner says it is not a redirection
  assert.equal(stripDiscardRedirects("grep '2>/dev/null' f"), "grep '2>/dev/null' f");
  assert.equal(stripDiscardRedirects("echo a\\>b"), "echo a\\>b");
  // and the words of one segment are the words the scanner counted
  for (const command of ["echo 'a;b' && ls", 'echo "x|y" ; ls', "echo a\\;b", 'l"s" -la']) {
    const scan = scanShell(command);
    assert.equal(scan.balanced, true, command);
    for (const part of segments(command) ?? []) assert.notEqual(words(part), null, part);
  }
});

test("syntax this file does not model is not a read (G2): zsh runs something the words do not show", () => {
  const cases: [string, RegExp][] = [
    // a subshell or a zsh glob qualifier: zsh runs what is inside
    ["(rm x)", /subshell or a pattern qualifier/],
    ["ls *(e:'touch /tmp/pwn':)", /subshell or a pattern qualifier/],
    ["cat =(touch /tmp/pwn)", /subshell or a pattern qualifier/],
    ["ls <(touch /tmp/pwn)", /subshell or a pattern qualifier/],
    // ANSI-C quoting has its own escape rules, so a scan of it is off by one
    [String.raw`echo $'\'' ; rm x #'`, /ANSI-C or localised quote/],
    [String.raw`echo $"x"`, /ANSI-C or localised quote/],
    // brace expansion turns one word into several (`find . -{delete,print}` runs -delete)
    ["find . -{delete,print}", /brace expansion/],
    ["ls {a,b}", /brace expansion/],
    // substitutions run inside double quotes too (`echo "$(rm x)"` runs rm)
    ["echo $(rm x)", /command substitution/],
    ["echo `rm x`", /command substitution/],
    ['echo "$(rm x)"', /command substitution/],
    ['echo "`rm x`"', /command substitution/],
    ['cat "$(touch /tmp/pwn)"', /command substitution/],
    // `${x:-…}` is refused as an unmodelled expansion before the inner `$(` is looked at
    ["echo ${x:-$(id -u)}", /expansion that is not modelled/],
  ];
  for (const [command, why] of cases) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
  // what is not a brace expansion, and what is escaped, stays a read
  assert.equal(classifyShell("echo ${PATH}").readOnly, true);
  assert.equal(classifyShell('echo "$HOME"').readOnly, true, "a variable is not a substitution");
  assert.equal(classifyShell("echo '$(rm x)'").readOnly, true, "single quotes are literal");
  assert.equal(classifyShell("find . -name x {} +").readOnly, true);
  assert.equal(classifyShell("git log HEAD@{1}").readOnly, true);
  assert.equal(classifyShell("find . \\( -name a -o -name b \\)").readOnly, true, "escaped parentheses are find's arguments");
  assert.equal(unmodelledSyntax("find . \\( -name a \\)"), undefined);
});

test("an expansion inside a checked program's arguments is not a read (G3): `find . -${HOME:+delete}` deletes", () => {
  for (const command of ["find . -$FLAG", "sort -$O /tmp/y in", "rg $PATTERN src", "sed -e $S f", 'find . "-$FLAG"']) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, /expansion in .* arguments/, command);
  }
  // the more elaborate forms are refused earlier, as syntax this file does not model (H3)
  for (const command of ["find . -${HOME:+delete}", 'find . "-${HOME:+delete}"', 'echo "${(e):-\\$(touch pwn)}"']) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, /expansion that is not modelled/, command);
  }
  // programs with no argument checks may still use expansions: expanding only chooses what to read
  for (const command of ["cat $HOME/.zshrc", 'ls "$HOME"', "echo ${PATH}", "grep -rn foo ${PWD}/src", "head -5 $FILE"]) {
    assert.equal(classifyShell(command).readOnly, true, command);
  }
});

test("every program with its own check is in the guarded set (G3), so the expansion rule cannot miss one", () => {
  const expected = ["find", "sed", "awk", "gawk", "git", "docker", "podman", "npm", "pnpm", "yarn", "node", "python", "python3", "kubectl", "systemctl", "command", "sort", "xxd", "rg", "ag", "tree", "uniq", "file", "less", "more", "date", "hostname", "diff", "mount", "sleep"];
  for (const name of expected) assert.equal(GUARDED_NAMES.has(name), true, name);
  assert.equal(GUARDED_NAMES.size, new Set(expected).size, "no guarded program is missing from the list");
});

test("sed's options are a whitelist, so a glued -e cannot hide a script (G4)", () => {
  // zsh runs `sed -es/a/b/w /tmp/pwn` as -e 's/a/b/w /tmp/pwn'
  const refused = ["sed '-es/a/b/w /tmp/pwn' 1p f", "sed -z 's/a/b/' f", "sed --unknown f", "sed -i.bak 's/a/b/' f"];
  for (const command of refused) assert.equal(classifyShell(command).readOnly, false, command);
  const reads = ["sed -n '1,5p' f", "sed -E 's/a+/b/g' f", "sed -ne '1,5p' f", "sed -nE 's/a/b/' f", "sed -n -e 1p -e 5p f", "sed --expression='s/a/b/' f", "sed --quiet 'p' f"];
  for (const command of reads) assert.equal(classifyShell(command).readOnly, true, command);
});

test("git's sub-actions and options are checked by what they do (G5)", () => {
  const refused: [string, RegExp][] = [
    ["git reflog expire --expire=now --all", /git reflog rewriting history/],
    ["git reflog delete HEAD@{1}", /git reflog rewriting history/],
    ["git branch newbranch", /git branch creating a ref/],
    ["git tag v9.9.9", /git tag creating a ref/],
    ["git branch -D old", /git branch that changes refs/],
  ];
  for (const [command, why] of refused) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
  const reads = ["git reflog", "git reflog show --date=iso", "git branch", "git branch -a", "git branch -vv", "git branch --list 'ours/*'", "git branch --contains HEAD", "git tag", "git tag -l 'v0.3.*'", "git status"];
  for (const command of reads) assert.equal(classifyShell(command).readOnly, true, command);
  // npm audit fix is a positional sub-action, not --fix
  assert.equal(classifyShell("npm audit fix").readOnly, false);
  assert.equal(classifyShell("npm audit").readOnly, true);
  // an `o` inside a short cluster still writes
  assert.equal(classifyShell("less -No /tmp/x f").readOnly, false);
  assert.equal(classifyShell("less -N f").readOnly, true);
});

test("awk statements end at braces too, so a comparison is not a print redirection (G6)", () => {
  for (const command of ["awk 'NR>1 && $2>=10 {n++} END{print n}' d", "awk '$1 > 5 {print $2}' d", "awk '{print $1}' d"]) {
    assert.equal(classifyShell(command).readOnly, true, command);
  }
  for (const command of ["awk '{print $1 > \"out\"}' d", "awk '{ if ($1 > 5) print $2 > \"o\" }' d"]) {
    assert.equal(classifyShell(command).readOnly, false, command);
  }
});

test("the seven holes from the differential run, each named for what the program actually did (H1/H2/H3/H4)", () => {
  const holes: [string, RegExp, string][] = [
    // `sort --o=pwn` is `--output=pwn`: getopt_long accepts the abbreviation. It wrote pwn.
    ["sort --o=pwn in", /sort -o/, "sort wrote pwn through an abbreviated --output"],
    ["sort --outp=pwn in", /sort -o/, "sort wrote pwn through an abbreviated --output"],
    // `file -bC` is `-b -C`, and -C compiles the magic file. It wrote magic.mgc.
    ["file -bC -m in", /file -C/, "file compiled magic.mgc from a short-option cluster"],
    ["file --comp -m in", /file -C/, "file compiled magic.mgc through an abbreviated --compile"],
    // `(e)` re-expands the value, so the escaped substitution inside ran. It created pwn.
    ['echo "${(e):-\\$(touch pwn)}"', /expansion that is not modelled/, "zsh's (e) flag ran the escaped substitution"],
    // git config's mutating options. They changed .git/config.
    ["git config --unset-all user.name", /git config that writes/, "git config removed a key"],
    ["git config --remove-section user", /git config that writes/, "git config removed a section"],
  ];
  for (const [command, why, what] of holes) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, `${command}: ${what}`);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
  // No change was visible in that run, but the judgement was still wrong.
  const wrong: [string, RegExp][] = [
    ["git stash", /git stash changing the stack/],
    ["git stash push", /git stash changing the stack/],
    ["git stash drop", /git stash changing the stack/],
    ["less --log-f=pwn f", /less writing a log file/],
    ["sort --comp=./x in", /sort --compress-program/],
    ["git grep --open-f=touch a", /git grep running a program/],
    ['echo "${HOME[\\$(touch pwn)]}"', /expansion that is not modelled/],
  ];
  for (const [command, why] of wrong) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});

test("long options are matched by abbreviation and short options by their cluster (H1/H2)", () => {
  const abbreviations = ["sort --out=pwn in", "git show --outp=pwn", "less --log=pwn f", "tree --out=pwn", "rg --host ./x a", "diff --pag a b", "date --se 2020", "awk --file=in data"];
  for (const command of abbreviations) assert.equal(classifyShell(command).readOnly, false, command);
  const clusters = ["sort -ro pwn in", "tree -ao pwn", "file -cC -m in", "less -eO pwn f", "date -us 2020", "git grep -nO'touch pwn' a", "mount -av"];
  for (const command of clusters) assert.equal(classifyShell(command).readOnly, false, command);
  // and the same options, spelled safely, are still reads
  for (const command of ["sort -n in", "less -N f", "file -b in", "tree -L 1 .", "date -R", "git grep -n TODO a", "mount", "awk -F: '{print $1}' in", "sort --stable in", "diff --stat in f"]) {
    assert.equal(classifyShell(command).readOnly, true, command);
  }
});

test("only $NAME and ${NAME} are read; every other expansion is unmodelled (H3)", () => {
  for (const command of ["cat $HOME/.zshrc", 'ls "$HOME"', "echo ${PATH}", "grep -rn foo ${PWD}/src", "head -5 $FILE", "echo ${_x}"]) {
    assert.equal(classifyShell(command).readOnly, true, command);
  }
  const refused = ["echo ${x:-y}", "echo $?", "echo $@", "echo $1", "echo $#", "echo $$", "echo ${(e)x}", "echo ${HOME[1]}", "echo $[1+1]", "echo $((1+1))", "echo ${~HOME}", "echo ${(s:,:)HOME}"];
  for (const command of refused) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, /expansion that is not modelled/, command);
  }
});

test("git config and git stash are whitelists (H4)", () => {
  const reads = ["git config user.name", "git config --get user.name", "git config --get-all user.name", "git config --get-regexp 'user\\..*'", "git config -l", "git config --list --global", "git config --show-origin --get user.name", "git config get user.name", "git config list", "git stash list", "git stash show", "git stash show -p"];
  for (const command of reads) assert.equal(classifyShell(command).readOnly, true, command);
  const writes: [string, RegExp][] = [
    ["git config user.name pwn", /git config/],
    ["git config --global user.name pwn", /git config/],
    ["git config --unset user.name", /git config that writes/],
    ["git config --unset-all user.name", /git config that writes/],
    ["git config --remove-section user", /git config that writes/],
    ["git config --rename-section user pwn", /git config that writes/],
    ["git config --add user.x pwn", /git config that writes/],
    ["git config set user.name pwn", /git config/],
    ["git config unset user.name", /git config/],
    ["git config -f pwn a.b c", /git config that writes/],
    ["git config --file=pwn a.b c", /git config that writes/],
    ["git config --blob=HEAD:config a.b", /git config/],
    ["git config --show-scope --list --unknown", /git config/],
    ["git stash", /git stash/],
    ["git stash push", /git stash/],
    ["git stash pop", /git stash/],
    ["git stash drop", /git stash/],
  ];
  for (const [command, why] of writes) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});

test("a short sleep reads, a long one asks: the duration decides, not the name", () => {
  for (const command of ["sleep 1", "sleep 5", "sleep 0.5", "sleep 1 0"]) {
    assert.equal(classifyShell(command).readOnly, true, command);
  }
  const asks: [string, RegExp][] = [
    ["sleep 6", /sleep for 6 seconds/],
    ["sleep 3600", /sleep for 3600 seconds/],
    ["sleep 1m", /sleep for 60 seconds/],
    ["sleep 1 5", /sleep for 6 seconds/],
    ["sleep 1h", /sleep for 3600 seconds/],
    ["sleep -s 3", /a sleep duration this does not model/],
    ["sleep", /a sleep duration this does not model/],
  ];
  for (const [command, why] of asks) {
    const verdict = classifyShell(command);
    assert.equal(verdict.readOnly, false, command);
    if (!verdict.readOnly) assert.match(verdict.because, why, command);
  }
});

test("the sleep rule does not change how the rest of a chain is judged", () => {
  // `npm test` is not a reader (`npmReads` allows ls/view/outdated and friends), so the chain asks
  // for the same reason it did before sleep had a rule: the second command, not the pause.
  assert.deepEqual(classifyShell("sleep 1 && npm test"), classifyShell("npm test"));
  assert.equal(classifyShell("sleep 1 && ls").readOnly, true, "a short pause plus a read");
  assert.equal(classifyShell("sleep 300 && ls").readOnly, false, "a long pause is the reason");
  assert.equal(classifyShell("ls && sleep 2").readOnly, true);
});
