"""Contract tests for the shared release tag resolver used by both platforms."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

import shlex
import unittest

from scripts import release_tags

SHA = "0123456789abcdef0123456789abcdef01234567"
SHORT = SHA[:12]


def cnb_env(**overrides):
    env = {
        "CNB_DOCKER_REGISTRY": "docker.cnb.cool",
        "CNB_REPO_SLUG_LOWERCASE": "team/codebuddy2api",
        "CNB_COMMIT": SHA,
        "CNB_BRANCH": "v1.2.3",
        "CNB_IS_TAG": "true",
    }
    env.update(overrides)
    return env


class ReleaseTagTests(unittest.TestCase):
    def test_cnb_custom_registry_uses_the_configured_login_user(self):
        contract = release_tags.resolve(
            "cnb",
            version="1.2.3",
            environ=cnb_env(
                CNB_IMAGE="registry.example.com/team/codebuddy2api",
                CNB_REGISTRY_USER="robot-codebuddy",
            ),
        )
        self.assertEqual(contract["registry_user"], "robot-codebuddy")
        self.assertEqual(contract["registry"], "registry.example.com")

    def test_stable_tag_set_matches_on_every_alias(self):
        self.assertEqual(
            release_tags.resolve_tags("1.2.3", "refs/tags/v1.2.3", SHA),
            ["v1.2.3", "1.2.3", "1.2", "1", f"sha-{SHORT}", "latest"],
        )

    def test_prerelease_never_moves_stable_aliases(self):
        tags = release_tags.resolve_tags("1.4.0-rc.1", "refs/tags/v1.4.0-rc.1", SHA)
        self.assertEqual(tags, ["v1.4.0-rc.1", f"sha-{SHORT}"])
        for alias in ("latest", "1.4", "1", "1.4.0"):
            self.assertNotIn(alias, tags)

    def test_main_branch_publishes_edge(self):
        self.assertEqual(
            release_tags.resolve_tags("1.2.3", "refs/heads/main", SHA),
            ["edge", f"sha-{SHORT}"],
        )

    def test_main_prefix_branches_do_not_move_edge(self):
        # `startswith("refs/heads/main")` used to leak `edge` onto these branches.
        for ref in ("refs/heads/main-fix", "refs/heads/maintenance", "refs/heads/mainline"):
            with self.subTest(ref=ref):
                tags = release_tags.resolve_tags("1.2.3", ref, SHA)
                self.assertEqual(tags, [f"sha-{SHORT}"])
                self.assertNotIn("edge", tags)

    def test_pull_request_builds_without_publishing_aliases(self):
        tags = release_tags.resolve_tags("1.2.3", "refs/pull/5/merge", SHA)
        self.assertEqual(tags, [f"sha-{SHORT}"])
        for alias in ("latest", "edge", "v1.2.3"):
            self.assertNotIn(alias, tags)

    def test_short_sha_is_twelve_characters(self):
        tags = release_tags.resolve_tags("1.2.3", "refs/tags/v1.2.3", SHA)
        self.assertEqual([tag for tag in tags if tag.startswith("sha-")], [f"sha-{SHORT}"])
        self.assertEqual(len(SHORT), 12)

    def test_github_image_is_lowercased_current_repository(self):
        image, registry = release_tags.resolve_image(
            "github", {"GITHUB_REPOSITORY": "SomeOwner/CodeBuddy2Api"}
        )
        self.assertEqual(image, "ghcr.io/someowner/codebuddy2api")
        self.assertEqual(registry, "ghcr.io")

    def test_cnb_image_derives_from_platform_variables(self):
        image, registry = release_tags.resolve_image(
            "cnb",
            {"CNB_DOCKER_REGISTRY": "docker.cnb.cool",
             "CNB_REPO_SLUG_LOWERCASE": "team/codebuddy2api"},
        )
        self.assertEqual(image, "docker.cnb.cool/team/codebuddy2api")
        self.assertEqual(registry, "docker.cnb.cool")

    def test_explicit_image_override_is_honoured(self):
        image, registry = release_tags.resolve_image(
            "cnb",
            {"CNB_DOCKER_REGISTRY": "docker.cnb.cool",
             "CNB_REPO_SLUG_LOWERCASE": "team/codebuddy2api",
             "RELEASE_IMAGE": "registry.example.com/self-hosted/codebuddy2api/" },
        )
        self.assertEqual(image, "registry.example.com/self-hosted/codebuddy2api")
        self.assertEqual(registry, "registry.example.com")
        self.assertEqual(
            release_tags.resolve_image("cnb", {"CNB_IMAGE": "harbor.local/app"})[0],
            "harbor.local/app",
        )

    def test_missing_platform_variables_are_rejected(self):
        with self.assertRaises(ValueError):
            release_tags.resolve_image("github", {})
        with self.assertRaises(ValueError):
            release_tags.resolve_image("cnb", {})

    def test_contract_refs_are_registry_qualified(self):
        contract = release_tags.resolve(
            "cnb",
            ref="refs/tags/v1.2.3",
            version="1.2.3",
            sha=SHA,
            environ=cnb_env(),
        )
        self.assertEqual(contract["image"], "docker.cnb.cool/team/codebuddy2api")
        self.assertEqual(contract["primary_tag"], "v1.2.3")
        self.assertFalse(contract["prerelease"])
        self.assertEqual(len(contract["refs"]), len(contract["tags"]))
        for ref, tag in zip(contract["refs"], contract["tags"]):
            self.assertEqual(ref, f"docker.cnb.cool/team/codebuddy2api:{tag}")
        self.assertEqual(contract["refs"][-1], "docker.cnb.cool/team/codebuddy2api:latest")

    def test_override_flows_through_published_refs(self):
        contract = release_tags.resolve(
            "cnb",
            ref="refs/tags/v1.2.3",
            version="1.2.3",
            sha=SHA,
            environ=cnb_env(RELEASE_IMAGE="registry.example.com/team/app"),
        )
        self.assertTrue(all(ref.startswith("registry.example.com/team/app:") for ref in contract["refs"]))

    def test_tag_ref_must_match_version(self):
        with self.assertRaises(ValueError):
            release_tags.resolve(
                "github",
                ref="refs/tags/v9.9.9",
                version="1.2.3",
                sha=SHA,
                environ={"GITHUB_REPOSITORY": "owner/repo"},
            )

    def test_prerelease_flag_and_aliases(self):
        contract = release_tags.resolve(
            "cnb",
            ref="refs/tags/v1.4.0-rc.1",
            version="1.4.0-rc.1",
            sha=SHA,
            environ=cnb_env(CNB_BRANCH="v1.4.0-rc.1"),
        )
        self.assertTrue(contract["prerelease"])
        self.assertEqual(contract["primary_tag"], "v1.4.0-rc.1")
        self.assertNotIn("latest", contract["tags"])

    def test_shell_emit_is_eval_safe(self):
        contract = release_tags.resolve(
            "cnb",
            ref="refs/tags/v1.2.3",
            version="1.2.3",
            sha=SHA,
            environ=cnb_env(),
        )
        rendered = release_tags.format_shell(contract)
        namespace = {}
        for line in rendered.splitlines():
            key, _, raw = line.partition("=")
            self.assertTrue(key.isupper(), key)
            tokens = shlex.split(raw)
            self.assertEqual(len(tokens), 1, line)
            namespace[key] = tokens[0]
        self.assertEqual(namespace["IMAGE"], "docker.cnb.cool/team/codebuddy2api")
        refs = namespace["REFS"].split()
        self.assertTrue(refs[-1].endswith(":latest"), refs)

    def test_github_emit_uses_multiline_marker(self):
        contract = release_tags.resolve(
            "github",
            ref="refs/tags/v1.2.3",
            version="1.2.3",
            sha=SHA,
            environ={"GITHUB_REPOSITORY": "Owner/Repo"},
        )
        rendered = release_tags.format_github(contract)
        self.assertIn("refs<<RELEASE_REFS_EOF", rendered)
        self.assertIn("RELEASE_REFS_EOF", rendered)
        self.assertIn("image=ghcr.io/owner/repo", rendered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
