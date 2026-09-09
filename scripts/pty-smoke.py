#!/usr/bin/env python3
"""Exercise the built dashboard in real PTYs using disposable saved inventory.

No third-party terminal emulator or live machine configuration is required.
ANSI output is captured only inside the automatically removed temporary home.
"""
import codecs
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata

ROOT = Path(__file__).resolve().parent.parent
DEADLINE = 12


def terminal_attributes(fd):
    attrs = termios.tcgetattr(fd)
    return attrs[:6] + [[x.hex() if isinstance(x, bytes) else x for x in attrs[6]]]


class Screen:
    """Small VT parser for Ink's cursor movement, erasing, and text output."""
    def __init__(self, columns, rows):
        self.columns, self.rows = columns, rows
        self.lines = [[" "] * columns for _ in range(rows)]
        self.x = self.y = 0
        self.pending = ""
        self.alternate = False
        self.cursor = True
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, data):
        text = self.pending + self.decoder.decode(data)
        self.pending = ""
        i = 0
        while i < len(text):
            char = text[i]
            if char == "\x1b":
                if i + 1 == len(text):
                    self.pending = text[i:]
                    break
                if text[i + 1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", text[i:])
                    if not match:
                        self.pending = text[i:]
                        break
                    self.csi(match[1], match[3])
                    i += len(match[0])
                    continue
                if text[i + 1] == "]":
                    end = re.search(r"\x07|\x1b\\", text[i + 2:])
                    if not end:
                        self.pending = text[i:]
                        break
                    i += 2 + end.end()
                    continue
                i += 2
                continue
            if char == "\r":
                self.x = 0
            elif char == "\n":
                self.linefeed()
            elif char == "\b":
                self.x = max(0, self.x - 1)
            elif ord(char) >= 32:
                width = 0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in "WF" else 1)
                if self.x >= self.columns:
                    self.x = 0
                    self.linefeed()
                if width:
                    self.lines[self.y][self.x] = char
                    self.x += width
            i += 1

    def linefeed(self):
        self.y += 1
        if self.y >= self.rows:
            self.lines.pop(0)
            self.lines.append([" "] * self.columns)
            self.y = self.rows - 1

    def csi(self, params, command):
        numbers = [int(x or "0") for x in params.lstrip("?").split(";")]
        n = numbers[0] or 1
        if params.startswith("?"):
            for mode in numbers:
                if mode == 1049:
                    self.alternate = command == "h"
                if mode == 25:
                    self.cursor = command == "h"
            return
        if command == "A": self.y = max(0, self.y - n)
        elif command == "B": self.y = min(self.rows - 1, self.y + n)
        elif command == "C": self.x = min(self.columns - 1, self.x + n)
        elif command == "D": self.x = max(0, self.x - n)
        elif command == "G": self.x = min(self.columns - 1, n - 1)
        elif command in ("H", "f"):
            self.y = min(self.rows - 1, n - 1)
            self.x = min(self.columns - 1, (numbers[1] or 1) - 1 if len(numbers) > 1 else 0)
        elif command == "J":
            if numbers[0] in (2, 3):
                self.lines = [[" "] * self.columns for _ in range(self.rows)]
            elif numbers[0] == 0:
                self.lines[self.y][min(self.x, self.columns):] = [" "] * max(0, self.columns - self.x)
                for row in range(self.y + 1, self.rows): self.lines[row] = [" "] * self.columns
        elif command == "K":
            if numbers[0] == 2: self.lines[self.y] = [" "] * self.columns
            elif numbers[0] == 0:
                self.lines[self.y][min(self.x, self.columns):] = [" "] * max(0, self.columns - self.x)

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.lines)


