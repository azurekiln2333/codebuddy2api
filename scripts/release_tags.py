"""Resolve the release image name and tag set for every publication platform.

Both release pipelines (GitHub Actions and CNB) call this module so a stable
release publishes exactly the same aliases on both registries:

* stable ``vX.Y.Z``  -> ``vX.Y.Z``, ``X.Y.Z``, ``X.Y``, ``X``, ``sha-<12>``, ``latest``
* prerelease         -> ``vX.Y.Z-pre``, ``sha-<12>`` (no floating aliases, no ``latest``)
* ``main`` branch    -> ``edge``, ``sha-<12>`` (validation-only build)
* pull requests      -> ``sha-<12>`` build tag only, never pushed

Registry paths are derived from platform variables, never hard-coded:

* GitHub -> ``ghcr.io/<lowercased github.repository>``
* CNB    -> ``${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}``

``RELEASE_IMAGE`` (both platforms) and ``CNB_IMAGE`` (CNB) override the derived
path for self-hosted registries.

CLI::

    python scripts/release_tags.py --platform github --emit github
    eval "$(python scripts/release_tags.py --platform cnb --emit shell)"
"""

from __future__ import annotations

import argparse
import os
import shlex
import sys
from pathlib import Path

try:  # Imported as ``scripts.release_tags`` by the test-suite.
    from . import check_version
except ImportError:  # Executed directly as ``python scripts/release_tags.py``.
    import check_version  # type: ignore[no-redef]

DEFAULT_CNB_REGISTRY = "docker.cnb.cool"
DEFAULT_CNB_USER = "cnb"
GITHUB_REGISTRY = "ghcr.io"


def resolve_image(platform: str, environ: dict[str, str] | None = None) -> tuple[str, str]:
    """Return ``(image_repository, registry_host)`` for the active platform."""
    env = os.environ if environ is None else environ
    override = env.get("RELEASE_IMAGE") or (env.get("CNB_IMAGE", "") if platform == "cnb" else "")
    if override:
        image = override.strip().rstrip("/")
        if not image:
            raise ValueError("RELEASE_IMAGE must not be blank")
        candidate = image.split("/", 1)[0] if "/" in image else ""
        registry = candidate if ("." in candidate or ":" in candidate) else ""
        if not registry:
            registry = DEFAULT_CNB_REGISTRY if platform == "cnb" else GITHUB_REGISTRY
        return image, registry

    if platform == "github":
        repository = env.get("GITHUB_REPOSITORY", "").strip()
        if not repository:
            raise ValueError("GITHUB_REPOSITORY is required to resolve the GHCR image")
        return f"{GITHUB_REGISTRY}/{repository.lower()}", GITHUB_REGISTRY

    if platform == "cnb":
        registry = (
            env.get("CNB_REGISTRY")
            or env.get("CNB_DOCKER_REGISTRY")
            or DEFAULT_CNB_REGISTRY
        ).strip().rstrip("/")
        slug = (
            env.get("CNB_REPO_SLUG_LOWERCASE")
            or env.get("CNB_REPO_SLUG", "")
        ).strip().strip("/")
        if not slug:
            raise ValueError(
                "CNB_REPO_SLUG_LOWERCASE is required to resolve the CNB image"
            )
        return f"{registry}/{slug}", registry

    raise ValueError(f"unknown platform {platform!r}")


def resolve_tags(version: str, ref: str, sha: str = "") -> list[str]:
    """Return the ordered image tag set for a version and git ref."""
    short_sha = (sha or "").strip()[:12]
    if ref.startswith("refs/tags/"):
        primary = check_version.release_tag(version)
        if check_version.is_prerelease(version):
            tags = [primary]
            if short_sha:
                tags.append(f"sha-{short_sha}")
            return tags
        major, minor = version.split(".")[:2]
        tags = [primary, version, f"{major}.{minor}", major]
        if short_sha:
            tags.append(f"sha-{short_sha}")
        # ``latest`` is appended last and only for a stable tag.
        tags.append("latest")
        return tags
    # Only the exact default branch publishes the moving `edge` alias; feature
    # branches (e.g. `main-fix`, `maintenance`) must stay `sha-` only.
    if ref == "refs/heads/main":
        tags = ["edge"]
        if short_sha:
            tags.append(f"sha-{short_sha}")
        return tags
    # Pull requests and feature branches only ever build locally.
    return [f"sha-{short_sha}"] if short_sha else ["local-build"]


