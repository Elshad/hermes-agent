"""``hermes gui-web`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_gui_web_parser(subparsers, *, cmd_gui_web: Callable) -> None:
    """Attach the ``gui-web`` subcommand to ``subparsers``."""
    # =========================================================================
    gui_web_parser = subparsers.add_parser(
        "desktop-web",
        aliases=["gui-web"],
        help="Build and launch the desktop web app",
        description=(
            "Launch the Hermes Desktop Web app. By default this installs "
            "workspace Node dependencies, builds web app."
        ),
    )
    gui_web_parser.add_argument(
        "--source",
        action="store_true",
        help="Launch via `electron .` against apps/desktop/dist instead of the packaged app",
    )
    gui_web_parser.add_argument(
        "--build-only",
        action="store_true",
        help="Build the desktop app but do not launch it (used by the installer's --update flow)",
    )
    gui_web_parser.add_argument(
        "--fake-boot",
        action="store_true",
        help="Enable deterministic desktop boot delays for validating startup UI",
    )
    gui_web_parser.add_argument(
        "--ignore-existing",
        action="store_true",
        help="Force Desktop to ignore any hermes CLI already on PATH during backend resolution",
    )
    gui_web_parser.add_argument(
        "--hermes-root",
        help="Override the Hermes source root used by Desktop (sets HERMES_DESKTOP_HERMES_ROOT)",
    )
    gui_web_parser.add_argument(
        "--cwd",
        help="Initial project directory for Desktop chat sessions (sets HERMES_DESKTOP_CWD)",
    )
    gui_web_parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip npm install/package and launch the existing unpacked app from apps/desktop/release",
    )
    gui_web_parser.add_argument(
        "--force-build",
        action="store_true",
        help="Force a full rebuild even if the content stamp matches",
    )
    gui_web_parser.add_argument(
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
    gui_web_parser.add_argument(
        "--identity",
        default="Hermes Local Signing",
        help="Certificate name to create/use for --setup-tcc-identity (default: Hermes Local Signing)",
    )
    gui_web_parser.set_defaults(func=cmd_gui_web)
