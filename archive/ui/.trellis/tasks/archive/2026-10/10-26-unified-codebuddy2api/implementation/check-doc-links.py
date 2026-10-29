"""Check every relative Markdown link in the repository docs resolves.

Read-only. Validates both the target file and, when a `#fragment` is present, that
a heading in the target file slugs to that fragment (GitHub anchor rules).

    python -B implementation/check-doc-links.py D:/My2KProjects/codebuddy2api
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
SKIP_SCHEMES = ("http://", "https://", "mailto:")


def slug(heading: str) -> str:
    """Approximate GitHub's heading anchor slug."""
    text = heading.strip().lower()
    text = re.sub(r"[`*\[\]()（）:：,，\"'/\\.!?、·]", "", text)
    text = text.replace(" ", "-")
    return text


def anchors(path: Path) -> set[str]:
    found = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            found.add(slug(line.lstrip("#").strip()))
    return found


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else ".").resolve()
    targets = sorted({*root.glob("*.md"), *root.glob("docs/**/*.md")})
    broken: list[str] = []
    checked = 0
    for source in targets:
        for match in LINK.finditer(source.read_text(encoding="utf-8")):
            url = match.group(1)
            if url.startswith(SKIP_SCHEMES) or url.startswith("#"):
                continue
            checked += 1
            path_part, _, fragment = url.partition("#")
            target = (source.parent / path_part).resolve()
            if not target.exists():
                broken.append(f"{source.relative_to(root)} -> {url} (missing file)")
                continue
            if fragment and target.suffix == ".md" and fragment not in anchors(target):
                broken.append(f"{source.relative_to(root)} -> {url} (missing anchor)")
    print(f"files scanned: {len(targets)}")
    print(f"relative links checked: {checked}")
    print(f"broken: {len(broken)}")
    for item in broken:
        print(f"  - {item}")
    return 1 if broken else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))