class Terminal:
    def __init__(self, executable, home, width, height):
        self.master, self.slave = pty.openpty()
        self.before = terminal_attributes(self.slave)
        self.screen = Screen(width, height)
        self.output = bytearray()
        self.trace = home / f"{Path(executable).name}-{width}x{height}.ansi"
        self.resize(width, height, initial=True)
        env = dict(os.environ)
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), CODEX_HOME=str(home / ".codex"),
                   TERM="xterm-256color", COLUMNS=str(width), LINES=str(height), FORCE_COLOR="1",
                   PATH=str(home / "bin") + os.pathsep + env.get("PATH", ""))
        for key in ("CI", "NO_COLOR", "SKILLOOM_CONFIG", "SKILLOOM_MACHINE_ID"):
            env.pop(key, None)
        def session():
            os.setsid()
            fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)
        self.restored = home / "restored-terminal.json"
        self.restored.unlink(missing_ok=True)
        supervisor = """import json, subprocess, sys, termios
result = subprocess.run(sys.argv[2:])
a = termios.tcgetattr(0)
with open(sys.argv[1], 'w') as f:
    json.dump(a[:6] + [[x.hex() if isinstance(x, bytes) else x for x in a[6]]], f)
sys.exit(result.returncode)
"""
        self.process = subprocess.Popen([sys.executable, "-c", supervisor, str(self.restored), executable, str(ROOT / "dist/index.mjs")], cwd=home,
                                        stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                        env=env, preexec_fn=session)

    def resize(self, width, height, initial=False):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        if not initial:
            self.screen = Screen(width, height)
            os.killpg(self.process.pid, signal.SIGWINCH)

    def pump(self, timeout):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if ready:
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                return
            self.output.extend(chunk)
            self.screen.feed(chunk)

    def wait(self, description, predicate):
        end = time.monotonic() + DEADLINE
        while True:
            if predicate(self.screen.text()):
                # Wait for a quiet output turn so React's input effect follows its paint.
                observed = len(self.output)
                self.pump(0.04)
                if len(self.output) == observed and predicate(self.screen.text()):
                    return
            if self.process.poll() is not None:
                self.pump(0)
                raise AssertionError(f"Exited {self.process.returncode} while waiting for {description}")
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"Timed out waiting for {description}\n{self.screen.text()}")
            self.pump(min(remaining, 0.1))

    def send(self, keys, description, predicate):
        os.write(self.master, keys)
        self.wait(description, predicate)

    def finish(self, key):
        os.write(self.master, key)
        end = time.monotonic() + DEADLINE
        while self.process.poll() is None and time.monotonic() < end: self.pump(0.1)
        if self.process.poll() is None: raise AssertionError("Dashboard hung while exiting")
        self.pump(0.05)
        assert self.process.returncode == 0, f"Exit status {self.process.returncode}"
        output = bytes(self.output)
        assert b"\x1b[?1049h" in output, "Alternate screen was never entered"
        assert output.rfind(b"\x1b[?1049l") > output.rfind(b"\x1b[?1049h"), "Alternate screen not restored"
        assert output.rfind(b"\x1b[?25h") > output.rfind(b"\x1b[?25l"), "Cursor not restored"
        assert json.loads(self.restored.read_text()) == self.before, "Terminal input flags/raw mode not restored"

    def close(self):
        self.trace.write_bytes(self.output)
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        os.close(self.master)
        os.close(self.slave)
        self.process.wait(timeout=3)


