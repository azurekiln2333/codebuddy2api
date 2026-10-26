"""Contract tests for the GitHub Actions and CNB release pipelines.

These assertions encode the delivery rules as executable checks instead of
documentation promises: validation precedes publication, pull requests never
publish, stable tags alone move ``latest``, both platforms share one resolver,
and CNB's Release is idempotent (``overlying``) with attachments.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import json
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
GITHUB_WORKFLOW = ROOT / ".github/workflows/docker.yml"
CNB = ROOT / ".cnb.yml"
SCRIPTS = ROOT / "scripts"


def load(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def github():
    data = load(GITHUB_WORKFLOW)
    triggers = data.get("on")
    if triggers is None:
        triggers = data.get(True)
    return data, triggers or {}


def cnb():
    return load(CNB)


def stage_text(stage):
    chunks = []
    for key in ("name", "script", "type", "optionsFrom", "image"):
        value = stage.get(key)
        if isinstance(value, str):
            chunks.append(value)
    for job in stage.get("jobs") or []:
        chunks.append(json.dumps(job))
    return "\n".join(chunks)


def stage_names(pipeline):
    return [stage.get("name", "") for stage in pipeline.get("stages") or []]


def pipeline_text(pipeline):
    return "\n".join(stage_text(stage) for stage in pipeline.get("stages") or [])


def find_step(job, *, uses_prefix="", run_contains=""):
    for step in job.get("steps") or []:
        uses = step.get("uses", "")
        run = step.get("run", "")
        if uses_prefix and str(uses).startswith(uses_prefix):
            return step
        if run_contains and run_contains in str(run):
            return step
    raise AssertionError(f"step not found in job {job.get('name', '?')}: {uses_prefix or run_contains}")


class GitHubPipelineTests(unittest.TestCase):
    def test_top_level_permission_is_read_only(self):
        data, _ = github()
        self.assertEqual(data["permissions"], {"contents": "read"})

    def test_release_runs_only_for_pushed_version_tags(self):
        data, _ = github()
        release = data["jobs"]["release"]
        self.assertIn("github.event_name == 'push'", release["if"])
        self.assertIn("refs/tags/", release["if"])
        self.assertEqual(release["permissions"], {"contents": "write"})
        self.assertIn("package", release["needs"])
        self.assertIn("test", release["needs"])

    def test_release_is_idempotent_and_verifies_checksum(self):
        data, _ = github()
        publish = find_step(data["jobs"]["release"], run_contains="gh release")
        script = publish["run"]
        self.assertIn("sha256sum --check", script)
        self.assertIn("gh release view", script)
        self.assertIn("--clobber", script)
        self.assertIn("--verify-tag", script)
        self.assertIn("--prerelease", script)

    def test_pull_requests_never_log_in_or_push_images(self):
        data, _ = github()
        image = data["jobs"]["image"]
        login = find_step(image, uses_prefix="docker/login-action")
        self.assertIn("pull_request", login["if"])
        build = find_step(image, uses_prefix="docker/build-push-action")
        self.assertIn("pull_request", build["with"]["push"])
        self.assertIn("refs/tags/v", build["with"]["push"])

    def test_image_publication_is_gated_on_validation(self):
        data, _ = github()
        needs = data["jobs"]["image"]["needs"]
        for required in ("test", "web", "package"):
            self.assertIn(required, needs)

    def test_release_is_published_only_after_the_image_succeeds(self):
        # A tag whose image build failed must never be recorded as a successful
        # Release, so the release job depends on the image job.
        data, _ = github()
        release = data["jobs"]["release"]
        for required in ("test", "package", "image"):
            with self.subTest(required=required):
                self.assertIn(required, release["needs"])
        # `image` must stay unskippable: a skip propagates through `needs` and
        # would silently skip the release for tags too.
        self.assertNotIn("if", data["jobs"]["image"])
        build = find_step(data["jobs"]["image"], uses_prefix="docker/build-push-action")
        self.assertIn("refs/tags/v", build["with"]["push"])

    def test_image_preserves_both_architectures(self):
        data, _ = github()
        build = find_step(data["jobs"]["image"], uses_prefix="docker/build-push-action")
        self.assertIn("linux/amd64", build["with"]["platforms"])
        self.assertIn("linux/arm64", build["with"]["platforms"])

    def test_shared_resolver_owns_the_tag_set(self):
        data, _ = github()
        image = data["jobs"]["image"]
        resolve = find_step(image, run_contains="release_tags.py")
        self.assertIn("--platform github", resolve["run"])
        build = find_step(image, uses_prefix="docker/build-push-action")
        self.assertEqual(build["with"]["tags"], "${{ steps.release.outputs.refs }}")
        text = GITHUB_WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("flavor: latest=auto", text)
        self.assertNotIn("type=semver", text)

    def test_shared_scripts_own_validation_and_packaging(self):
        data, _ = github()
        self.assertIn("scripts/check_version.py", GITHUB_WORKFLOW.read_text(encoding="utf-8"))
        test_step = find_step(data["jobs"]["test"], run_contains="run_backend_tests.py")
        self.assertIn("scripts/run_backend_tests.py", test_step["run"])
        package_step = find_step(data["jobs"]["package"], run_contains="scripts/package.py")
        self.assertIn("python scripts/package.py", package_step["run"])
        verify_step = find_step(data["jobs"]["package"], run_contains="--verify")
        self.assertIn("--verify", verify_step["run"])

    def test_concurrency_does_not_cancel_tag_releases(self):
        data, _ = github()
        concurrency = data["concurrency"]
        self.assertIn("github.ref", concurrency["group"])
        self.assertIn("pull_request", str(concurrency["cancel-in-progress"]))

    def test_package_runs_after_validation(self):
        data, _ = github()
        self.assertEqual(sorted(data["jobs"]["package"]["needs"]), ["test", "web"])

    def test_github_main_push_can_publish_edge(self):
        # The resolver emits `edge` for `refs/heads/main`; GitHub publishes it on
        # main pushes. CNB deliberately does not (see the CNB branch test).
        data, _ = github()
        image = data["jobs"]["image"]
        build = find_step(image, uses_prefix="docker/build-push-action")
        self.assertIn("refs/heads/main", build["with"]["push"])
        resolve = find_step(image, run_contains="release_tags.py")
        self.assertIn("--platform github", resolve["run"])

    def test_browser_gate_runs_native_suite_unconditionally(self):
        data, _ = github()
        browser = find_step(data["jobs"]["web"], run_contains="playwright.native.config.ts")
        script = browser["run"]
        # The isolated suite always runs and the native SSO suite is a hard gate.
        self.assertIn("vp exec playwright test\n", script)
        self.assertIn("vp exec playwright test -c playwright.native.config.ts", script)
        # No silent skip: the SSO integration gate must always run.
        self.assertNotIn("if [ -f", script)
        self.assertNotIn("playwright.integration.config.ts", GITHUB_WORKFLOW.read_text(encoding="utf-8"))


class CnbPipelineTests(unittest.TestCase):
    def test_defines_branch_and_tag_pipelines(self):
        data = cnb()
        self.assertIn("main", data)
        self.assertIn("v*", data)
        self.assertIn("tag_push", data["v*"])
        self.assertEqual(len(data["v*"]["tag_push"]), 1, "exactly one gated tag pipeline")
        self.assertIn("pull_request", data["main"])

    def test_pull_request_reuses_the_same_gates(self):
        data = cnb()
        self.assertEqual(data["main"]["pull_request"], data["main"]["push"])

    def test_tag_pipeline_validates_before_publishing(self):
        data = cnb()
        names = stage_names(data["v*"]["tag_push"][0])
        for required in ("check-version", "backend-tests", "web-gates", "build-release-package"):
            self.assertIn(required, names)
        self.assertLess(names.index("build-release-package"), names.index("publish-image"))

    def test_image_publish_precedes_any_release_stage(self):
        # Failure ordering: the image is pushed before a Release exists, so the
        # common failure (registry login / docker build) cannot leave a Recorded
        # release behind. Assets still follow creation, because `git:release`
        # cannot carry attachments (verified schema, see the options test).
        data = cnb()
        names = stage_names(data["v*"]["tag_push"][0])
        image = names.index("publish-image")
        for release_stage in ("create-release", "upload-release-assets"):
            with self.subTest(release_stage=release_stage):
                self.assertLess(image, names.index(release_stage))
        self.assertLess(names.index("create-release"), names.index("upload-release-assets"))

    def test_release_uses_overlying_options_and_attachments(self):
        data = cnb()
        pipeline = data["v*"]["tag_push"][0]
        stages = {stage.get("name"): stage for stage in pipeline["stages"]}
        create = stages["create-release"]
        self.assertEqual(create["type"], "git:release")
        self.assertEqual(create["optionsFrom"], "dist/cnb-release-options.json")
        upload = stages["upload-release-assets"]
        attachments = " ".join(upload["settings"]["attachments"])
        self.assertIn("dist/$RELEASE_ARCHIVE", attachments)
        self.assertIn(".sha256", attachments)

    def test_manifest_is_exported_for_release_and_upload(self):
        data = cnb()
        pipeline = data["v*"]["tag_push"][0]
        readers = [stage for stage in pipeline["stages"] if stage.get("type") == "cnb:read-file"]
        self.assertTrue(readers, "tag pipeline must read the build manifest")
        self.assertEqual(readers[0]["options"]["filePath"], "dist/build-manifest.json")
        self.assertEqual(readers[0]["exports"], {"archive": "RELEASE_ARCHIVE"})

    def test_shared_scripts_drive_every_gate(self):
        data = cnb()
        text = pipeline_text(data["v*"]["tag_push"][0])
        for script in (
            "scripts/check_version.py",
            "scripts/run_backend_tests.py",
            "scripts/package.py",
            "scripts/release_tags.py",
        ):
            with self.subTest(script=script):
                self.assertIn(script, text)

    def test_branch_pipelines_never_publish(self):
        # Covers `main` push, `api_trigger` and `pull_request`: validate + package
        # only. The floating main-branch image tag (`edge`) is GitHub-only, so the
        # CNB side must never even resolve tags or log in.
        data = cnb()
        text = pipeline_text(data["main"]["push"][0])
        for forbidden in ("git:release", "docker login", "cnbcool/attachments", "--push", "release_tags.py"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_image_publish_uses_derived_registry_and_platforms(self):
        data = cnb()
        pipeline = data["v*"]["tag_push"][0]
        stages = {stage.get("name"): stage for stage in pipeline["stages"]}
        script = stages["publish-image"]["script"]
        self.assertIn("release_tags.py --platform cnb", script)
        self.assertIn("CNB_PLATFORMS", script)
        # No hard-coded owner/repository path.
        self.assertNotIn("ghcr.io/", script)
        # The tag pipeline needs the docker service for buildx.
        self.assertIn("docker", data["v*"]["tag_push"][0]["services"])

    def test_web_gate_runs_native_suite_unconditionally(self):
        data = cnb()
        text = pipeline_text(data["v*"]["tag_push"][0])
        self.assertIn("vp exec playwright test -c playwright.native.config.ts", text)
        # No silent skip: the SSO integration gate must always run.
        self.assertNotIn("if [ -f playwright.native.config.ts", text)
        self.assertNotIn("playwright.integration.config.ts", CNB.read_text(encoding="utf-8"))
        # The native suite needs the dependency-bearing interpreter by absolute path.
        self.assertIn('venv="$repo_root/.venv-ci"', text)
        self.assertIn('export WEBUI_PYTHON="$venv/bin/python"', text)


class SharedContractTests(unittest.TestCase):
    def test_no_hardcoded_upstream_repository_in_release_tooling(self):
        paths = [GITHUB_WORKFLOW, CNB, *sorted(SCRIPTS.glob("*.py"))]
        for path in paths:
            with self.subTest(path=path.name):
                self.assertNotIn("maiphucgiang", path.read_text(encoding="utf-8"))

    def test_registry_paths_come_from_platform_variables(self):
        text = CNB.read_text(encoding="utf-8")
        self.assertIn("CNB_REPO_SLUG_LOWERCASE", text)
        self.assertIn("CNB_DOCKER_REGISTRY", text)
        self.assertIn("RELEASE_IMAGE", text)

    def test_ci_never_invokes_the_external_integration_suite(self):
        # `playwright.integration.config.ts` throws when AZUREKILN_INTEGRATION_URL
        # is unset, so it must stay a manual suite only.
        for path in (GITHUB_WORKFLOW, CNB):
            with self.subTest(path=path.name):
                self.assertNotIn("playwright.integration.config.ts", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)