def resolve(
    platform: str,
    *,
    ref: str | None = None,
    version: str | None = None,
    sha: str | None = None,
    environ: dict[str, str] | None = None,
) -> dict[str, object]:
    """Return the complete publication contract for a platform."""
    env = os.environ if environ is None else environ
    resolved_ref = ref if ref is not None else check_version.resolve_ref(env)
    resolved_version = (
        check_version.validate_version(version)
        if version is not None
        else check_version.read_version()
    )
    check_version.check_ref(resolved_ref, resolved_version)
    resolved_sha = sha if sha is not None else (env.get("GITHUB_SHA") or env.get("CNB_COMMIT", ""))
    image, registry = resolve_image(platform, env)
    tags = resolve_tags(resolved_version, resolved_ref, resolved_sha)
    user = (
        env.get("GITHUB_ACTOR", "")
        if platform == "github"
        else env.get("CNB_REGISTRY_USER", "").strip() or DEFAULT_CNB_USER
    )
    return {
        "version": resolved_version,
        "prerelease": check_version.is_prerelease(resolved_version),
        "primary_tag": check_version.release_tag(resolved_version),
        "image": image,
        "registry": registry,
        "registry_user": user,
        "tags": tags,
        "refs": [f"{image}:{tag}" for tag in tags],
    }


_SCALAR_KEYS = ("version", "prerelease", "primary_tag", "image", "registry", "registry_user")


def _scalar(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def format_kv(contract: dict[str, object]) -> str:
    """Render ``key=value`` lines for humans and shell-free consumers."""
    lines = [f"{key}={_scalar(contract[key])}" for key in _SCALAR_KEYS]
    lines.append("tags=" + " ".join(contract["tags"]))  # type: ignore[arg-type]
    lines.append("refs=" + " ".join(contract["refs"]))  # type: ignore[arg-type]
    return "\n".join(lines)


def format_shell(contract: dict[str, object]) -> str:
    """Render ``eval``-safe ``KEY='value'`` assignments for CNB scripts."""
    mapping = {
        "VERSION": contract["version"],
        "PRERELEASE": _scalar(contract["prerelease"]),
        "PRIMARY_TAG": contract["primary_tag"],
        "IMAGE": contract["image"],
        "REGISTRY": contract["registry"],
        "REGISTRY_USER": contract["registry_user"],
        "TAGS": " ".join(contract["tags"]),  # type: ignore[arg-type]
        "REFS": " ".join(contract["refs"]),  # type: ignore[arg-type]
    }
    return "\n".join(f"{key}={shlex.quote(str(value))}" for key, value in mapping.items())


def format_github(contract: dict[str, object]) -> str:
    """Render GitHub Actions ``$GITHUB_OUTPUT`` content (multiline ``refs``)."""
    lines = [f"{key}={_scalar(contract[key])}" for key in _SCALAR_KEYS]
    lines.append("tags=" + " ".join(contract["tags"]))  # type: ignore[arg-type]
    lines.append("refs<<RELEASE_REFS_EOF")
    lines.extend(str(ref) for ref in contract["refs"])  # type: ignore[union-attr]
    lines.append("RELEASE_REFS_EOF")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("github", "cnb"), required=True)
    parser.add_argument("--ref", default=None)
    parser.add_argument("--sha", default=None)
    parser.add_argument("--version", default=None)
    parser.add_argument("--emit", choices=("kv", "shell", "github"), default="kv")
    args = parser.parse_args(argv)
    try:
        contract = resolve(
            args.platform,
            ref=args.ref,
            version=args.version,
            sha=args.sha,
        )
    except ValueError as error:
        print(f"release_tags: {error}", file=sys.stderr)
        return 2
    if args.emit == "shell":
        print(format_shell(contract))
    elif args.emit == "github":
        rendered = format_github(contract)
        target = os.environ.get("GITHUB_OUTPUT")
        if target:
            with open(target, "a", encoding="utf-8") as stream:
                stream.write(rendered + "\n")
        print(rendered)
    else:
        print(format_kv(contract))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