def fixture(home):
    app = home / ".config/skilloom"
    app.mkdir(parents=True)
    (home / ".codex").mkdir()
    (home / "bin").mkdir()
    fake = home / "bin/npx"
    fake.write_text('#!/bin/sh\nprintf "Unexpected upstream command\\n" >> "$HOME/upstream-called"\nexit 91\n')
    fake.chmod(0o755)
    (app / "machine-id").write_text("11111111-1111-4111-8111-111111111111\n")
    (app / "config.yaml").write_text("version: 1\nstorage: {mode: local}\nprofiles: {personal: {skills: []}}\nmachines: {11111111-1111-4111-8111-111111111111: {profile: personal, name: PTY Mac}}\n")
    (app / "machine.json").write_text(json.dumps(dict(version=1, id="11111111-1111-4111-8111-111111111111", name="PTY Mac", workspaces=[])))
    def skill(name, **extra):
        value = dict(name=name, source="acme/skills", agents=["codex"], scope="global", installed=True,
                     desired=False, managed=False, ownership="personal", reasons=[],
                     metadata=dict(source="skill-declaration", invocation="unknown", variants=[]))
        value.update(extra)
        return value
    skills = [skill("alpha-review", usagePathIds=["a" * 64], managed=True, desired=True, metadata=dict(source="skill-declaration", invocation="both", variants=[dict(agent="codex", invocation="both", status="read")])), skill("bravo-writing"), skill("charlie-testing", source=None)]
    skills += [skill(f"skill-{i:02}") for i in range(30)]
    tracked = skill("delta-project", scope="project", ownership="repository", source="acme/project")
    project = dict(id="github.com/acme/project", name="project", remote="https://github.com/acme/project",
                   checkouts=[dict(path=str(home / "project"), skills=[tracked], operations=[])], skills=[tracked], operations=[])
    inventory = dict(version=1, observedAt="2026-01-01T00:00:00Z",
                     machine=dict(id="11111111-1111-4111-8111-111111111111", name="PTY Mac", profile="personal"),
                     discovery=dict(status="found", roots=[], projectsFound=1, checkoutsFound=1),
                     profiles=["personal"], machines=[dict(id="11111111-1111-4111-8111-111111111111", name="PTY Mac", profile="personal", local=True),
                         dict(id="pty-remote", name="PTY Studio", profile="personal", local=False, observedAt="2026-01-01T00:00:00Z", projects=0, globalSkills=1, changes=0)],
                     globalSkills=skills, projects=[project],
                     skillUsage=dict(version=2, history=[dict(id="d" * 64, name="alpha-review", pathId="a" * 64, harness="codex", evidence="read", at="2026-01-01T00:00:00Z")], usage=[dict(name="alpha-review", pathId="a" * 64, harness="codex", evidence="read", count=2, lastUsedAt="2026-01-01T00:00:00Z")],
                         coverage=dict(status="incomplete", filesDiscovered=1, filesScanned=1, bytesRead=100, limitsHit=["files"], observedAt="2026-01-01T00:00:00Z")),
                     remoteObservations=[dict(machine=dict(id="pty-remote", name="PTY Studio"), observedAt="2026-01-01T00:00:00Z", stale=True,
                         globalSkills=[skill("remote-only")], projects=[])],
                     operations=[dict(kind="add", skill=dict(name="pending-fixture", source="acme/skills", scope="global", agents=["codex"]), reasons=["machine profile personal"])])
    (app / "inventory.json").write_text(json.dumps(inventory))


