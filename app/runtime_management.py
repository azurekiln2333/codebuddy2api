"""Initialize management only for an explicitly started server, never at import."""

import os
import sqlite3
import sys
import threading
from pathlib import Path

from . import admin_auth, auth_settings, buddy, panel_key
from .admin_api import install_admin
from .platform_token import platform_token_from_env
from .api_keys import KeyStore
from .audit_store import AuditStore
from .backups import Backups
from .control_store import ControlStore
from .gateway_management import Management, install_pages
from .inference_auth import InferenceAuthMiddleware
from .media_store import MediaStore
from .model_policy import PolicyScopeMiddleware
from .observability import AuditMiddleware
from .panel_auth import install_panel_key
from .request_target import install_request_target_guard
from .settings import SCHEMA, apply_persisted_settings
from .sso_auth import install_sso
from .sso_config import from_settings, load as load_sso_config
from .updates import Updater


class UnavailableAudit:
    """An explicit degraded state; never silently recreate a damaged log database."""
    def __init__(self, code):
        self.code = code
        self.dropped = 0

    def ticket(self):
        return {"epoch": 0, "detail_generation": -1}

    def record_request(self, record):
        self.dropped += 1
        return {"ok": False, "recorded": False}

    def event(self, *args, **kwargs):
        self.dropped += 1
        return {"ok": False, "recorded": False}

    def note_failure(self, *args, **kwargs):
        self.dropped += 1

    def storage(self):
        return {"available": False, "degraded": True, "last_error": self.code, "dropped": self.dropped,
                "warning": "日志存储不可用；保留原文件，未自动重建。统计可能不完整。"}

    def dashboard(self, days=30, granularity="auto"):
        return {"summary": None, "series": [], "models": [], "profiles": [], "degraded": True, "storage": self.storage()}

    def list_records(self, *args, **kwargs):
        return {"items": [], "next_cursor": None, "has_more": False, "degraded": True}

    def api_key_stats(self, *args, **kwargs):
        return {"degraded": True, "items": {}}

    def get_request(self, id):
        return None

    def configure(self, **kwargs):
        return {"ok": False}

    def clear(self, scope):
        return {"ok": False}

    def close(self):
        pass


def resolve_auth_settings(control, environ) -> auth_settings.SettingsStore:
    """Load the console settings, seeding an unconfigured store from the env once.

    A missing or unusable SSO configuration never blocks startup (design D2.6):
    the console simply starts with key login enabled and SSO off.
    """
    try:
        saved = auth_settings.load(control)
    except auth_settings.AuthSettingsError:
        saved = None
    overrides = environ.get("ALLOW_INSECURE_LOCALHOST", "")
    allow_local = str(overrides).strip().lower() in ("1", "true", "yes", "on")
    # The control store is always attached: an unconfigured console still has to
    # persist the first change it accepts. Omitting it here made every later
    # PATCH update memory only, so the settings vanished on the next restart.
    store = auth_settings.SettingsStore(saved, control=control, allow_local=allow_local)
    if saved is None:
        seed = auth_settings.seeded(environ, allow_local=allow_local)
        if seed:
            try:
                auth_settings.save(control, seed)
                store = auth_settings.SettingsStore(seed, control=control,
                                                   allow_local=allow_local)
            except auth_settings.AuthSettingsError:
                store.replace(seed)
    return store


