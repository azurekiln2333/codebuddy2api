"""Assert the Compose contracts against rendered `docker compose config` JSON.

Main controller reproduction recipe (portable Compose CLI, no Docker engine needed).
PowerShell, from the product repository root D:/My2KProjects/codebuddy2api:

    $cli = 'D:/My2KProjects/.compose-cli/docker-compose.exe'      # v5.6.1, standalone
    $tmp = 'D:/AppData/Local/Temp/cb2a-render'
    $env = "$tmp/synthetic.env"

    # 1. synthetic env (every SSO value filled so interpolation is exercised)
    @'
    CODEBUDDY2API_IMAGE=ghcr.io/example/codebuddy2api:1.3.5
    CODEBUDDY2API_AUTH_PATH=./auth
    CODEBUDDY2API_SSO_ENABLED=true
    PUBLIC_ORIGIN=https://console.example.com
    OIDC_ISSUER=https://idp.example.com
    OIDC_CLIENT_ID=client-abc
    OIDC_CLIENT_SECRET=secret-xyz
    OIDC_REFRESH=true
    ALLOW_INSECURE_LOCALHOST=false
    CODEBUDDY2API_KEY=test-key
    '@ | Set-Content $env -Encoding utf8

    # 2. the three renders (+ one scope-isolation probe)
    & $cli -f docker-compose.yml --env-file $env config --format json |
        Out-File -Encoding utf8 "$tmp/out-default.json"
    & $cli -f docker-compose.yml --env-file $env --profile auto-update config --format json |
        Out-File -Encoding utf8 "$tmp/out-update.json"
    & $cli -f docker-compose.yml -f docker-compose.build.yaml --env-file $env config --format json |
        Out-File -Encoding utf8 "$tmp/out-build.json"
    & $cli -f docker-compose.yml -f docker-compose.build.yaml --env-file $env `
        --profile auto-update -p alpha config --format json |
        Out-File -Encoding utf8 "$tmp/out-alpha.json"

    # 3. assertions
    python -B implementation/check-compose-assert.py $tmp

Notes:
* `--format json` is required: v5.6.1 renders YAML by default.
* Use `| Out-File -Encoding utf8` (not `>`): the `>` redirection writes UTF-16LE on
  Windows PowerShell 5.1 and the JSON loader then fails on the BOM.
* `config` only interpolates and normalises the YAML. It never pulls, builds or runs
  anything, so no Docker engine or daemon is required.
* `-p alpha` proves `${COMPOSE_PROJECT_NAME:-...}` really resolves to the effective
  project name, which is what isolates two stacks' watchtower scopes.
* Run from the product repository root so `docker-compose.yml` resolves, and point
  `python -B .../check-compose-assert.py` at the render directory.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'}  {label}{f'  [{detail}]' if detail and not condition else ''}")
    if not condition:
        FAILURES.append(f"{label} {detail}".strip())


def load(directory: Path, name: str) -> dict:
    return json.loads((directory / name).read_text(encoding="utf-8-sig"))


def main(argv: list[str]) -> int:
    directory = Path(argv[1] if len(argv) > 1 else "D:/AppData/Local/Temp/cb2a-render")
    default = load(directory, "out-default.json")
    update = load(directory, "out-update.json")
    build = load(directory, "out-build.json")
    alpha = load(directory, "out-alpha.json")

    app = default["services"]["codebuddy2api"]
    print("--- default render (pull-only base) ---")
    check("base service is pull-only (no build section)", "build" not in app)
    check("default image resolves to the supplied fork image", "codebuddy2api:1.3.5" in app["image"], app["image"])
    check("no auto-update profile active by default", app.get("profiles") in (None, []), str(app.get("profiles")))
    check("watchtower absent unless profiled", "watchtower" not in default["services"], str(list(default["services"])))
    check("init enabled", app.get("init") is True)
    check("restart policy unless-stopped", app.get("restart") == "unless-stopped")
    check("log rotation bounded", "max-size" in app["logging"]["options"] and "max-file" in app["logging"]["options"])
    check("app opts into watchtower (enable=true)", str(app["labels"]["com.centurylinklabs.watchtower.enable"]) == "true")
    check("app carries a watchtower scope", bool(app["labels"].get("com.centurylinklabs.watchtower.scope")))
    check("loopback host port", app["ports"][0]["host_ip"] in ("127.0.0.1", "::1"), str(app["ports"]))
    check("data bind mount retained", any(v["target"] == "/data/auth" for v in app["volumes"]), str(app["volumes"]))
    for name in ("SESSION_TTL_MS", "SESSION_IDLE_MS", "TRANSACTION_TTL_MS", "MAX_SESSIONS", "OAUTH_TIMEOUT_MS"):
        check(f"optional tuning knob forwarded empty: {name}", app["environment"].get(name) == "", repr(app["environment"].get(name)))
    for name in ("CODEBUDDY2API_SSO_ENABLED", "PUBLIC_ORIGIN", "OIDC_ISSUER", "OIDC_CLIENT_ID",
                 "OIDC_CLIENT_SECRET", "OIDC_REFRESH", "ALLOW_INSECURE_LOCALHOST"):
        check(f"fixed SSO env forwarded: {name}", name in app["environment"])

    print("--- auto-update profile render ---")
    tower = update["services"].get("watchtower", {})
    check("watchtower service appears only under the profile", bool(tower))
    check("watchtower is the pinned fork image",
          "nickfedor/watchtower:1.23.2" in tower.get("image", "")
          and "containrrr" not in tower.get("image", "")
          and not tower.get("image", "").endswith(":latest"), tower.get("image", ""))
    check("watchtower never updates itself",
          str(tower.get("labels", {}).get("com.centurylinklabs.watchtower.enable")) == "false")
    check("label-enable mode on", str(tower.get("environment", {}).get("WATCHTOWER_LABEL_ENABLE")) in ("true", "True"))
    check("self scope equals the app scope",
          tower.get("labels", {}).get("com.centurylinklabs.watchtower.scope")
          == app["labels"].get("com.centurylinklabs.watchtower.scope"), str(tower.get("labels")))
    check("docker socket mounted", any("/var/run/docker.sock" in v["source"] for v in tower.get("volumes", [])), str(tower.get("volumes")))
    check("profile render still pulls the app image", "build" not in update["services"]["codebuddy2api"])

    print("--- build override render ---")
    built = build["services"]["codebuddy2api"]
    check("override adds a build section", "build" in built)
    check("pull_policy forces local build", built.get("pull_policy") == "build", str(built.get("pull_policy")))
    check("local image tag used, not the published one", built["image"].startswith("codebuddy2api:"), built["image"])
    check("locally built container is excluded from auto-update",
          str(built["labels"]["com.centurylinklabs.watchtower.enable"]) == "false", str(built["labels"]))
    check("build context contains the Dockerfile",
          (Path(built["build"]["context"]) / built["build"].get("dockerfile", "Dockerfile")).is_file(),
          str(built["build"]))

    print("--- -p alpha scope isolation probe ---")
    alpha_app = alpha["services"]["codebuddy2api"]
    check("project name flows into the app scope label",
          alpha_app["labels"]["com.centurylinklabs.watchtower.scope"] == "alpha", str(alpha_app["labels"]))
    check("container_name stays fixed for documented docker compose exec",
          alpha_app.get("container_name") == "codebuddy2api")

    print()
    print(f"total failures: {len(FAILURES)}")
    for item in FAILURES:
        print(f"  - {item}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
