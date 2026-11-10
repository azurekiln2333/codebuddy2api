"""Console-managed authentication settings, persisted in the control database.

Both login methods — the panel key and OIDC single sign-on — are configured from
the console and stored here, so a deployment never has to put OIDC values in the
environment. The legacy ``CODEBUDDY2API_SSO_*``/``OIDC_*``/``PUBLIC_ORIGIN``
variables survive as a one-time seed for an unconfigured store; saved settings
always win afterwards.

Admission is an explicit allow-list: a subject listed in ``allowedSubjects``, or
an e-mail listed in ``allowedEmails`` that the provider marked as verified. The
retired ``role=admin``/``isAdmin`` rule is deliberately gone, because a role
claim is not an operator decision this service can audit.

Example
-------
>>> values = with_defaults({"allowedSubjects": ["ops"]})
>>> values["keyLoginEnabled"]
True
"""
from __future__ import annotations

import hashlib
import json
import threading
import re
from typing import Any, Mapping
from urllib.parse import urlsplit

STORE_NAME = "sso_settings"
DOCUMENT_VERSION = 1

DEFAULT_SCOPE = "openid profile email"
MAX_SUBJECTS = 200
MAX_EMAILS = 200
_MAX_EMAIL_LENGTH = 320
_MAX_SUBJECT_LENGTH = 200
_MAX_SECRET_LENGTH = 4096
_MAX_ISSUER_LENGTH = 2048

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\Z")
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}

DEFAULT_SSO = {
    "enabled": False,
    "keyLoginEnabled": True,
    "issuer": "",
    "clientId": "",
    "clientSecret": "",
    "scope": DEFAULT_SCOPE,
    "providerName": "",
    "allowedSubjects": [],
    "allowedEmails": [],
    "callbackUrl": "",
}

# Fields that change who may sign in. A settings change that leaves this
# fingerprint identical keeps existing sessions usable.
IDENTITY_FIELDS = ("issuer", "clientId", "scope", "allowedSubjects", "allowedEmails")


class AuthSettingsError(ValueError):
    """A console authentication setting is invalid or unsafe."""


def _printable(value: str) -> bool:
    return not any(ord(ch) < 32 or ord(ch) == 0x7F for ch in value)