def initialize(gateway, args, argv=None, *, parser=None, dotenv_keys=()):
    config = gateway.CONFIG
    # SSO is configured from the console now, so startup only projects whatever
    # is saved. An unset or incomplete configuration is not a startup error.
    config["auto_accept_buddy"] = buddy.auto_accept_from_env(os.environ)
    config["auto_accept_buddy_source"] = "environment" if "CODEBUDDY2API_AUTO_ACCEPT_BUDDY" in os.environ else "default"
    root = gateway.managed_auth_dir()
    control = ControlStore(root / "control.sqlite3")
    config["control_store"] = control
    config["state_store"] = control.state
    try:
        control.state.migrate(root)
    except BaseException:
        control.close()
        raise
    # Console-managed auth settings: key login plus SSO, persisted in the
    # control database and hot-applied to the running service.
    config["auth_settings"] = resolve_auth_settings(control, os.environ)
    config["sso"] = from_settings(config["auth_settings"].current(),
                                  allow_local=config["auth_settings"].allow_local)
    config["panel_key"], config["panel_key_source"] = panel_key.key_from_env(os.environ)
    config.update(vars(args))
    config["model_guard"] = not args.no_model_guard
    aliases = {"log": "log_path", "no_model_guard": "model_guard"}
    explicit = set()
    options = parser._option_string_actions if parser is not None else {}
    for argument in (sys.argv[1:] if argv is None else argv):
        if argument.startswith("--"):
            flag = argument.split("=", 1)[0]
            matches = [flag] if flag in options else [name for name in options if name.startswith(flag)]
            # Resolve argparse's accepted abbreviations before assigning precedence.
            key = options[matches[0]].dest if len(matches) == 1 else flag[2:].replace("-", "_")
            explicit.add(aliases.get(key, key))
    apply_persisted_settings(config, explicit=explicit)
    from .startup import resolve_startup_auth
    try:
        resolve_startup_auth(config, args, dotenv_keys)
    except BaseException:
        control.close()
        raise
    for key in SCHEMA:
        if hasattr(args, key) and key != "api_key":
            setattr(args, key, config[key])
    config["key_store"] = KeyStore(control)
    # Admission is fail-closed: with no external key and no saved key the inference
    # routes answer 401 api_key_required. No switch re-opens anonymous access.
    if not config.get("api_key") and not config["key_store"].has_any():
        print("[auth] 尚未创建 API key，请登录 WebUI 创建", file=sys.stderr)
    config["trial_ledger"] = gateway.trial_rewards.TrialLedger(store=control.state)
    try:
        config["audit_store"] = AuditStore(root / "logs.sqlite3", max_bytes=config["audit_max_bytes"],
                                            retention_days=config["audit_retention_days"],
                                            preview_limit=config["audit_diagnostic_bytes"])
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        config["audit_store"] = UnavailableAudit(type(error).__name__)
        print("[audit] 日志库不可用，推理服务继续；请检查目录权限或使用备份恢复日志库。", file=sys.stderr)
    try:
        config["media_store"] = MediaStore(root)
    except (OSError, ValueError, sqlite3.Error) as error:
        config["media_store"] = None
        print(f"[media] 媒体存储不可用（{type(error).__name__}），图像/视频接口将返回 503。", file=sys.stderr)
    config["management"] = Management(gateway)
    config["backups"] = Backups(config, data_dir=root, version=gateway.APP_VERSION)
    config["updater"] = Updater(config, root=Path(gateway.__file__).resolve().parent,
                                data_dir=root, version=gateway.APP_VERSION, backups=config["backups"])
    return config["management"]


def install(gateway):
    config, app = gateway.CONFIG, gateway.app
    settings_store = config.get("auth_settings")
    sso = config.get("sso")
    if sso is None:
        sso = load_sso_config()
        config["sso"] = sso
    # The SSO routes are always installed so the login page can read the public
    # auth contract and a console-enabled SSO works without a restart.
    service = install_sso(app, config, store=settings_store)
    install_admin(app, config, config["management"],
                  sso=service if sso.enabled else None,
                  platform_token=platform_token_from_env(os.environ))
    app.add_middleware(AuditMiddleware, config=config)
    app.add_middleware(PolicyScopeMiddleware)
    from .inbound_limits import ConcurrencyLimitMiddleware, InboundBodyLimitMiddleware
    app.add_middleware(InboundBodyLimitMiddleware, config=config)
    app.add_middleware(ConcurrencyLimitMiddleware, config=config)
    # Authenticate headers before consuming inference capacity or buffering request bodies.
    app.add_middleware(InferenceAuthMiddleware, config=config)
    from .request_context import RequestContextMiddleware
    app.add_middleware(RequestContextMiddleware, config=config)
    # Outermost: the panel key, then the SSO boundary (or the legacy one when
    # SSO was off at startup). The OIDC check stays inside the SSO boundary, so
    # the outer layer only covers the hot-enable case.
    install_panel_key(app, config, service=None if sso.enabled else service)
    # Classify the raw request target before any route or auth work. Installed
    # unconditionally: path smuggling must be refused whatever the credential is.
    install_request_target_guard(app)
    install_pages(app, Path(gateway.__file__).resolve().parent / "web" / "dist")
    return service


def close(config):
    stop = config.get("key_housekeeping_stop")
    if stop is not None:
        stop.set()
        thread = config.get("key_housekeeping_thread")
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
    if config.get("key_store") is not None:
        config["key_store"].flush_used()
    for key in ("audit_store", "control_store", "media_store"):
        store = config.get(key)
        if store is not None:
            store.close()


def start_key_housekeeping(config):
    stop = threading.Event()

    def run():
        while not stop.wait(60):
            try:
                config["key_store"].flush_used()
            except (OSError, ValueError, sqlite3.Error):
                print("[auth] 密钥最后使用时间暂时无法保存", file=sys.stderr)

    thread = threading.Thread(target=run, daemon=True, name="api-key-housekeeping")
    config.update(key_housekeeping_stop=stop, key_housekeeping_thread=thread)
    thread.start()
