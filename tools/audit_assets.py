#!/usr/bin/env python3
"""Audit the bundled reader for anything that would reach the network.

The app ships without INTERNET permission, so an external request does not
error — it fails silently on device, which is far worse. This catches it in CI
instead.

The old check was `grep -rP 'https?://'`, which is too blunt: every vendored
library carries its licence URL in a comment, and JSZip alone would fail the
build. What matters is not whether a URL appears in the bytes, but whether
anything actually loads from it. So:

  HTML  src= / href= / action= pointing off-origin
  CSS   url(...) and @import pointing off-origin
  JS    fetch / XMLHttpRequest / import() / new Worker / EventSource
        given an external URL, and <script src> written into a string

Run standalone:  python3 tools/audit_assets.py [assets-dir]
"""

import re
import sys
from pathlib import Path

ALLOWED_HOSTS = {"appassets.androidplatform.net"}

EXTERNAL = r"(?:https?:)?//(?!" + "|".join(re.escape(h) for h in ALLOWED_HOSTS) + r")"

HTML_PATTERNS = [
    (re.compile(r"""\b(?:src|href|action|poster|data)\s*=\s*["']\s*""" + EXTERNAL, re.I),
     "loads an off-origin resource"),
]

CSS_PATTERNS = [
    (re.compile(r"""url\(\s*["']?\s*""" + EXTERNAL, re.I), "loads an off-origin resource"),
    (re.compile(r"""@import\s+["']?\s*""" + EXTERNAL, re.I), "imports an off-origin stylesheet"),
]

JS_PATTERNS = [
    (re.compile(r"""\bfetch\s*\(\s*["'`]\s*""" + EXTERNAL, re.I), "fetch() to an external host"),
    (re.compile(r"""\.open\s*\(\s*["'][A-Z]+["']\s*,\s*["'`]\s*""" + EXTERNAL, re.I), "XHR to an external host"),
    (re.compile(r"""\bimport\s*\(\s*["'`]\s*""" + EXTERNAL, re.I), "dynamic import from an external host"),
    (re.compile(r"""new\s+(?:Worker|EventSource|WebSocket)\s*\(\s*["'`]\s*""" + EXTERNAL, re.I),
     "worker or socket pointed at an external host"),
    (re.compile(r"""["'`]\s*<script[^>]+src\s*=\s*\\?["']?\s*""" + EXTERNAL, re.I),
     "injects an external <script>"),
    (re.compile(r"""importScripts\s*\(\s*["'`]\s*""" + EXTERNAL, re.I), "importScripts from an external host"),
]

BY_SUFFIX = {
    ".html": HTML_PATTERNS,
    ".htm": HTML_PATTERNS,
    ".css": CSS_PATTERNS,
    ".js": JS_PATTERNS,
    ".mjs": JS_PATTERNS,
}


def audit(root: Path):
    findings = []
    for path in sorted(root.rglob("*")):
        patterns = BY_SUFFIX.get(path.suffix.lower())
        if not path.is_file() or not patterns:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern, why in patterns:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                snippet = text[match.start():match.start() + 90].split("\n")[0]
                findings.append((path, line, why, snippet.strip()))
    return findings


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "app/src/main/assets/www")
    if not root.is_dir():
        print(f"No such directory: {root}", file=sys.stderr)
        return 2

    findings = audit(root)
    if not findings:
        counted = sum(1 for p in root.rglob("*") if p.suffix.lower() in BY_SUFFIX)
        print(f"Assets are self-contained ({counted} files checked).")
        return 0

    for path, line, why, snippet in findings:
        rel = path.relative_to(root.parent.parent.parent.parent.parent)
        print(f"::error file={rel},line={line}::{why}: {snippet}")
    print(f"\n{len(findings)} external reference(s). The app has no INTERNET "
          f"permission, so these fail silently on device. Vendor them into "
          f"assets/www and rewrite the reference.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
