import argparse
import json
import subprocess

import pytest

from hermes_cli import main as cli_main
from hermes_cli.subcommands.gui_desktop_web import build_desktop_web_parser


def test_desktop_web_parser_uses_dedicated_handler_and_defaults():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    build_desktop_web_parser(subparsers, cmd_desktop_web=lambda args: args)

    args = parser.parse_args(["desktop-web"])

    assert args.host == "127.0.0.1"
    assert args.port == 13043
    assert args.func(args) is args


def test_web_npm_command_temporarily_uses_web_manifest(tmp_path, monkeypatch):
    desktop_dir = tmp_path / "apps" / "desktop"
    desktop_dir.mkdir(parents=True)
    normal_manifest = desktop_dir / "package.json"
    web_manifest = desktop_dir / "package-web.json"
    normal_manifest.write_text(json.dumps({"main": "dist/electron-main.mjs"}))
    web_manifest.write_text(json.dumps({"main": "dist/electron-main-web.mjs"}))
    seen = []

    def fake_run(command, *, cwd, env, check):
        seen.append((command, normal_manifest.read_text()))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(cli_main.subprocess, "run", fake_run)

    result = cli_main._run_desktop_npm_command(
        ["npm", "run", "pack"],
        desktop_dir=desktop_dir,
        env={"HERMES_DESKTOP_WEB": "1"},
    )

    assert result.returncode == 0
    assert seen == [(["npm", "run", "pack"], web_manifest.read_text())]
    assert normal_manifest.read_text() == json.dumps({"main": "dist/electron-main.mjs"})


def test_web_launch_command_uses_xvfb_on_linux(monkeypatch):
    monkeypatch.setattr(cli_main.sys, "platform", "linux")
    monkeypatch.setattr(cli_main.shutil, "which", lambda name: "/usr/bin/xvfb-run")

    assert cli_main._desktop_launch_command(
        ["Hermes", "--flag"], {"HERMES_DESKTOP_WEB": "1"}
    ) == [
        "/usr/bin/xvfb-run",
        "-a",
        "-s",
        "-screen 0 1920x1080x24",
        "Hermes",
        "--flag",
    ]


def test_cmd_desktop_web_launch_passes_host_port_and_xvfb(tmp_path, monkeypatch):
    desktop_dir = tmp_path / "apps" / "desktop"
    desktop_dir.mkdir(parents=True)
    (desktop_dir / "package.json").write_text("{}")
    (desktop_dir / "package-web.json").write_text("{}")
    executable = desktop_dir / "release" / "linux-unpacked" / "Hermes"
    executable.parent.mkdir(parents=True)
    executable.write_text("")
    calls = []

    def fake_run(command, *, cwd, env, check):
        calls.append((command, cwd, env, check))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(cli_main, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(cli_main, "_desktop_packaged_executable", lambda _: executable)
    monkeypatch.setattr(cli_main, "_desktop_linux_sandbox_fixup", lambda _: True)
    monkeypatch.setattr(cli_main, "_detect_linux_password_store", lambda: None)
    monkeypatch.setattr(cli_main, "_desktop_launch_options", lambda: ([], "auto", "auto", "auto"))
    monkeypatch.setattr(cli_main, "_register_linux_desktop_entry", lambda: None)
    monkeypatch.setattr(cli_main.shutil, "which", lambda name: "/usr/bin/xvfb-run")
    monkeypatch.setattr(cli_main.subprocess, "run", fake_run)

    args = argparse.Namespace(
        host="0.0.0.0",
        port=14000,
        source=False,
        skip_build=True,
        force_build=False,
        build_only=False,
        fake_boot=False,
        ignore_existing=False,
        hermes_root=None,
        cwd=None,
        setup_tcc_identity=False,
        identity=None,
    )

    with pytest.raises(SystemExit) as exc:
        cli_main.cmd_desktop_web(args)

    assert exc.value.code == 0
    assert len(calls) == 1
    command, cwd, env, check = calls[0]
    assert command[:4] == [
        "/usr/bin/xvfb-run",
        "-a",
        "-s",
        "-screen 0 1920x1080x24",
    ]
    assert command[4] == str(executable)
    assert cwd == desktop_dir
    assert env["HERMES_DESKTOP_WEB"] == "1"
    assert env["HERMES_DESKTOP_WEB_HOST"] == "0.0.0.0"
    assert env["HERMES_DESKTOP_WEB_PORT"] == "14000"
    assert check is False
