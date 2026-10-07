"""Tests for scripts/herdr-sort-spaces, run against a fake herdr server on a real Unix socket."""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "herdr-sort-spaces"


def ws(wid, label, **extra):
    return {"workspace_id": wid, "label": label, **extra}


class FakeHerdr:
    """Answers JSON lines on a Unix socket and records every request in order."""

    def __init__(self, path, spaces):
        self.spaces = list(spaces)
        self.calls = []
        self.error = None  # method name that should reply with an error
        self.split = False  # send replies in two chunks
        self.no_newline = False  # send the reply, then close without "\n"
        self.ignore_moves = False
        self.srv = socket.socket(socket.AF_UNIX)
        self.srv.bind(path)
        self.srv.listen(8)
        self.srv.settimeout(0.1)
        self.stop = False
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def loop(self):
        while not self.stop:
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                self.handle(conn)

    def handle(self, conn):
        buf = b""
        while not buf.endswith(b"\n"):
            buf += conn.recv(4096)
        req = json.loads(buf)
        self.calls.append((req["method"], req["params"]))
        if req["method"] == self.error:
            out = {"id": req["id"], "error": {"code": 7, "message": "boom"}}
        elif req["method"] == "workspace.list":
            out = {"id": req["id"], "result": {"workspaces": list(self.spaces)}}
        else:
            ids = req["params"]["workspace_ids"]
            if not self.ignore_moves:
                by_id = {w["workspace_id"]: w for w in self.spaces}
                moved = [by_id[i] for i in ids]
                rest = [w for w in self.spaces if w["workspace_id"] not in ids]
                self.spaces = moved + rest
            out = {"id": req["id"], "result": {}}
        data = json.dumps(out).encode()
        if self.no_newline:
            conn.sendall(data)
        elif self.split:
            conn.sendall(data[:5])
            threading.Event().wait(0.05)
            conn.sendall(data[5:] + b"\n")
        else:
            conn.sendall(data + b"\n")

    def close(self):
        self.stop = True
        self.thread.join()
        self.srv.close()


