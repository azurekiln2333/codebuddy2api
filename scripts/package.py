"""Build, verify and safely extract the CodeBuddy2Api release archive.

The archive is the only delivery artifact that operators download, so it is
built from an explicit allowlist instead of ``git archive``/``cp -r``:

* backend source (``converter.py``, ``app/``, ``requirements.txt``, ``VERSION``)
* the compiled console (``web/dist/**``)
* the console sources, lockfile and build configuration so the *same*
  ``Dockerfile`` can rebuild ``web/dist`` without a conditional branch
* deployment templates, documentation, license and notices

Everything else is denied, including ``.env`` files, credential/``auth`` data,
SQLite databases, logs, local archives, ``node_modules``, ``.git`` and agent
runtime state (``.trellis``/``.agents``/``.claude``/``.pi`` ...).

Outputs (in the output directory, default ``dist/``):

* ``codebuddy2api-v<version>-<YYYYMMDD>.tar.gz`` -- deterministic archive
* ``<archive>.sha256`` -- ``sha256sum --check`` compatible checksum
* ``SHA256SUMS`` -- checksum index consumed by the WebUI update installer
* ``build-manifest.json`` -- machine-readable release metadata
* ``release-notes.md`` -- shared GitHub/CNB release description
* ``cnb-release-options.json`` -- ``git:release`` options with ``overlying``

CLI::

    python scripts/package.py                       # build + self-verify
    python scripts/package.py --verify dist/<archive>
    python scripts/package.py --publish-options     # CNB git:release options
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

try:  # Imported as ``scripts.package`` by the test-suite.
    from . import check_version
except ImportError:  # Executed directly as ``python scripts/package.py``.
    import check_version  # type: ignore[no-redef]

ROOT = Path(__file__).resolve().parents[1]
NAME = "codebuddy2api"

REQUIRED_FILES = ("VERSION", "converter.py", "requirements.txt", "Dockerfile", ".dockerignore")
REQUIRED_WEB = ("web/dist/index.html",)
REQUIRED_TREES = ("app",)
OPTIONAL_FILES = (
    "pyproject.toml",
    "uv.lock",
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "THIRD_PARTY_NOTICES.md",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.build.yaml",
    "docker-compose.update.yaml",
    ".env.example",
)
INCLUDE_TREES = ("app", "scripts", "docs", "web")

_DENY_DIRS = {
    "node_modules",
    "__pycache__",
    ".git",
    ".hg",
    ".svn",
    "test-results",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "site-packages",
    ".playwright",
    # Browser/unit-test and dev-server output that must never ship, even though
    # the whole `web/` tree is allowlisted.
    "playwright-report",
    "blob-report",
    "coverage",
    ".nyc_output",
    ".vite",
    ".turbo",
    ".trellis",
    ".agents",
    ".claude",
    ".codex",
    ".codebuddy",
    ".pi",
    ".qoder",
    ".trae",
    ".dsh",
    ".zcode",
    ".herdr",
}
_DENY_TOP_LEVEL_DIRS = {"auth", "dist", "build", "test-results", "node_modules", "examples"}
# Local scaffolding matched on any single path part, so it is pruned at any
# depth inside an allowlisted tree: `web/.tmp-reference.mjs` (a scratch visual
# harness dropped next to the sources by a developer), `web/.tmp-shots/`,
# `web/.venv-ci/bin/python`, `web/e2e/-tmp-state/`.
_DENY_PART_PREFIXES = (".tmp", "-tmp", ".venv")
_DENY_NAMES = {
    ".env",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".DS_Store",
    ".eslintcache",
    "Thumbs.db",
    "converter.log",
}
_DENY_SUFFIXES = (
    ".log",
    ".info",
    ".token",
    ".key",
    ".pem",
    ".p12",
    ".pfx",
    ".sqlite3",
    ".sqlite3-wal",
    ".sqlite3-shm",
    ".sqlite",
    ".db",
    ".pyc",
    ".pyo",
    ".zip",
    ".tgz",
    ".tar",
    ".tar.gz",
    ".ps1",
)


class PackageError(RuntimeError):
    """Raised when the archive cannot be produced or verified."""


class UnsafeArchiveError(PackageError):
    """Raised when an archive member could escape the extraction directory."""


def _parts(path: str | PurePosixPath | Path) -> tuple[str, ...]:
    return PurePosixPath(str(path).replace("\\", "/")).parts


def is_denied(path: str | PurePosixPath | Path) -> bool:
    """Return True when a repository-relative path must never ship."""
    parts = _parts(path)
    if not parts:
        return True
    if any(part in _DENY_DIRS or part.startswith(_DENY_PART_PREFIXES) for part in parts):
        return True
    if parts[0] in _DENY_TOP_LEVEL_DIRS:
        return True
    if len(parts) >= 2 and parts[0] == "docs" and parts[1] == "plans":
        return True
    name = parts[-1]
    if name in _DENY_NAMES:
        return True
    if name.startswith(".env.") and name != ".env.example":
        return True
    if name.endswith(".env"):
        return True
    return name.endswith(_DENY_SUFFIXES)


def _git_output(root: Path, *args: str) -> str:
    import subprocess

    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - git absent
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def collect_files(root: Path | str) -> list[str]:
    """Return the sorted, allowlisted repository-relative archive members."""
    root = Path(root).resolve()
    selected: set[str] = set()
    for name in (*REQUIRED_FILES, *OPTIONAL_FILES):
        if (root / name).is_file() and not is_denied(name):
            selected.add(name)
    for tree in INCLUDE_TREES:
        base = root / tree
        if not base.is_dir():
            continue
        for current, dirnames, filenames in os.walk(base):
            current_path = Path(current)
            relative_current = current_path.relative_to(root)
            dirnames[:] = sorted(
                name
                for name in dirnames
                if not is_denied(PurePosixPath(relative_current.as_posix()) / name)
            )
            for filename in sorted(filenames):
                relative = PurePosixPath(relative_current.as_posix()) / filename
                if not is_denied(relative):
                    selected.add(relative.as_posix())
    return sorted(selected)


def _missing_requirements(root: Path, files: list[str]) -> list[str]:
    missing = [name for name in REQUIRED_FILES if name not in files]
    for tree in REQUIRED_TREES:
        if not any(name.startswith(tree + "/") for name in files):
            missing.append(tree + "/")
    missing.extend(name for name in REQUIRED_WEB if name not in files)
    return missing


def _build_info(version: str, date: str, commit: str) -> dict[str, object]:
    return {
        "name": NAME,
        "version": version,
        "prerelease": check_version.is_prerelease(version),
        "commit": commit,
        "date": date,
    }


def _release_notes(version: str, archive: str, digest: str, built_at: str, commit: str) -> str:
    return "\n".join(
        [
            f"# {NAME} v{version}",
            "",
            f"Built at: {built_at} (UTC)",
            "",
            f"Commit: {commit or 'unknown'}",
            "",
            f"Package: `{archive}`",
            "",
            f"SHA-256: `{digest}`",
            "",
            "The archive contains the backend application, the compiled console "
            "(`web/dist/`) and the console sources with lockfile so the same "
            "`Dockerfile` can rebuild the bundle without a conditional branch.",
            "",
            "Excluded: `.env` files, credential stores and `auth/`, SQLite databases, "
            "logs, local archives, `node_modules`, `.git`, agent runtime state, local "
            "scratch paths (`.tmp*`, `-tmp*`, `.venv*`) and browser/test reports.",
            "",
        ]
    )


def _tarinfo(name: str, size: int, epoch: int, mode: int = 0o644) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mtime = epoch
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.type = tarfile.REGTYPE
    return info


def _archive_bytes(root: Path, files: list[str], prefix: str, epoch: int, build_info: bytes) -> bytes:
    """Render a byte-for-byte deterministic ``.tar.gz`` payload."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        info = _tarinfo(f"{prefix}/build-info.json", len(build_info), epoch)
        tar.addfile(info, io.BytesIO(build_info))
        for relative in files:
            payload = (root / relative).read_bytes()
            member = _tarinfo(f"{prefix}/{relative}", len(payload), epoch)
            tar.addfile(member, io.BytesIO(payload))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", mtime=epoch) as stream:
        stream.write(raw.getvalue())
    return compressed.getvalue()


