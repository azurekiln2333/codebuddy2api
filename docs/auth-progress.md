> Historical implementation handoff. Commands, counts and unavailable tools below describe earlier snapshots. See [validation.md](./validation.md), [security-review.md](./security-review.md) and [deployment.md](./deployment.md) for final behavior and evidence.

# Auth progress / handoff (src/auth.ts, src/oidc.ts, src/sessions.ts, tests/auth.test.ts)

Owner: auth agent. Status: **complete, handed off, no further writes**.
No commits made (main owns the first commit).

## Verdict on the two checker concerns

Both are **already fixed in the current on-disk source** and independently
verified.

### 1. `requireAdmin` post-UserInfo liveness — SATISFIED

`src/auth.ts` `requireAdmin()`:

- L215 `await this.ensureFreshToken(session)` (inside try/catch that clears the cookie on failure)
- L224 `this.assertLive(session)` after the refresh
- L228 `await this.oidc.userInfo(session.accessToken)` — live, never cached
- **L239 `this.assertLive(session)` after the UserInfo await** (cookie cleared on failure)
- L244 `isAdminIdentity(info, session.sub)` (sub match + `role === "admin"` + `isAdmin === true`)
- L247 `session.lastSeenAt = Date.now()` — runs **only after** the post-await check

`assertLive()` (L504-511) enforces all three, not just Map membership:

```
if (this.sessions.get(session.id) !== session) throw 401   // membership (logout/eviction)
if (now >= session.expiresAt) ...                          // absolute expiry
if (now - session.lastSeenAt >= this.config.sessionIdleMs) // idle expiry
  -> void this.destroy(session); throw 401
```

Regression: `tests/auth.test.ts` →
*"denies a session whose idle window elapses WHILE live UserInfo is in flight"*
(idle 1000ms, UserInfo delayed 1500ms, oauthTimeout 5000ms ⇒ expiry lands mid-await ⇒ 401).

### 2. `readJson` abort race — SATISFIED

`src/oidc.ts` `readJson()` (L547-585):

- Every `reader.read()` races the abort promise (L563-565).
- `reader.cancel()` runs on **every** failure path (L574), not only oversize.
- Listener removed in `finally` (L577-579).
- Signal originates from `AbortSignal.any([parent, timeout])` in `fetchWithTimeout`
  (L516) and is threaded through at all three call sites (L322, L364, L425).
  Neither the parent nor the timer is torn down when headers arrive, so the
  signal stays effective for the whole body read.

Empirical probe (temporary, now deleted) — provider sends `200` + headers then
stalls the body, gateway deadline 300ms:

```
result code: userinfo_timeout   elapsed: 335 ms
unhandledRejections: 0          serverSawClose: true
```

`serverSawClose: true` proves the abort reaches the socket and the stalled body
connection is torn down — not merely a rejected promise. Zero unhandled
rejections from the race loser.

Regression: `tests/auth.test.ts` →
*"aborts a provider that sends headers then stalls the body"*
(asserts bounded elapsed time **and** that the stalled socket was closed).

Anti-vacuity: both regressions were re-run against the pre-fix code and
**failed**, then passed after restoring the fix (45/47 → 47/47).

## Additional hardening in this same pass

- `token_type` must be a case-insensitive `Bearer` → else `token_type_unsupported`.
- Missing/invalid/negative `expires_in` fails closed (`expires_in_invalid`) instead of extending the token to a 300s default; a short value (e.g. `1`) is honored exactly.
- ID token `iat` far in the future rejected (`iat_in_future`, 60s tolerance).
- `azp` must name our client when present; multi-audience requires `azp`.
- Refresh validates a rotated ID token when present (`expectedSub`, issuer/aud/azp); optional on the refresh grant.
- Exactly one credential placement per token request, chosen from advertised
  `token_endpoint_auth_methods_supported` (basic preferred, post fallback,
  unsupported → error). No dual Basic+body.
- Cookie `Secure` is mandatory on any `https://` public origin regardless of
  `ALLOW_INSECURE_LOCALHOST`; omitted only for plain-HTTP loopback dev.
- Logout is `POST`/`DELETE` only (DELETE = `/admin/session` mapping); a bare
  `GET /sso/logout` is 405 and never ends a session.
- `/sso/session` returns 401 only for "no usable session"; a valid session whose
  live check fails (revoked/role lost/timeout) stays **403**.
- Session replacement: a new login destroys the browser's previous session, so
  an old id can never be replayed.
- `destroy()` hands the original session (including upstream bridge fields) to
  `cleanup` so the upstream admin session is actually revoked.
- Bounded JSON body reads (256 KB cap) and per-operation deadlines
  (`withDeadline`) for discovery/token/userinfo/ID-token verification.

## Files (exclusive to this agent)

- `src/auth.ts`
- `src/oidc.ts`
- `src/sessions.ts`
- `tests/auth.test.ts`

No other files were modified by this agent. Shared helpers touched earlier
(`tests/helpers/gateway.ts` `loginInFlight`) were additive; `startGateway` is
main's.

## Validation (final run, current source)

| Command | Result |
| --- | --- |
| `npm run check` | clean |
| `npm run build` | exit 0 |
| `node --import tsx --test tests/auth.test.ts` | **47/47 pass** |
| `npm test` | **182/182 pass, 0 fail** |

`docs/internal-contract.md` and `docs/ui-contract.md` are respected; no contract
change was required.
