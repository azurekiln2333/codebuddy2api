"""Execute every backend regression script and fail on any non-zero exit.

The repository keeps plain ``unittest`` scripts in ``tests/`` and runs them
directly; there is no separate test framework entry point. Both release
platforms call this runner instead of copying the discovery logic, and the
runner refuses to pass a file that reports ``Ran 0 tests`` so an empty or
commented-out module cannot masquerade as a green gate.

CLI::

    python scripts/run_backend_tests.py            # run everything
    python scripts/run_backend_tests.py --list     # show discovery order
    python scripts/run_backend_tests.py tests/test_version.py
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "tests"
_RAN_TESTS = re.compile(r"^Ran (\d+) tests? in ", re.MULTILINE)


def discover(root: Path | str = ROOT) -> list[Path]:
    """Return the ordered list of ``tests/test_*.py`` regression scripts."""
    return sorted(Path(root).resolve().joinpath("tests").glob("test_*.py"))


def _ran_count(output: str) -> int | None:
    """Return the unittest case count a script reported, if it reported one."""
    match = _RAN_TESTS.search(output)
    return int(match.group(1)) if match else None


def run(paths: list[Path], root: Path | str = ROOT, *, fail_fast: bool = False) -> list[Path]:
    """Run each script in a fresh interpreter and return the failures."""
    root = Path(root).resolve()
    failures: list[Path] = []
    for path in paths:
        print(f"[tests] {path.name}", flush=True)
        result = subprocess.run(
            [sys.executable, "-B", str(path)],
            cwd=root,
            capture_output=True,
            text=True,
        )
        output = f"{result.stdout}{result.stderr}"
        reported = _ran_count(output)
        if result.returncode != 0:
            failures.append(path)
            print(output, file=sys.stderr)
            print(f"[tests] FAILED {path.name} (exit {result.returncode})", file=sys.stderr)
            if fail_fast:
                break
            continue
        if reported == 0:
            failures.append(path)
            print(output, file=sys.stderr)
            print(f"[tests] FAILED {path.name}: reported 'Ran 0 tests'", file=sys.stderr)
            if fail_fast:
                break
            continue
        if reported is None:
            # Script-style regression tests have no unittest summary; the exit
            # code is the only signal, but print the tail for the record.
            print(f"[tests] OK {path.name} (exit 0, no unittest summary)", flush=True)
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="explicit test files; defaults to discovery")
    parser.add_argument("--list", action="store_true", help="print the discovered order and exit")
    parser.add_argument("--fail-fast", action="store_true")
    args = parser.parse_args(argv)

    if args.paths:
        paths = [Path(item).resolve() for item in args.paths]
    else:
        paths = discover()
    missing = [path for path in paths if not path.is_file()]
    if missing:
        for path in missing:
            print(f"[tests] missing test file: {path}", file=sys.stderr)
        return 2
    if not paths:
        print("[tests] no tests/test_*.py scripts found", file=sys.stderr)
        return 2

    if args.list:
        for path in paths:
            print(path.name)
        return 0

    failures = run(paths, fail_fast=args.fail_fast)
    passed = len(paths) - len(failures)
    print(f"[tests] {passed}/{len(paths)} test scripts passed")
    if failures:
        print("[tests] failed: " + ", ".join(path.name for path in failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
