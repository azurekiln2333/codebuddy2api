"""Test deployment templates, Docker runtime files and Python 3.12 syntax offline."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import ast
import pathlib
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from textwrap import dedent


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DEFAULTS = {
    "max_images": 16, "image_policy": "truncate",
    "max_request_bytes": 33554432, "log_body_limit": 65536,
    "admin_csrf": True, "keep_tool_metadata": False,
    "responses_projection_mode": "balanced", "responses_projection_max_bytes": 40000,
}
API_ENDPOINTS = {
    "chat/completions": "POST", "responses": "POST", "messages": "POST",
    "messages/count_tokens": "POST", "models": "GET",
}


def docker_sources():
    """Inspect local runtime-stage COPY sources, excluding frontend build artifacts."""
    files = set()
    runtime = False
    for line in (ROOT / "Dockerfile").read_text().splitlines():
        try:
            parts = shlex.split(line)
        except ValueError:  # Backslash line continuations are not a directive of their own.
            continue
        if parts and parts[0] == "FROM":
            runtime = parts[-1] == "runtime" or parts[1].startswith("python:")
        if not runtime or not parts or parts[0] != "COPY" or any(p.startswith("--from=") for p in parts):
            continue
        for source in parts[1:-1]:
            path = ROOT / source
            if source.endswith("/"):
                for pattern in ("*.py", "adapters/*.py"):
                    # Normalize to POSIX form so the allowlist comparisons and assertions
                    # behave identically on Windows and Linux checkouts.
                    files.update(item.relative_to(ROOT).as_posix() for item in path.glob(pattern))
            elif path.is_dir():
                files.update(item.relative_to(ROOT).as_posix() for item in path.rglob("*.py"))
            else:
                files.add(source)
    return files


def _local_dependency(source: str, module: str) -> str | None:
    """Resolve repository runtime imports, returning None for external dependencies."""
    if module.startswith("."):  # Resolve package-relative imports from the source directory.
        base = pathlib.PurePosixPath(source).parent
        candidate = (base / module.lstrip(".").replace(".", "/")).with_suffix(".py")
        return str(candidate) if (ROOT / str(candidate)).is_file() else None
    if not module.startswith("app."):  # Validate only repository runtime modules.
        return None
    candidate = pathlib.PurePosixPath(module.replace(".", "/")).with_suffix(".py")
    if (ROOT / str(candidate)).is_file():
        return str(candidate)
    package = pathlib.PurePosixPath(module.replace(".", "/")) / "__init__.py"
    return str(package) if (ROOT / str(package)).is_file() else None


def _continuation_lines(lines, start):
    """Join one directive with its backslash-continued lines."""
    parts = []
    index = start
    while index < len(lines):
        parts.append(lines[index].strip() if index > start else lines[index])
        if not lines[index].rstrip().endswith("\\"):
            break
        index += 1
    return parts


class DeploymentTests(unittest.TestCase):
    def test_env_template_matches_runtime_defaults_and_contains_no_shared_key(self):
        values = {}
        for line in (ROOT / ".env.example").read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value
        for env_key, config_key in (("MAX_IMAGES", "max_images"), ("IMAGE_POLICY", "image_policy"),
                                    ("MAX_REQUEST_BYTES", "max_request_bytes"), ("LOG_BODY_LIMIT", "log_body_limit")):
            self.assertEqual(values["CODEBUDDY2API_" + env_key], str(RUNTIME_DEFAULTS[config_key]))
        self.assertEqual(values["CODEBUDDY2API_KEY"], "")
        self.assertEqual(values["CODEBUDDY2API_BIND"], "127.0.0.1")
        # The template must point at a pullable fork image, never the upstream author.
        self.assertRegex(values["CODEBUDDY2API_IMAGE"],
                         r"^[a-z0-9.-]+/[a-z0-9_.-]+/codebuddy2api:(latest|v?\d+\.\d+\.\d+)$")
        self.assertNotIn("maiphucgiang", values["CODEBUDDY2API_IMAGE"])
        self.assertEqual(values["CODEBUDDY2API_SSO_ENABLED"], "true")
        self.assertEqual(values["ALLOW_INSECURE_LOCALHOST"], "false")
        self.assertEqual(values["CODEBUDDY2API_AUTH_PATH"], "./auth")
        self.assertNotIn("CODEBUDDY2API_AUTO_TRIAL", values)
        self.assertNotIn("CODEBUDDY2API_AUTO_TRIAL", (ROOT / "docker-compose.yml").read_text())
        self.assertEqual(values["CODEBUDDY2API_ADMIN_CSRF"], str(RUNTIME_DEFAULTS["admin_csrf"]).lower())
        self.assertNotIn("CODEBUDDY2API_ADMIN_ORIGINS", values)
        self.assertNotIn("CODEBUDDY2API_KEEP_TOOL_METADATA", values)
        self.assertNotIn("CODEBUDDY2API_RESPONSES_PROJECTION_MODE", values)
        self.assertNotIn("CODEBUDDY2API_RESPONSES_PROJECTION_MAX_BYTES", values)

    def test_tool_metadata_and_origins_stay_optional_through_dotenv(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        example = (ROOT / ".env.example").read_text()
        self.assertIn("env_file:", compose)
        for key in ("CODEBUDDY2API_KEEP_TOOL_METADATA", "CODEBUDDY2API_ADMIN_ORIGINS"):
            with self.subTest(key=key):
                # .env decides these; leaving them out keeps the WebUI authoritative.
                self.assertNotIn(key + ":", compose)
                self.assertRegex(example, rf"(?m)^# {key}=")

    def test_responses_projection_stays_optional_through_dotenv(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        example = (ROOT / ".env.example").read_text()
        for key in ("CODEBUDDY2API_RESPONSES_PROJECTION_MODE",
                    "CODEBUDDY2API_RESPONSES_PROJECTION_MAX_BYTES"):
            self.assertNotIn(key + ":", compose)
            self.assertRegex(example, rf"(?m)^# {key}=")

    def test_docker_copies_and_allows_all_local_runtime_imports(self):
        files = docker_sources()
        self.assertTrue({"app/client_profiles.py", "app/site_routing.py", "app/trial_rewards.py"} <= files)
        self.assertTrue({"app/adapters/anthropic_adapter.py", "app/adapters/responses_adapter.py",
                         "app/adapters/responses_projection.py"} <= files)
        ignore = (ROOT / ".dockerignore").read_text().splitlines()
        self.assertEqual(ignore[1], "**")
        for filename in files:
            self.assertTrue((ROOT / filename).is_file(), filename)
            if not filename.endswith(".py"):
                continue
            self.assertTrue(any(line == "!" + filename or pathlib.PurePosixPath(filename).match(line[1:])
                                for line in ignore if line.startswith("!")), filename)
            tree = ast.parse((ROOT / filename).read_text(), filename, feature_version=(3, 12))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [f"{'.' * node.level}{node.module or ''}"]
                else:
                    continue
                for module in modules:
                    dependency = _local_dependency(filename, module)
                    if dependency is not None:
                        self.assertIn(dependency, files, f"{filename} imports missing {dependency}")
        self.assertNotIn(".env", files)
        self.assertNotIn(".env.example", files)

    @unittest.skipIf(sys.platform == "win32",
                     "importing asyncio initializes Winsock on Windows, which this test's "
                     "no-network audit hook forbids; the isolation check runs on Linux CI")
    def test_docker_runtime_file_set_imports_in_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            for filename in docker_sources():
                target = Path(directory) / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / filename, target)
            # Isolate imports and block network or credential access with a temporary HOME and audit hooks.
            command = dedent("""\
                import os
                import sys
                from pathlib import Path

                def deny_external_access(event, args):
                    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system"}:
                        raise RuntimeError("External access is forbidden in deployment tests")
                    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
                        path = Path(os.fsdecode(args[0]))
                        if (path.name == ".env" or path.suffix == ".info"
                                or "auth" in path.parts or ".codebuddy" in path.parts):
                            raise RuntimeError("Credential access is forbidden in deployment tests")

                sys.addaudithook(deny_external_access)
                import converter
                from app import client_profiles
                from app import site_routing

                assert converter.health() == {"status": "ok"}
                routes = {(route.path, method) for route in converter.app.routes
                          for method in getattr(route, "methods", ())}
                """)
            command += f"\nexpected_defaults = {RUNTIME_DEFAULTS!r}\n"
            command += "assert {key: converter.CONFIG[key] for key in expected_defaults} == expected_defaults\n"
            command += f"endpoints = {API_ENDPOINTS!r}\n"
            command += dedent("""\
                for suffix, method in endpoints.items():
                    assert ("/v1/" + suffix, method) in routes
                    for prefix in ("/cn/v1", "/intl/v1"):
                        assert (prefix + "/" + suffix, method) not in routes
                """)
            result = subprocess.run([sys.executable, "-B", "-c", command], cwd=directory,
                                    env={"PATH": os.defpath, "PYTHONPATH": directory, "HOME": directory,
                                         "XDG_CONFIG_HOME": directory, "XDG_CACHE_HOME": directory,
                                         "CODEBUDDY_AUTH_DIR": str(Path(directory) / "auth")},
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_compose_loads_dotenv_and_defaults_to_the_latest_image(self):
        text = (ROOT / "docker-compose.yml").read_text()
        self.assertNotRegex(text, r"(?m)^version:")
        self.assertIn("env_file:", text)
        self.assertIn("required: false", text)
        self.assertIn("ghcr.io/azurekiln2333/codebuddy2api:latest", text)
        for name in ("MAX_IMAGES", "IMAGE_POLICY", "MAX_REQUEST_BYTES", "LOG_BODY_LIMIT", "ADMIN_CSRF"):
            self.assertNotIn("${CODEBUDDY2API_" + name, text)
        self.assertNotIn("command:", text)
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn('CMD ["python3", "converter.py", "--host", "0.0.0.0", "--port", "8787", '
                      '"--skip-check", "--desensitize"]', dockerfile)
        for filename in ("README.md", "README.zh-CN.md"):
            doc = (ROOT / filename).read_text()
            self.assertIn("cp .env.example .env", doc)
            self.assertIn("docker compose pull", doc)
            self.assertIn("docker compose up -d --no-build", doc)
            self.assertIn("CODEBUDDY2API_IMAGE", doc)
            self.assertNotIn("docker compose build", doc)
            self.assertNotRegex(doc, r"\bdocker-compose\s")

    def test_readmes_link_guides_and_webui_setup(self):
        for suffix in ("", ".zh-CN"):
            with self.subTest(language=suffix):
                readme = (ROOT / f"README{suffix}.md").read_text()
                # The console entry point is the configured public origin, not a fixed loopback URL.
                self.assertIn("/dashboard", readme)
                self.assertIn("CODEBUDDY2API_KEY", readme)
                for guide in ("webui", "deployment", "clients", "advanced"):
                    target = f"docs/{guide}{suffix}.md"
                    self.assertIn(f"]({target})", readme)
                    self.assertTrue((ROOT / target).is_file(), target)

    def test_docs_keep_original_endpoints_and_sdk_roots_without_region_prefixes(self):
        for suffix in ("", ".zh-CN"):
            with self.subTest(language=suffix):
                readme = (ROOT / f"README{suffix}.md").read_text()
                clients = (ROOT / f"docs/clients{suffix}.md").read_text()
                advanced = (ROOT / f"docs/advanced{suffix}.md").read_text()
                for endpoint, method in API_ENDPOINTS.items():
                    self.assertIn(f"{method} /v1/{endpoint}", advanced)
                self.assertIn("`http://127.0.0.1:8787/v1`", readme)
                self.assertIn('base_url = "http://127.0.0.1:8787/v1"', clients)
                for region in ("cn", "intl"):
                    self.assertNotIn(f"http://127.0.0.1:8787/{region}", readme + clients + advanced)
                    for product in ("cli", "work"):
                        self.assertIn(f"`{region}-{product}`", advanced)
                self.assertIn("ANTHROPIC_BASE_URL=http://127.0.0.1:8787\n", clients)
                self.assertNotIn("ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1", clients)
                for host in ("copilot.tencent.com", "www.workbuddy.cn", "www.codebuddy.ai", "www.workbuddy.ai"):
                    self.assertIn("https://" + host, advanced)
                self.assertIn("default-model", advanced)
                self.assertIn("账号/租户" if suffix else "account/tenant", advanced)

    def test_default_compose_pulls_the_application_image_and_never_builds(self):
        """The default file must stay pull-only so `up` cannot compile a stale checkout."""
        text = (ROOT / "docker-compose.yml").read_text()
        self.assertNotRegex(text, r"(?m)^\s+build:")
        self.assertNotRegex(text, r"(?m)^version:")
        self.assertRegex(text, r"(?m)^ {4}image: \$\{CODEBUDDY2API_IMAGE:-[^}]+\}$")
        self.assertNotIn("maiphucgiang", text)
        self.assertIn("${CODEBUDDY2API_BIND:-127.0.0.1}:${CODEBUDDY2API_PORT:-8787}:8787", text)
        self.assertIn("${CODEBUDDY2API_AUTH_PATH:-./auth}:/data/auth", text)
        self.assertRegex(text, r"(?m)^ {4}init: true$")
        self.assertRegex(text, r"(?m)^ {4}restart: unless-stopped$")
        self.assertRegex(text, r"(?m)^ {8}max-size: 10m$")
        self.assertRegex(text, r"(?m)^ {8}max-file: \"3\"$")

    def test_local_build_override_exists_and_opts_out_of_automatic_updates(self):
        text = (ROOT / "docker-compose.build.yaml").read_text()
        self.assertRegex(text, r"(?m)^ {4}pull_policy: build$")
        self.assertRegex(text, r"(?m)^ {4}build:$")
        self.assertRegex(text, r"(?m)^ {6}context: \.$")
        self.assertRegex(text, r"(?m)^ {6}dockerfile: Dockerfile$")
        # A locally built image changes only by rebuilding, so the updater must not replace it.
        self.assertIn('com.centurylinklabs.watchtower.enable: "false"', text)

    def test_update_service_is_profile_scoped_and_never_updates_itself(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        self.assertIn("profiles: [auto-update]", compose)
        # Maintained fork of the archived project, pinned instead of `latest`.
        self.assertIn("image: nickfedor/watchtower:1.23.2", compose)
        for line in compose.splitlines():
            if line.strip().startswith("image:") and "CODEBUDDY2API_IMAGE" not in line:
                self.assertNotIn("containrrr", line)
                self.assertNotIn(":latest", line)
        for name in ("WATCHTOWER_LABEL_ENABLE", "WATCHTOWER_SCOPE", "WATCHTOWER_POLL_INTERVAL", "WATCHTOWER_CLEANUP"):
            self.assertIn(name + ":", compose)
        # Both services share one per-deployment scope; only the application opts in.
        scope = 'com.centurylinklabs.watchtower.scope: "${COMPOSE_PROJECT_NAME:-codebuddy2api}"'
        self.assertEqual(compose.count(scope), 2)
        self.assertEqual(compose.count('com.centurylinklabs.watchtower.enable: "true"'), 1)
        self.assertEqual(compose.count('com.centurylinklabs.watchtower.enable: "false"'), 1)
        self.assertIn("WATCHTOWER_SCOPE: \"${COMPOSE_PROJECT_NAME:-codebuddy2api}\"", compose)

    def test_image_health_check_probes_health_with_the_standard_library(self):
        text = (ROOT / "Dockerfile").read_text()
        lines = text.splitlines()
        start = next(index for index, line in enumerate(lines) if line.startswith("HEALTHCHECK"))
        probe = " ".join(_continuation_lines(lines, start))
        self.assertIn("/health", probe)
        self.assertIn("urllib.request", probe)
        self.assertIn("--start-period=", probe)
        # The probe must not add a runtime package such as curl.
        self.assertNotIn("curl", text)
        self.assertNotIn("wget", text)

    def test_compose_forwards_the_console_login_contract(self):
        compose = (ROOT / "docker-compose.yml").read_text()
        self.assertIn("CODEBUDDY2API_SSO_ENABLED: ${CODEBUDDY2API_SSO_ENABLED:-true}", compose)
        for name in ("PUBLIC_ORIGIN", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"):
            self.assertIn(name + ": ${" + name + ":-}", compose)
        self.assertIn("OIDC_REFRESH: ${OIDC_REFRESH:-false}", compose)
        self.assertIn("ALLOW_INSECURE_LOCALHOST: ${ALLOW_INSECURE_LOCALHOST:-false}", compose)
        example = (ROOT / ".env.example").read_text()
        for name in ("CODEBUDDY2API_SSO_ENABLED", "PUBLIC_ORIGIN", "OIDC_ISSUER", "OIDC_CLIENT_ID",
                     "OIDC_CLIENT_SECRET", "OIDC_REFRESH", "ALLOW_INSECURE_LOCALHOST",
                     "WATCHTOWER_POLL_INTERVAL"):
            self.assertRegex(example, rf"(?m)^#? ?{name}=")

    def test_deployment_docs_cover_pull_update_disable_and_rollback(self):
        for suffix in ("", ".zh-CN"):
            with self.subTest(language=suffix):
                doc = (ROOT / f"docs/deployment{suffix}.md").read_text()
                self.assertIn("docker compose pull", doc)
                self.assertIn("docker compose up -d --no-build", doc)
                self.assertIn("docker-compose.build.yaml", doc)
                self.assertIn("--profile auto-update", doc)
                self.assertIn("WATCHTOWER_POLL_INTERVAL", doc)
                self.assertIn("docker login", doc)
                self.assertIn("CODEBUDDY2API_IMAGE", doc)
                self.assertIn("CODEBUDDY2API_SSO_ENABLED", doc)
                self.assertIn("OIDC_CLIENT_SECRET", doc)
                self.assertIn("PUBLIC_ORIGIN", doc)
                # A downgrade is only documented safely with a matching data backup.
                self.assertIn("auth/", doc)
                self.assertNotIn("maiphucgiang", doc)

    def test_reverse_proxy_example_keeps_streaming_and_hides_callback_query(self):
        # Lives beside the deployment guide so the release archive ships it with the docs.
        text = (ROOT / "docs" / "nginx.example.conf").read_text()
        self.assertIn("proxy_buffering off", text)
        self.assertIn("X-Accel-Buffering", text)
        self.assertIn("$request_method $uri", text)
        # The sign-in callback carries one-time codes: no logging directive may
        # include the query string (only the HTTP-to-HTTPS redirect keeps it).
        loggable = [line for line in text.splitlines() if "return 301" not in line]
        joined = "\n".join(loggable)
        self.assertNotIn("$request_uri", joined)
        self.assertNotIn("$args", joined)

    def test_documentation_local_links_resolve(self):
        paths = [ROOT / "README.md", ROOT / "README.zh-CN.md", *sorted((ROOT / "docs").glob("*.md"))]
        for path in paths:
            for target in re.findall(r"\[[^\]]+\]\(([^\s)]+)\)", path.read_text()):
                if "://" in target or target.startswith(("mailto:", "#")):
                    continue
                linked = (path.parent / target.split("#", 1)[0]).resolve()
                with self.subTest(document=path.relative_to(ROOT), target=target):
                    self.assertTrue(linked.is_relative_to(ROOT), target)
                    self.assertTrue(linked.is_file(), target)


if __name__ == "__main__":
    unittest.main(verbosity=2)
