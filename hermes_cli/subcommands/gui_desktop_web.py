"""``hermes gui`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

import argparse
from typing import Callable


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "port must be an integer between 0 and 65535"
        ) from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


def _host(value: str) -> str:
    if not value or value != value.strip() or any(char.isspace() for char in value):
        raise argparse.ArgumentTypeError(
            "host must be a non-empty hostname or address"
        )
    return value


def build_desktop_web_parser(subparsers, *, cmd_desktop_web: Callable) -> None:
    """Attach the ``desktop-web`` subcommand to ``subparsers``."""
    # =========================================================================
    gui_parser = subparsers.add_parser(
        "desktop-web",
        help="Build and launch the Electron desktop web app",
        description=(
            "Build the Electron desktop-web application and launch it under "
            "Xvfb on Linux. Host and port are passed to the web runtime; the "
            "default address is http://127.0.0.1:13043."
        ),
    )
    gui_parser.add_argument(
        "--host",
        type=_host,
        default="127.0.0.1",
        help="Web runtime bind host (default: 127.0.0.1)",
    )
    gui_parser.add_argument(
        "--port",
        type=_port,
        default=13043,
        help="Web runtime bind port (default: 13043; 0 selects an OS port)",
    )
    gui_parser.add_argument(
        "--source",
        action="store_true",
        help="Launch via `electron .` against apps/desktop/dist instead of the packaged app",
    )
    gui_parser.add_argument(
        "--build-only",
        action="store_true",
        help="Build the desktop-web app but do not launch it (used by the installer's --update flow)",
    )
    gui_parser.add_argument(
        "--fake-boot",
        action="store_true",
        help="Enable deterministic desktop boot delays for validating startup UI",
    )
    gui_parser.add_argument(
        "--ignore-existing",
        action="store_true",
        help="Force Desktop to ignore any hermes CLI already on PATH during backend resolution",
    )
    gui_parser.add_argument(
        "--hermes-root",
        help="Override the Hermes source root used by Desktop (sets HERMES_DESKTOP_HERMES_ROOT)",
    )
    gui_parser.add_argument(
        "--cwd",
        help="Initial project directory for Desktop chat sessions (sets HERMES_DESKTOP_CWD)",
    )
    gui_parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip npm install/package and launch the existing unpacked app from apps/desktop/release",
    )
    gui_parser.add_argument(
        "--force-build",
        action="store_true",
        help="Force a full rebuild even if the content stamp matches",
    )
    gui_parser.add_argument(
        "--setup-tcc-identity",
        action="store_true",
        help=(
            "macOS only: create/import a self-signed code-signing certificate "
            "in the login keychain and point desktop.macos_signing_identity at "
            "it, then re-sign the packaged app. Makes macOS TCC grants (Full "
            "Disk Access, Accessibility, Files and Folders, microphone) survive "
            "rebuilds with a certificate-anchored identity. Idempotent — safe "
            "to re-run after updates."
        ),
    )
    gui_parser.add_argument(
        "--identity",
        default="Hermes Local Signing",
        help="Certificate name to create/use for --setup-tcc-identity (default: Hermes Local Signing)",
    )
    gui_parser.set_defaults(func=cmd_desktop_web)
