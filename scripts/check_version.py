"""Validate the authoritative application version and everything derived from it.

``VERSION`` is the single source of truth consumed by the runtime
(``converter.py``). ``pyproject.toml`` metadata and the default Compose image
tag are *derived* values, so both release platforms call this module instead of
re-implementing (and drifting from) the same rules.

The module is import-safe for ``tests/test_version.py`` and provides a CLI used
by ``.github/workflows`` and ``.cnb.yml``:

    python scripts/check_version.py --check-pyproject --check-compose

Reference resolution order (``--ref`` wins):

1. explicit ``--ref`` / ``ref`` argument
2. ``GITHUB_REF``
3. ``CNB_BRANCH`` together with ``CNB_IS_TAG``

Tag refs must equal ``v<VERSION>``. Branch and pull-request refs are accepted
because they never publish a release. Prerelease versions (``1.4.0-rc.1``) are
valid; the derived ``prerelease`` flag tells the publication jobs to skip the
``latest``/``X.Y``/``X`` aliases.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "VERSION"
PYPROJECT_FILE = ROOT / "pyproject.toml"
COMPOSE_FILE = ROOT / "docker-compose.yml"

# SemVer core with an optional prerelease suffix. Build metadata (``+``) is not
# part of a release tag here, so it is rejected instead of silently ignored.
VERSION_PATTERN = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_COMPOSE_IMAGE_LINE = re.compile(r"(?m)^\s*image:\s*(\S.*?)\s*$")
_COMPOSE_DEFAULT = re.compile(r"\$\{[^:}]+:?-?([^}]*)\}")

# Tags a neutral Compose default may carry. A concrete version is only allowed
# when it is the authoritative one, so a forgotten bump fails the gate.
COMPOSE_ALLOWED_TAGS = ("latest",)


def read_version(path: Path | str | None = None) -> str:
    """Return the validated authoritative version string."""
    target = VERSION_FILE if path is None else path
    value = Path(target).read_text(encoding="utf-8").strip()
    return validate_version(value)


def validate_version(value: str) -> str:
    """Validate a version string and return it unchanged."""
    if not VERSION_PATTERN.fullmatch(value):
        raise ValueError(
            "VERSION must be a semantic version such as 1.2.3 or 1.2.3-rc.1, "
            f"got {value!r}"
        )
    return value


def is_prerelease(version: str) -> bool:
    """Return True when the version carries a prerelease suffix."""
    return "-" in version


def release_tag(version: str) -> str:
    """Return the release tag that a given version must be published under."""
    return f"v{version}"


def resolve_ref(environ: dict[str, str] | None = None) -> str:
    """Resolve the current git ref from whichever platform is running."""
    env = os.environ if environ is None else environ
    if github_ref := env.get("GITHUB_REF"):
        return github_ref
    branch = env.get("CNB_BRANCH")
    if not branch:
        return ""
    is_tag = str(env.get("CNB_IS_TAG", "")).strip().lower() in {"1", "true", "yes", "on"}
    return f"refs/tags/{branch}" if is_tag else f"refs/heads/{branch}"


def check_ref(ref: str, version: str) -> None:
    """Reject a release tag that does not match the authoritative version."""
    prefix = "refs/tags/"
    if not ref.startswith(prefix):
        return
    tag = ref[len(prefix):]
    if tag != release_tag(version):
        raise ValueError(
            f"release tag must be {release_tag(version)} to match VERSION, got {tag!r}"
        )


def pyproject_version(path: Path | str | None = None) -> str:
    """Return ``[project].version`` from ``pyproject.toml``."""
    target = PYPROJECT_FILE if path is None else path
    data = tomllib.loads(Path(target).read_text(encoding="utf-8"))
    try:
        return str(data["project"]["version"])
    except KeyError as error:  # pragma: no cover - malformed project file
        raise ValueError("pyproject.toml is missing [project].version") from error


def compose_image_default(path: Path | str | None = None) -> str:
    """Return the Compose default application image reference."""
    target = COMPOSE_FILE if path is None else path
    text = Path(target).read_text(encoding="utf-8")
    candidates = _COMPOSE_IMAGE_LINE.findall(text)
    for line in candidates:
        if "CODEBUDDY2API_IMAGE" in line:
            break
    else:  # Fall back to the first service image when no explicit variable is used.
        if not candidates:
            raise ValueError("docker-compose.yml has no service image")
        line = candidates[0]
    match = _COMPOSE_DEFAULT.search(line)
    value = match.group(1) if match else line
    value = value.strip().strip("\"'")
    if not value:
        raise ValueError(
            "docker-compose.yml must give CODEBUDDY2API_IMAGE an explicit default "
            "such as codebuddy2api:latest"
        )
    return value


def compose_default_tag(path: Path | str | None = None) -> str:
    """Return the tag portion of the Compose default application image."""
    image = compose_image_default(path)
    _, separator, tag = image.rpartition(":")
    if not separator or "/" in tag:
        raise ValueError(
            f"docker-compose.yml image {image!r} must carry an explicit tag"
        )
    return tag


# Keep the historical name available for callers that ask for the tag itself.
compose_image_tag = compose_default_tag


def check_version(
    ref: str = "",
    *,
    check_pyproject: bool = False,
    check_compose: bool = False,
) -> str:
    """Validate ``VERSION`` and return it.

    ``check_pyproject`` and ``check_compose`` enable the derived-metadata gates
    that the release pipelines run. They stay opt-in so importing callers can
    validate a temporary ``VERSION`` file without also rewriting project files.
    """
    version = read_version()
    check_ref(ref, version)
    if check_pyproject:
        declared = pyproject_version()
        if declared != version:
            raise ValueError(
                f"pyproject.toml version {declared!r} must match VERSION {version!r}"
            )
    if check_compose:
        tag = compose_default_tag()
        allowed = {*COMPOSE_ALLOWED_TAGS, version, release_tag(version)}
        if tag not in allowed:
            raise ValueError(
                f"docker-compose.yml default image tag {tag!r} must be one of "
                f"{sorted(allowed)}"
            )
    return version


def _outputs(version: str) -> dict[str, str]:
    return {
        "version": version,
        "prerelease": "true" if is_prerelease(version) else "false",
        "tag": release_tag(version),
    }


def _write_github_output(path: str, outputs: dict[str, str]) -> None:
    with open(path, "a", encoding="utf-8") as stream:
        for key, value in outputs.items():
            stream.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default=None, help="git ref; defaults to the platform ref")
    parser.add_argument("--check-pyproject", action="store_true")
    parser.add_argument("--check-compose", action="store_true")
    args = parser.parse_args(argv)
    ref = args.ref if args.ref is not None else resolve_ref()
    try:
        version = check_version(
            ref,
            check_pyproject=args.check_pyproject,
            check_compose=args.check_compose,
        )
    except ValueError as error:
        print(f"check_version: {error}", file=sys.stderr)
        return 2
    outputs = _outputs(version)
    for key, value in outputs.items():
        print(f"{key}={value}")
    target = os.environ.get("GITHUB_OUTPUT", "")
    if target:
        _write_github_output(target, outputs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