def exercise(executable, home, width, height):
    preserved = {name: (home / ".config/skilloom" / name).read_bytes() for name in ("config.yaml", "inventory.json")}
    terminal = Terminal(executable, home, width, height)
    try:
        terminal.wait("initial populated library", lambda text: "alpha-review" in text and "bravo-writing" in text)
        assert terminal.screen.alternate, "Dashboard did not enter alternate screen"
        assert "Invocation" in terminal.screen.text() and "Automatic" in terminal.screen.text() and "Unknown" in terminal.screen.text(), "Invocation column missing or unknown mode not marked"
        assert "Evidence" not in terminal.screen.text(), "Evidence still clutters the library"
        if width >= 65:
            assert "Ownership" in terminal.screen.text() and "Machines" in terminal.screen.text(), "Library columns missing"
        terminal.wait("raw input enabled", lambda _: not (termios.tcgetattr(terminal.slave)[3] & termios.ICANON))
        terminal.send(b"\x1b[C", "right selects local machine", lambda text: "‹ PTY Mac ›" in text)
        terminal.send(b"\x1b[D", "left returns all machines", lambda text: "‹ All machines ›" in text)
        terminal.send(b"/", "search for cursor editing", lambda text: "Editing search" in text)
        terminal.send(b"alha", "search text before insertion", lambda text: "alha▏" in text)
        terminal.send(b"\x1b[D", "cursor moves left", lambda text: "alh▏a" in text)
        terminal.send(b"\x1b[D", "cursor moves into word", lambda text: "al▏ha" in text)
        terminal.send(b"p", "insert at cursor", lambda text: "alp▏ha" in text and "alpha-review" in text)
        terminal.send(b"\x1b", "finish edited search", lambda text: "Search: alpha" in text and "‹ All machines ›" in text)
        terminal.send(b"x", "reset edited search", lambda text: "bravo-writing" in text)
        # Search editing, results navigation, and full-page details have distinct focus.
        terminal.send(b"g", "global filter before search", lambda text: "· global ·" in text)
        terminal.send(b"/", "explicit search focus", lambda text: "Editing search" in text and "▏" in text)
        terminal.send(b"bravo", "filtered library", lambda text: "bravo-writing" in text and "alpha-review" not in text)
        terminal.send(b"\x1b", "search Escape focuses results without clearing", lambda text: "Results" in text and "Editing search" not in text and "▏" not in text and "bravo-writing" in text and "alpha-review" not in text and "· global ·" in text)
        terminal.send(b"\x1b", "second results Escape preserves query and scope", lambda text: "Results" in text and "bravo-writing" in text and "alpha-review" not in text and "· global ·" in text)
        if width >= 100:
            assert "Preview" in terminal.screen.text(), "Wide results lack their read-only preview cue"
            assert "Enter focus inspector" not in terminal.screen.text(), "Preview still exposes an independent focus mode"
        terminal.send(b"\r", "full-page details at every width", lambda text: "Skill details" in text and "bravo-writing" in text and "Esc results" in text)
        assert "Preview" not in terminal.screen.text(), "Details left the preview pane visible"
        assert "Results ·" not in terminal.screen.text(), "Details left the library table visible"
        terminal.send(b"\x1b", "return before i shortcut", lambda text: "Results" in text)
        terminal.send(b"i", "i opens full details from results", lambda text: "Skill details" in text)
        terminal.send(b"/", "search from details returns to results", lambda text: "Editing search" in text and "Results" in text and "Skill details" not in text and "bravo-writing" in text)
        terminal.send(b"\r", "search Enter focuses preserved results", lambda text: "Editing search" not in text and "▏" not in text and "Results" in text and "bravo-writing" in text and "· global ·" in text)
        terminal.send(b"\r", "reopen explicit details", lambda text: "Skill details" in text and "bravo-writing" in text)
        terminal.send(b"\x1b", "details Escape returns same results", lambda text: "Skill details" not in text and "Results" in text and "bravo-writing" in text and "alpha-review" not in text and "· global ·" in text)
        terminal.send(b"\x1b", "second Escape keeps filtered results", lambda text: "Results" in text and "bravo-writing" in text and "alpha-review" not in text and "· global ·" in text)
        terminal.send(b"x", "clear search explicitly", lambda text: "alpha-review" in text)
        terminal.send(b"/", "multi-result search", lambda text: "Editing search" in text)
        terminal.send(b"skill-", "multiple filtered results", lambda text: "skill-00" in text and "skill-01" in text)
        terminal.send(b"\x1b[B", "Down ends search and selects next result", lambda text: "Editing search" not in text and "▏" not in text and re.search(r"›\s+skill-01", text) is not None)
        terminal.send(b"\r", "selected result opens full details", lambda text: "Skill details" in text and "skill-01" in text)
        terminal.send(b"\x1b", "return preserves selected result", lambda text: "Results" in text and "Skill details" not in text and re.search(r"›\s+skill-01", text) is not None)
        terminal.send(b"x", "clear multi-result query", lambda text: "alpha-review" in text)
        terminal.send(b"g", "global scope filter", lambda text: "· global ·" in text and "delta-project" not in text)
        terminal.send(b"g", "project scope filter", lambda text: "delta-project" in text and "alpha-review" not in text)
        terminal.send(b"x", "clear scope filter", lambda text: "alpha-review" in text)
        terminal.send(b"o", "managed ownership filter", lambda text: "alpha-review" in text and "bravo-writing" not in text)
        terminal.send(b"x", "clear ownership filter", lambda text: "bravo-writing" in text)
        assert "s Sync PTY Mac" in terminal.screen.text(), "Library sync action is not visible"
        terminal.send(b"\x1b[D", "browse remote snapshot", lambda text: "remote-only" in text and "alpha-review" not in text)
        assert "s Sync PTY Mac" in terminal.screen.text(), "Sync target followed the remote browsing filter"
        terminal.send(b"s", "sync directly from Library", lambda text: "Review local sync" in text and "No installation changes" in text)
        terminal.send(b"\x1b", "cancel sync back to remote Library", lambda text: "Results" in text and "remote-only" in text and "s Sync PTY Mac" in text)
        terminal.send(b"x", "reset machine filter explicitly", lambda text: "alpha-review" in text)
        terminal.send(b"\t", "Changes selected review action", lambda text: "Changes on PTY Mac" in text and re.search(r"›\s+Review sync", text) is not None)
        assert "Search:" not in terminal.screen.text(), "Changes retained the Library search header"
        for key in (b"a", b"d", b"v"):
            terminal.send(key, "Library action ignored in Changes", lambda text: "Changes on PTY Mac" in text and "Add a requirement" not in text and "Verify source for" not in text)
        # Fresh review deliberately scans only this disposable home; it never applies.
        terminal.send(b"\r", "Changes Enter opens fresh read-only preview", lambda text: "Review local sync" in text and "No installation changes" in text)
        assert "pending-fixture" not in terminal.screen.text(), "Review reused the stale saved operation"
        terminal.send(b"\x1b", "cancel fresh preview", lambda text: "Changes on PTY Mac" in text and re.search(r"›\s+Review sync", text) is not None)
        terminal.send(b"\x1b[B", "select saved operation", lambda text: re.search(r"›\s+Add pending-fixture", text) is not None)
        terminal.send(b"\r", "inspect operation without applying", lambda text: "Change details" in text and "pending-fixture" in text)
        terminal.send(b"\x1b", "operation details return to selected change", lambda text: "Changes on PTY Mac" in text and re.search(r"›\s+Add pending-fixture", text) is not None)
        terminal.send(b"\t", "Settings selected actions", lambda text: "Settings for PTY Mac" in text and re.search(r"›\s+Workspace setup", text) is not None)
        assert "Search:" not in terminal.screen.text(), "Settings retained the Library search header"
        for key in (b"a", b"d", b"v"):
            terminal.send(key, "Library action ignored in Settings", lambda text: "Settings for PTY Mac" in text and "Add a requirement" not in text and "Verify source for" not in text)
        settings = [("Workspace setup", "Set up this machine"), ("Create a profile", "Create a global profile"),
                    ("Choose global profile", "Choose this machine's profile"), ("Connect shared configuration", "Connect shared configuration")]
        for i, (row, title) in enumerate(settings):
            if i: terminal.send(b"\x1b[B", "select Settings action", lambda text, row=row: re.search(r"›\s+" + re.escape(row), text) is not None)
            terminal.send(b"\r", "open selected Settings form", lambda text, title=title: title in text and "Settings for PTY Mac" not in text)
            terminal.send(b"\x1b", "cancel form and preserve Settings selection", lambda text, row=row: "Settings for PTY Mac" in text and re.search(r"›\s+" + re.escape(row), text) is not None)
        terminal.send(b"\x1b[B", "select legacy review action", lambda text: re.search(r"›\s+Review legacy adoption", text) is not None)
        terminal.send(b"\r", "open read-only migration review", lambda text: "Review migration" in text)
        terminal.send(b"\x1b", "cancel migration review", lambda text: "Settings for PTY Mac" in text and re.search(r"›\s+Review legacy adoption", text) is not None)
        terminal.send(b"\x1b[Z", "reverse Tab to Changes", lambda text: "Changes on PTY Mac" in text)
        terminal.send(b"\x1b[Z", "reverse Tab to Library", lambda text: "Results" in text and "alpha-review" in text)
        terminal.send(b"?", "keyboard guide", lambda text: "Keyboard guide" in text)
        terminal.send(b"\x1b", "close guide", lambda text: "alpha-review" in text)
        target_width, target_height = ((80, 28) if width == 120 else (120, 36))
        terminal.resize(target_width, target_height)
        terminal.wait("responsive library after resize", lambda text: "alpha-review" in text and "bravo-writing" in text)
        terminal.finish(b"q")
    finally:
        terminal.close()
    interrupt = Terminal(executable, home, width, height)
    try:
        interrupt.wait("library before Ctrl-C", lambda text: "alpha-review" in text)
        interrupt.finish(b"\x03")
    finally:
        interrupt.close()
    assert not (home / "upstream-called").exists(), "Read-only preview unexpectedly invoked unpinned npx"
    for name, content in preserved.items():
        assert (home / ".config/skilloom" / name).read_bytes() == content, f"Navigation/preview mutated {name}"
    assert not (home / ".config/skilloom/state.json").exists(), "Navigation/preview applied installation changes"
    print(f"PTY {Path(executable).name} {width}x{height}: library, search focus/Esc/arrows, full-page details/back, explicit metadata, selected secondary views/forms/preview cancellation, reverse Tab, resize, q/Ctrl-C restoration passed")


def main():
    executables = [shutil.which("node")]
    if not executables[0]: raise RuntimeError("Node is required for PTY smoke tests")
    bun = shutil.which("bun")
    if bun: executables.append(bun)
    with tempfile.TemporaryDirectory(prefix="skilloom-pty-") as directory:
        home = Path(directory)
        fixture(home)
        for executable in executables:
            for width, height in ((120, 36), (80, 28), (40, 24)):
                exercise(executable, home, width, height)


if __name__ == "__main__":
    main()
