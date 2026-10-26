"""Raw request-target validation at the ASGI boundary (SSO mode).

Ported from the retired gateway's ``validateRequestTarget``. The gateway had to
validate the *raw* target before any URL parsing because both Node and ASGI must
classify the same bytes identically. With the application now public, the same
property is enforced here: an encoded route alias, traversal segment, duplicate
separator or backslash must never be interpreted as a different route.

Percent-encoding stays legal **only** inside the model identifier of the two
literal model routes, because real model IDs contain ``/``, ``:`` and ``@``.
Everywhere else an encoded path is rejected, so ``/admin/%73ession`` cannot
become a session route.
"""
from __future__ import annotations

from urllib.parse import unquote

from starlette.responses import JSONResponse

MODEL_PREFIX = "/admin/models/"
PREVIEW_SUFFIX = "/preview"
MODEL_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:/@-"
)
MODEL_ID_MAX = 160


class RequestTargetError(ValueError):
    """The raw request target is ambiguous or unsafe."""


def _raw_model_id(path: str, method: str) -> str | None:
    """Return the raw model-ID window for the routes that legally encode it."""
    if not path.startswith(MODEL_PREFIX):
        return None
    if method in ("PUT", "DELETE"):
        return path[len(MODEL_PREFIX):]
    if method == "POST" and path.endswith(PREVIEW_SUFFIX) and path != MODEL_PREFIX + "preview":
        return path[len(MODEL_PREFIX):-len(PREVIEW_SUFFIX)]
    return None


def _valid_model_id(raw: str) -> bool:
    try:
        model_id = unquote(raw, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return False
    # Validate after exactly one decode, as ASGI does. This also excludes residual
    # escapes, empty segments and encoded dot segments.
    if not 1 <= len(model_id) <= MODEL_ID_MAX or any(ch not in MODEL_ID_CHARS for ch in model_id):
        return False
    return all(segment not in ("", ".", "..") for segment in model_id.split("/"))


def validate_request_target(target: str, method: str = "GET") -> None:
    """Reject an ambiguous raw target; raises ``RequestTargetError``."""
    if not target.startswith("/"):
        raise RequestTargetError("invalid_request_target")
    # Target holds the raw path only (ASGI keeps the query separately).
    if any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in target) or "\\" in target or "#" in target:
        raise RequestTargetError("invalid_request_target")
    if target.startswith("//"):
        raise RequestTargetError("invalid_request_target")

    path = target.split("?", 1)[0]
    raw_model_id = _raw_model_id(path, method.upper())

    if raw_model_id is not None:
        if not _valid_model_id(raw_model_id):
            raise RequestTargetError("ambiguous_path")
        # The prefix, separator and preview suffix must stay literal.
        literal = path[:len(MODEL_PREFIX)] + path[len(MODEL_PREFIX) + len(raw_model_id):]
        if "%" in literal:
            raise RequestTargetError("ambiguous_path")
    elif "%" in path:
        raise RequestTargetError("ambiguous_path")

    # Duplicate separators and dot segments would be normalized by a downstream
    # parser, so they are rejected before route classification.
    segments = path.split("/")
    if any(segment in (".", "..") for segment in segments):
        raise RequestTargetError("ambiguous_path")
    if "//" in path:
        raise RequestTargetError("ambiguous_path")

    # Only the exact `/admin/session` spelling may reach the session routes.
    if path != "/admin/session" and path.rstrip("/").lower() == "/admin/session":
        raise RequestTargetError("ambiguous_path")


class RequestTargetMiddleware:
    """ASGI middleware applying ``validate_request_target`` to every request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw = scope.get("raw_path")
        if isinstance(raw, bytes):
            target = raw.decode("latin-1")
        else:
            target = str(scope.get("path", ""))
        try:
            validate_request_target(target, str(scope.get("method", "GET")))
        except RequestTargetError as error:
            response = JSONResponse({"error": str(error)}, status_code=400,
                                    headers={"Cache-Control": "no-store"})
            return await response(scope, receive, send)
        return await self.app(scope, receive, send)


def install_request_target_guard(app) -> None:
    app.add_middleware(RequestTargetMiddleware)