def _unsafe_reason(member: tarfile.TarInfo) -> str | None:
    name = member.name
    if name.startswith(("/", "\\")):
        return "absolute path"
    if re.match(r"^[A-Za-z]:", name):
        return "windows absolute path"
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        return "path traversal"
    if member.issym() or member.islnk():
        return "link member"
    if member.ischr() or member.isblk() or member.isfifo():
        return "special file"
    if not (member.isfile() or member.isdir()):
        return "unsupported member type"
    return None


def inspect_archive(archive: Path | str) -> list[tarfile.TarInfo]:
    """Return the archive members, raising when any member is unsafe."""
    members: list[tarfile.TarInfo] = []
    try:
        handle = tarfile.open(archive, "r:gz")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise PackageError(f"{archive}: not a readable .tar.gz archive ({error})") from error
    with handle:
        for member in handle.getmembers():
            reason = _unsafe_reason(member)
            if reason:
                raise UnsafeArchiveError(f"{member.name}: {reason}")
            members.append(member)
    return members


def safe_extract(archive: Path | str, destination: Path | str) -> Path:
    """Extract an archive while refusing traversal, links and special files."""
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    try:
        handle = tarfile.open(archive, "r:gz")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise PackageError(f"{archive}: not a readable .tar.gz archive ({error})") from error
    with handle as tar:
        for member in tar.getmembers():
            reason = _unsafe_reason(member)
            if reason:
                raise UnsafeArchiveError(f"{member.name}: {reason}")
            target = (destination / member.name).resolve()
            if target != destination and destination not in target.parents:
                raise UnsafeArchiveError(f"{member.name}: escapes {destination}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:  # pragma: no cover - guarded by _unsafe_reason
                raise UnsafeArchiveError(f"{member.name}: no payload")
            with source, open(target, "wb") as handle:
                shutil.copyfileobj(source, handle)
    return destination


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(archive: Path | str, *, checksum_file: Path | str | None = None) -> dict[str, object]:
    """Validate checksum, member safety, denylist and required payload."""
    archive = Path(archive)
    if not archive.is_file():
        raise PackageError(f"archive not found: {archive}")
    digest = _sha256_file(archive)
    if checksum_file is None:
        default = archive.with_name(archive.name + ".sha256")
        checksum_file = default if default.is_file() else None
    if checksum_file is not None:
        text = Path(checksum_file).read_text(encoding="utf-8").strip()
        recorded = text.split()[0] if text else ""
        if recorded != digest:
            raise PackageError(
                f"checksum mismatch for {archive.name}: {recorded or '<empty>'} != {digest}"
            )
    members = inspect_archive(archive)
    names = [member.name for member in members if member.isfile()]
    prefixes = {PurePosixPath(name).parts[0] for name in names if PurePosixPath(name).parts}
    if len(prefixes) != 1:
        raise PackageError(f"archive must contain exactly one top-level directory: {prefixes}")
    prefix = prefixes.pop()
    relative = [PurePosixPath(*PurePosixPath(name).parts[1:]).as_posix() for name in names]
    denied = sorted({name for name in relative if is_denied(name)})
    if denied:
        raise PackageError(f"archive contains denied paths: {denied}")
    for required in (*REQUIRED_FILES, *REQUIRED_WEB, "build-info.json"):
        if required not in relative:
            raise PackageError(f"archive is missing required file: {required}")
    if not any(name.startswith("app/") for name in relative):
        raise PackageError("archive is missing the app/ backend package")
    return {
        "sha256": digest,
        "prefix": prefix,
        "files": relative,
        "size": archive.stat().st_size,
        "archive": archive.name,
    }


def _resolve_epoch(root: Path, override: int | None, environ: dict[str, str]) -> int:
    if override is not None:
        return int(override)
    if raw := environ.get("SOURCE_DATE_EPOCH"):
        try:
            return int(raw)
        except ValueError:
            pass
    if raw := _git_output(root, "log", "-1", "--format=%ct"):
        try:
            return int(raw)
        except ValueError:
            pass
    return 0


def _resolve_date(root: Path, override: str | None) -> str:
    if override:
        if not re.fullmatch(r"\d{8}", override):
            raise PackageError(f"--date must be YYYYMMDD, got {override!r}")
        return override
    if raw := _git_output(root, "log", "-1", "--format=%cd", "--date=format:%Y%m%d"):
        if re.fullmatch(r"\d{8}", raw):
            return raw
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def _resolve_source(environ: dict[str, str]) -> str:
    if server := environ.get("GITHUB_SERVER_URL"):
        if repository := environ.get("GITHUB_REPOSITORY"):
            return f"{server.rstrip('/')}/{repository}"
    if url := environ.get("CNB_REPO_URL_HTTPS"):
        return url
    return ""


def build_package(
    root: Path | str | None = None,
    output: Path | str | None = None,
    *,
    date: str | None = None,
    tag: str | None = None,
    epoch: int | None = None,
    environ: dict[str, str] | None = None,
) -> dict[str, object]:
    """Build the release archive and its metadata, verifying before publishing."""
    root = Path(root or ROOT).resolve()
    output = Path(output or (root / "dist")).resolve()
    env = os.environ if environ is None else environ

    version = check_version.read_version(root / "VERSION")
    resolved_tag = tag if tag is not None else env.get("RELEASE_TAG", "")
    if resolved_tag:
        check_version.check_ref(f"refs/tags/{resolved_tag}", version)

    files = collect_files(root)
    missing = _missing_requirements(root, files)
    if missing:
        raise PackageError(
            "release archive is incomplete; build the console first (web/dist/index.html) "
            f"and check the repository layout; missing: {missing}"
        )

    built_epoch = _resolve_epoch(root, epoch, env)
    built_date = _resolve_date(root, date)
    commit = env.get("GITHUB_SHA") or env.get("CNB_COMMIT") or _git_output(root, "rev-parse", "HEAD")
    source = _resolve_source(env)
    image = env.get("RELEASE_IMAGE") or env.get("CNB_IMAGE", "")
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    archive_name = f"{NAME}-v{version}-{built_date}.tar.gz"
    prefix = f"{NAME}-{version}"
    build_info = json.dumps(_build_info(version, built_date, commit), indent=2, sort_keys=True) + "\n"
    payload = _archive_bytes(root, files, prefix, built_epoch, build_info.encode("utf-8"))

    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / archive_name
    staging = output / f".{archive_name}.tmp"
    staging.write_bytes(payload)
    digest = _sha256_file(staging)

    # Verify the staged artifact before it can be mistaken for a release.
    checksum_path = output / f"{archive_name}.sha256"
    checksum_path.write_text(f"{digest}  {archive_name}\n", encoding="utf-8")
    try:
        verify_archive(staging, checksum_file=None)
    except PackageError:
        staging.unlink(missing_ok=True)
        checksum_path.unlink(missing_ok=True)
        raise
    staging.replace(archive_path)
    # The updater discovers this conventional asset name from GitHub releases.
    # Keep it identical to the per-archive sidecar so both installation paths
    # verify exactly the artifact produced and checked above.
    (output / "SHA256SUMS").write_text(f"{digest}  {archive_name}\n", encoding="utf-8")

    manifest = {
        "name": NAME,
        "version": version,
        "prerelease": check_version.is_prerelease(version),
        "tag": check_version.release_tag(version),
        "archive": archive_name,
        "sha256": digest,
        "builtAt": built_at,
        "date": built_date,
        "commit": commit,
        "source": source,
        "image": image,
        "prefix": prefix,
        "files": len(files) + 1,
    }
    (output / "build-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output / "release-notes.md").write_text(
        _release_notes(version, archive_name, digest, built_at, commit), encoding="utf-8"
    )
    return manifest


def write_publish_options(output: Path | str | None = None) -> dict[str, object]:
    """Write the CNB ``git:release`` options with idempotent ``overlying``."""
    output = Path(output or (ROOT / "dist")).resolve()
    manifest_path = output / "build-manifest.json"
    if not manifest_path.is_file():
        raise PackageError(f"missing {manifest_path}; run the package step first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not (output / "release-notes.md").is_file():
        raise PackageError("missing dist/release-notes.md; run the package step first")
    prerelease = bool(manifest["prerelease"])
    options = {
        "overlying": True,
        "title": f"{NAME} v{manifest['version']}",
        "descriptionFromFile": "dist/release-notes.md",
        "preRelease": prerelease,
        "latest": not prerelease,
    }
    (output / "cnb-release-options.json").write_text(
        json.dumps(options, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return options


def _write_github_output(path: str, manifest: dict[str, object]) -> None:
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(f"archive={manifest['archive']}\n")
        stream.write(f"version={manifest['version']}\n")
        stream.write(f"prerelease={str(manifest['prerelease']).lower()}\n")
        stream.write(f"sha256={manifest['sha256']}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=None, help="repository root (defaults to this checkout)")
    parser.add_argument("--output", default=None, help="artifact directory (defaults to <root>/dist)")
    parser.add_argument("--date", default=None, help="archive date stamp YYYYMMDD")
    parser.add_argument("--tag", default=None, help="expected release tag, e.g. v1.2.3")
    parser.add_argument("--verify", default=None, help="verify an existing archive instead of building")
    parser.add_argument("--publish-options", action="store_true", help="write dist/cnb-release-options.json")
    args = parser.parse_args(argv)
    try:
        if args.verify:
            info = verify_archive(args.verify)
            print(f"[package] verified {info['archive']} ({info['sha256']})")
            print(f"[package] {len(info['files'])} files under {info['prefix']}/")
            return 0
        if args.publish_options:
            options = write_publish_options(args.output)
            print(json.dumps(options, indent=2, sort_keys=True))
            return 0
        manifest = build_package(args.root, args.output, date=args.date, tag=args.tag)
    except (PackageError, ValueError) as error:
        print(f"[package] {error}", file=sys.stderr)
        return 1
    print(f"[package] archive={manifest['archive']}")
    print(f"[package] sha256={manifest['sha256']}")
    print(f"[package] version={manifest['version']} prerelease={str(manifest['prerelease']).lower()}")
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        _write_github_output(target, manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