class Env:
    def __init__(self, tmp, spaces):
        self.home = Path(tmp) / "home"
        self.home.mkdir()
        self.sock = os.path.join(tmp, "h.sock")
        self.server = FakeHerdr(self.sock, spaces)
        self.save = self.home / ".local/share/herdr-sort-spaces/last-order.json"

    def run(self, monkeypatch, *args, sock=None, name="__main__"):
        """Load the script fresh with the given argv. Loaded as __main__, it runs as it does from the shell."""
        monkeypatch.setenv("HOME", str(self.home))
        monkeypatch.setenv("HERDR_SOCKET_PATH", sock or self.sock)
        monkeypatch.setattr(sys, "argv", ["herdr-sort-spaces", *args])
        loader = importlib.machinery.SourceFileLoader(name, str(SCRIPT))
        spec = importlib.util.spec_from_loader(name, loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        return mod

    def moves(self):
        return [p for m, p in self.server.calls if m == "workspace.move_block"]


@pytest.fixture
def make_env():
    # AF_UNIX paths are short on macOS, so build the directory under /tmp.
    made = []

    def make(spaces):
        tmp = tempfile.mkdtemp(prefix="hs", dir="/tmp")
        env = Env(tmp, spaces)
        made.append((tmp, env))
        return env

    yield make
    for tmp, env in made:
        env.server.close()
        shutil.rmtree(tmp, ignore_errors=True)


MIXED = [ws("w3", "zeta"), ws("w1", "~"), ws("w2", "Alpha"), ws("w5", "beta"), ws("w4", None)]
SORTED_IDS = ["w4", "w1", "w2", "w5", "w3"]  # empty label, then "~", then case-insensitive names


def test_default_mode_prints_both_orders_and_changes_nothing(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.run(monkeypatch)
    out = capsys.readouterr().out
    assert out.index("Current order:") < out.index("Sorted order:")
    current, rest = out.split("Sorted order:")
    assert [l.split()[1] for l in current.splitlines()[1:]] == ["w3", "w1", "w2", "w5", "w4"]
    assert [l.split()[1] for l in rest.splitlines()[1:6]] == SORTED_IDS
    assert "   1  w3     zeta" in current
    assert "Nothing changed. Run with --apply to sort; --restore undoes it." in out
    assert env.server.calls == [("workspace.list", {})]
    assert not env.save.exists()


def test_unknown_mode_behaves_like_show(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.run(monkeypatch, "--bogus")
    assert "Nothing changed" in capsys.readouterr().out
    assert env.moves() == []


def test_apply_saves_order_moves_in_sorted_order_and_verifies(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.run(monkeypatch, "--apply")
    assert capsys.readouterr().out.strip() == "Sorted."
    assert [m for m, _ in env.server.calls] == ["workspace.list", "workspace.move_block", "workspace.list"]
    assert env.moves() == [{"workspace_ids": SORTED_IDS, "before_workspace_id": None}]
    saved = json.loads(env.save.read_text())
    assert saved["ids"] == ["w3", "w1", "w2", "w5", "w4"]
    assert len(saved["saved_at"]) == 19


def test_apply_warns_when_live_order_differs(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.server.ignore_moves = True
    env.run(monkeypatch, "--apply")
    assert "live order differs from the sorted order" in capsys.readouterr().out
    assert env.save.exists()


def test_apply_refuses_linked_worktrees_without_touching_anything(make_env, monkeypatch):
    env = make_env([ws("a", "one"), ws("b", "two", worktree={"path": "/x"})])
    with pytest.raises(SystemExit) as e:
        env.run(monkeypatch, "--apply")
    assert "linked worktrees" in str(e.value)
    assert env.moves() == []
    assert not env.save.exists()


def test_restore_moves_saved_ids_that_are_still_open(make_env, monkeypatch, capsys):
    env = make_env([ws("a", "x"), ws("b", "y"), ws("c", "z")])
    env.save.parent.mkdir(parents=True)
    env.save.write_text(json.dumps({"saved_at": "2026-10-01 09:00:00", "ids": ["c", "gone", "a"]}))
    env.run(monkeypatch, "--restore")
    assert capsys.readouterr().out.strip() == "Restored 2 spaces to the order saved 2026-10-01 09:00:00."
    assert env.moves() == [{"workspace_ids": ["c", "a"], "before_workspace_id": None}]


def test_restore_with_nothing_open_exits_without_moving(make_env, monkeypatch):
    env = make_env([ws("a", "x")])
    env.save.parent.mkdir(parents=True)
    env.save.write_text(json.dumps({"saved_at": "t", "ids": ["gone"]}))
    with pytest.raises(SystemExit) as e:
        env.run(monkeypatch, "--restore")
    assert str(e.value) == "Nothing in the saved order is still open."
    assert env.moves() == []


def test_restore_without_a_saved_file_raises(make_env, monkeypatch):
    env = make_env([ws("a", "x")])
    with pytest.raises(FileNotFoundError):
        env.run(monkeypatch, "--restore")


def test_error_reply_exits_with_method_and_error(make_env, monkeypatch):
    env = make_env(MIXED)
    env.server.error = "workspace.list"
    with pytest.raises(SystemExit) as e:
        env.run(monkeypatch)
    assert str(e.value) == "workspace.list failed: {'code': 7, 'message': 'boom'}"


def test_move_error_exits_after_saving_the_order(make_env, monkeypatch):
    env = make_env(MIXED)
    env.server.error = "workspace.move_block"
    with pytest.raises(SystemExit) as e:
        env.run(monkeypatch, "--apply")
    assert str(e.value).startswith("workspace.move_block failed:")
    assert env.save.exists()


def test_reply_arriving_in_two_chunks_is_reassembled(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.server.split = True
    env.run(monkeypatch)
    assert "Sorted order:" in capsys.readouterr().out


def test_reply_closed_without_newline_is_still_parsed(make_env, monkeypatch, capsys):
    env = make_env(MIXED)
    env.server.no_newline = True
    env.run(monkeypatch)
    assert "Sorted order:" in capsys.readouterr().out


def test_call_sends_one_json_line_with_id_and_default_params(make_env, monkeypatch):
    env = make_env(MIXED)
    mod = env.run(monkeypatch)
    env.server.calls.clear()
    assert mod.call("workspace.list")["workspaces"][0]["workspace_id"] == "w3"
    assert env.server.calls == [("workspace.list", {})]


def test_importing_the_script_under_another_name_runs_nothing(make_env, monkeypatch):
    env = make_env([])
    mod = env.run(monkeypatch, "--apply", name="herdr_sort_spaces")
    assert callable(mod.main)
    assert env.server.calls == []
