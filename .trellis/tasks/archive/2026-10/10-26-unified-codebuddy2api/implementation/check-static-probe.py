"""Read-only probe: are the real built notice assets reachable through native static hosting?

Run from anywhere with the product repo on PYTHONPATH:

    $env:PYTHONPATH='D:\\My2KProjects\\codebuddy2api'
    python -B implementation/check-static-probe.py

Uses the real ``web/dist`` produced by ``pnpm run build`` (not a synthetic tree),
so it reports what a browser actually gets in production.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway_management import install_pages

DIST = Path(r"D:\My2KProjects\codebuddy2api\web\dist")

PATHS = [
    "/dashboard/",
    "/dashboard/storage",
    "/dashboard/THIRD_PARTY_NOTICES.md",
    "/dashboard/THIRD_PARTY_NOTICES.txt",
    "/dashboard/THIRD_PARTY_LICENSES.txt",
    "/dashboard/LICENSE.upstream.txt",
    "/dashboard/licenses/DM-Sans.txt",
    "/dashboard/licenses/",
]


def main() -> int:
    if not (DIST / "index.html").is_file():
        print(f"missing real build: {DIST / 'index.html'}", file=sys.stderr)
        return 2
    app = FastAPI()
    install_pages(app, DIST)
    client = TestClient(app)
    print(f"dist = {DIST}")
    for path in PATHS:
        response = client.get(path, follow_redirects=False)
        body = response.text[:40].replace("\n", " ")
        print(f"{response.status_code}  {path:<42} {body}")
    print("\nshipped files in dist root:")
    for item in sorted(DIST.iterdir()):
        print(f"  {'dir ' if item.is_dir() else 'file'} {item.name}")
    (DIST / "licenses").is_dir() and print("  (licenses/ directory exists)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