def _strings(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise AuthSettingsError(f"{label}须为字符串数组")
    return [item for item in value if isinstance(item, str)]


def with_defaults(value: Any) -> dict[str, Any]:
    """Normalize a stored or partial document into a complete settings dict."""
    source = value if isinstance(value, dict) else {}
    subjects = _strings(source.get("allowedSubjects"), "管理员 subject 白名单")
    emails = _strings(source.get("allowedEmails"), "管理员邮箱白名单")
    return {
        "enabled": source.get("enabled") is True,
        "keyLoginEnabled": source.get("keyLoginEnabled") is not False,
        "issuer": source["issuer"] if isinstance(source.get("issuer"), str) else "",
        "clientId": source["clientId"] if isinstance(source.get("clientId"), str) else "",
        "clientSecret": source["clientSecret"] if isinstance(source.get("clientSecret"), str) else "",
        "scope": source["scope"].strip()
        if isinstance(source.get("scope"), str) and source["scope"].strip()
        else DEFAULT_SCOPE,
        "providerName": source["providerName"] if isinstance(source.get("providerName"), str) else "",
        "allowedSubjects": subjects,
        "allowedEmails": emails,
        "callbackUrl": source["callbackUrl"] if isinstance(source.get("callbackUrl"), str) else "",
    }


def is_loopback(host: str) -> bool:
    lowered = host.lower()
    return lowered in _LOOPBACK_HOSTS or lowered.endswith(".localhost")


def _normalize_issuer(value: Any, allow_local: bool) -> str:
    """Validate an OIDC issuer: HTTPS, or HTTP only for an explicit loopback mock."""
    if not isinstance(value, str):
        raise AuthSettingsError("SSO 颁发者须为字符串")
    text = value.strip()
    if not text:
        return ""
    if len(text) > _MAX_ISSUER_LENGTH or not _printable(text):
        raise AuthSettingsError("SSO 颁发者长度或字符无效")
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise AuthSettingsError("SSO 颁发者不是合法 URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise AuthSettingsError("SSO 颁发者必须是不含查询或片段的 http(s) 地址")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise AuthSettingsError("SSO 颁发者不得包含凭据、查询或片段")
    if port is not None and not 1 <= port <= 65535:
        raise AuthSettingsError("SSO 颁发者端口无效")
    if parts.scheme != "https" and not (allow_local and is_loopback(parts.hostname)):
        raise AuthSettingsError("SSO 颁发者必须使用 HTTPS（仅显式回环开发可放宽）")
    return text.rstrip("/")


def _normalize_callback(value: Any, allow_local: bool) -> str:
    if not isinstance(value, str):
        raise AuthSettingsError("回调地址须为字符串")
    text = value.strip()
    if not text:
        return ""
    if len(text) > _MAX_ISSUER_LENGTH or not _printable(text):
        raise AuthSettingsError("回调地址长度或字符无效")
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise AuthSettingsError("回调地址不是合法 URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise AuthSettingsError("回调地址必须是完整的 http(s) 地址")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise AuthSettingsError("回调地址不得包含凭据、查询或片段")
    if port is not None and not 1 <= port <= 65535:
        raise AuthSettingsError("回调地址端口无效")
    if parts.scheme != "https" and not (allow_local and is_loopback(parts.hostname)):
        raise AuthSettingsError("回调地址必须使用 HTTPS（仅显式回环开发可放宽）")
    return text.rstrip("/")


def _normalize_scope(value: Any) -> str:
    if not isinstance(value, str):
        raise AuthSettingsError("SSO scope 须为字符串")
    text = " ".join(value.split())
    if not _printable(text) or len(text) > 512:
        raise AuthSettingsError("SSO scope 含无效字符或过长")
    scopes = text.split()
    if "openid" not in scopes:
        raise AuthSettingsError("SSO scope 必须包含 openid")
    return text


def _entries(value: Any, *, label: str, limit: int, max_length: int, lower: bool) -> list[str]:
    items = _strings(value, label)
    result: list[str] = []
    for entry in items:
        text = entry.strip()
        if not text:
            continue
        if len(text) > max_length or not _printable(text):
            raise AuthSettingsError(f"{label}中存在无效条目")
        normalized = text.lower() if lower else text
        if normalized not in result:
            result.append(normalized)
    if len(result) > limit:
        raise AuthSettingsError(f"{label}最多 {limit} 条")
    return result


def _assert_policy(settings: Mapping[str, Any]) -> None:
    """Enabling SSO needs real provider values and an explicit allow-list."""
    if settings["enabled"]:
        if not settings["issuer"]:
            raise AuthSettingsError("启用 SSO 需要填写颁发者地址")
        if not settings["clientId"]:
            raise AuthSettingsError("启用 SSO 需要填写客户端 ID")
        if not settings["clientSecret"]:
            raise AuthSettingsError("启用 SSO 需要填写客户端密钥")
        if not settings["allowedSubjects"] and not settings["allowedEmails"]:
            raise AuthSettingsError("启用 SSO 需要至少一个管理员 subject 或已验证邮箱白名单")
    if not settings["keyLoginEnabled"] and not settings["enabled"]:
        raise AuthSettingsError("关闭面板密钥登录前请先启用有效的 SSO")


def validate(patch: Any, previous: Mapping[str, Any] | None = None, *,
             allow_local: bool = False) -> dict[str, Any]:
    """Merge a console patch onto ``previous`` and return the validated result."""
    if patch is None or not isinstance(patch, dict):
        raise AuthSettingsError("请填写认证配置")
    settings = with_defaults(previous if previous is not None else DEFAULT_SSO)

    # The console contract names the switch ``ssoEnabled`` for reads and writes,
    # as cnb2api-panel and zcode2api do; ``enabled`` is the stored name and stays
    # accepted. Ignoring ``ssoEnabled`` would save the provider but silently
    # leave SSO off.
    if "ssoEnabled" in patch:
        patch = {**patch, "enabled": patch["ssoEnabled"]}
    for flag in ("enabled", "keyLoginEnabled"):
        if flag in patch:
            if type(patch[flag]) is not bool:
                raise AuthSettingsError("SSO 启用状态须为布尔值")
            settings[flag] = patch[flag]
    if "issuer" in patch:
        settings["issuer"] = _normalize_issuer(patch["issuer"], allow_local)
    if "clientId" in patch:
        value = patch["clientId"]
        if not isinstance(value, str) or len(value) > 200 or not _printable(value.strip()):
            raise AuthSettingsError("SSO 客户端 ID 格式不正确")
        settings["clientId"] = value.strip()
    # A blank secret keeps the stored one: the console never receives it back.
    if "clientSecret" in patch:
        value = patch["clientSecret"]
        if not isinstance(value, str) or len(value) > _MAX_SECRET_LENGTH:
            raise AuthSettingsError("SSO 客户端密钥格式不正确")
        secret = value.strip()
        if secret and not _printable(secret):
            raise AuthSettingsError("SSO 客户端密钥含有无效字符")
        if secret:
            settings["clientSecret"] = secret
    if "scope" in patch:
        settings["scope"] = _normalize_scope(patch["scope"])
    if "providerName" in patch:
        value = patch["providerName"]
        if not isinstance(value, str) or len(value) > 60 or not _printable(value.strip()):
            raise AuthSettingsError("SSO 名称格式不正确")
        settings["providerName"] = value.strip()
    if "allowedSubjects" in patch:
        settings["allowedSubjects"] = _entries(
            patch["allowedSubjects"], label="管理员 subject 白名单",
            limit=MAX_SUBJECTS, max_length=_MAX_SUBJECT_LENGTH, lower=False)
    if "allowedEmails" in patch:
        settings["allowedEmails"] = _entries(
            patch["allowedEmails"], label="管理员邮箱白名单",
            limit=MAX_EMAILS, max_length=_MAX_EMAIL_LENGTH, lower=True)
    if any(_EMAIL.fullmatch(email) is None for email in settings["allowedEmails"]):
        raise AuthSettingsError("管理员邮箱白名单中存在无效邮箱")
    if "callbackUrl" in patch:
        settings["callbackUrl"] = _normalize_callback(patch["callbackUrl"], allow_local)
    _assert_policy(settings)
    return settings


def sanitize(settings: Mapping[str, Any], callback_url: str = "") -> dict[str, Any]:
    """Public console shape: the client secret is replaced by a presence flag."""
    values = with_defaults(settings)
    return {
        "ssoEnabled": values["enabled"],
        "keyLoginEnabled": values["keyLoginEnabled"],
        "issuer": values["issuer"],
        "clientId": values["clientId"],
        "hasClientSecret": bool(values["clientSecret"]),
        "scope": values["scope"],
        "providerName": values["providerName"],
        "allowedSubjects": list(values["allowedSubjects"]),
        "allowedEmails": list(values["allowedEmails"]),
        "callbackUrl": callback_url or values["callbackUrl"],
    }


def is_configured(value: Any) -> bool:
    """Any non-default field means the operator configured this console."""
    current = with_defaults(value)
    return any(current[key] != DEFAULT_SSO[key] for key in DEFAULT_SSO)


def fingerprint(settings: Mapping[str, Any]) -> str:
    """Digest of the fields that decide who may sign in."""
    values = with_defaults(settings)
    document = json.dumps([values[key] for key in IDENTITY_FIELDS],
                          ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(document.encode("utf-8")).hexdigest()


def admits(settings: Mapping[str, Any], *, subject: str, email: str,
           email_verified: bool) -> bool:
    """The D2 admission rule: allow-listed subject, or a verified allow-listed e-mail."""
    values = with_defaults(settings)
    if subject and subject in values["allowedSubjects"]:
        return True
    if not email or not email_verified:
        return False
    return email.lower() in values["allowedEmails"]


# --------------------------------------------------------------------- storage


def _decode(raw: str) -> dict[str, Any]:
    document = json.loads(raw)
    if (not isinstance(document, dict) or set(document) != {"version", "settings"}
            or type(document["version"]) is not int or document["version"] != DOCUMENT_VERSION):
        raise AuthSettingsError("认证配置数据无效")
    return with_defaults(document["settings"])


def load(control) -> dict[str, Any] | None:
    """Read the saved settings, or ``None`` when the console has never saved any."""
    if control is None:
        return None
    with control._lock:
        row = control._db.execute(
            "SELECT value FROM gateway_secrets WHERE name=?", (STORE_NAME,)).fetchone()
    if row is None:
        return None
    try:
        return _decode(row[0])
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        if isinstance(error, AuthSettingsError):
            raise
        raise AuthSettingsError("认证配置数据无效") from None


def save(control, settings: Mapping[str, Any]) -> None:
    if control is None:
        raise AuthSettingsError("控制库不可用，认证配置未保存")
    values = with_defaults(settings)
    document = json.dumps({"version": DOCUMENT_VERSION, "settings": values},
                          ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    with control._lock:
        control._db.execute(
            "INSERT INTO gateway_secrets(name,value,announced) VALUES(?,?,1) "
            "ON CONFLICT(name) DO UPDATE SET value=excluded.value, announced=1",
            (STORE_NAME, document))


class SettingsStore:
    """Live holder shared by the middleware, the routes and the SSO service.

    Reads are lock-free dict copies and writes are validate-then-persist, so a
    console ``PATCH`` becomes visible to the next request without a restart.
    """

    def __init__(self, values: Mapping[str, Any] | None = None, *, control=None,
                 allow_local: bool = False):
        self._control = control
        self.allow_local = allow_local
        self._values = with_defaults(values if values is not None else DEFAULT_SSO)
        # ``update`` is read-modify-write: validate against the current document,
        # persist, then publish. FastAPI runs sync handlers in a threadpool, so two
        # concurrent PATCHes could otherwise persist one document and publish the
        # other, leaving memory and disk disagreeing until the next restart.
        self._lock = threading.Lock()

    def current(self) -> dict[str, Any]:
        return with_defaults(self._values)

    def fingerprint(self) -> str:
        return fingerprint(self._values)

    def update(self, patch: Mapping[str, Any]) -> dict[str, Any]:
        """Validate, persist, then publish; a failed write leaves the old value."""
        with self._lock:
            candidate = validate(patch, self._values, allow_local=self.allow_local)
            if self._control is not None:
                save(self._control, candidate)
            self._values = candidate
            return with_defaults(candidate)

    def replace(self, values: Mapping[str, Any]) -> None:
        """Install an already-validated document (used by the env seed)."""
        with self._lock:
            self._values = with_defaults(values)


def seed_from_env(environ: Mapping[str, str]) -> dict[str, Any]:
    """Translate the legacy OIDC variables into a settings document.

    Returns ``{}`` when the deployment never configured SSO through the
    environment, so an unrelated stray variable cannot change behaviour.
    """
    def flag(name: str) -> bool:
        raw = environ.get(name, "")
        text = raw.strip().lower() if isinstance(raw, str) else ""
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        if text:
            raise AuthSettingsError(f"{name} 必须为 true 或 false")
        return False

    enabled = flag("CODEBUDDY2API_SSO_ENABLED")
    issuer = (environ.get("OIDC_ISSUER") or "").strip()
    client_id = (environ.get("OIDC_CLIENT_ID") or "").strip()
    client_secret = environ.get("OIDC_CLIENT_SECRET") or ""
    subjects = _split_list(environ.get("CODEBUDDY2API_SSO_ALLOWED_SUBJECTS"))
    emails = _split_list(environ.get("CODEBUDDY2API_SSO_ALLOWED_EMAILS"))
    # PUBLIC_ORIGIN is not seeded: it stays a live deployment setting (see
    # sso_config.deployment_origin), so changing the domain needs no console edit.
    if not any((enabled, issuer, client_id, client_secret, subjects, emails)):
        return {}
    seed: dict[str, Any] = {
        "enabled": enabled,
        "issuer": issuer,
        "clientId": client_id,
        "clientSecret": client_secret,
        "allowedSubjects": subjects,
        "allowedEmails": emails,
    }
    if flag("OIDC_REFRESH"):
        seed["scope"] = DEFAULT_SCOPE + " offline_access"
    return seed


def _split_list(raw: Any) -> list[str]:
    if not isinstance(raw, str):
        return []
    return [part.strip() for part in raw.replace(";", ",").split(",") if part.strip()]


def seeded(environ: Mapping[str, str], *, allow_local: bool) -> dict[str, Any] | None:
    """Validate the environment seed; ``None`` when it is absent or unusable.

    The seed is applied only to a store that has never been saved, and it can
    enable SSO only when it also names an allow-list: an unlisted provider
    would admit every account (design D2.3).
    """
    try:
        seed = seed_from_env(environ)
    except AuthSettingsError:
        return None
    if not seed:
        return None
    if not seed.get("allowedSubjects") and not seed.get("allowedEmails"):
        # Provider values still transfer, but SSO stays off until the operator
        # adds a subject or a verified e-mail in the console.
        seed = {**seed, "enabled": False}
    try:
        return validate(seed, DEFAULT_SSO, allow_local=allow_local)
    except AuthSettingsError:
        return None
