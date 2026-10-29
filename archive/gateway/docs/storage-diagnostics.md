# Storage management: Not Found

## Verified source path

The checked-out backend at `D:/My2KProjects/codebuddy2api` is commit
`fc95b04` (`Release v1.3.5`). Its current `app/admin_api.py` declares:

| Request | Source | Behavior |
| --- | --- | --- |
| `GET /admin/storage` | `app/admin_api.py:537` | Returns audit-storage metrics and `archives`; degraded storage returns 503. |
| `POST /admin/storage/archive` | `app/admin_api.py:551` | Accepts JSON `{days: integer}` in 1–3650; invalid input returns 400, archive failure 503. |

The route helper registers these paths with FastAPI (`app/admin_api.py:229`).
The gateway's `src/server.ts` authorizes the `/admin/` namespace and forwards
these paths. `src/proxy.ts` keeps the pathname, HTTP status and response body;
POST uses gateway Origin/CSRF validation followed by the distinct backend
session/CSRF bridge. There is no storage-specific gateway allowlist exclusion.

Read-only UI inspection confirms `src/api.ts:20` uses Axios `baseURL: '/admin'`.
`src/pages/Storage.tsx` requests `/storage` and posts `/storage/archive`, giving
the two full paths above. Vite forwards `/admin` without rewriting it; the
`/dashboard/` asset base does not prefix API requests.

The UI's `errorMessage` returns an error response's string `detail`, including
FastAPI's `Not Found`, and `useResource` displays that failure. The storage
normalizer only checks that a successful JSON value is an object; non-object
200 responses produce a contract-format error. A visible `Not Found` alone
does not establish which deployed hop produced the error.

## Local verification

On 2026-10-16, `npm run check`, `npm run build`, and the compiled-JavaScript
backend/storage tests passed: 19 tests, no failures or skips (18 original-backend
tests and one missing-handler test covering both paths).

| Local request through the gateway | Verified result |
| --- | --- |
| Original FastAPI `GET /admin/storage` | 200 with numeric storage metrics and `archives: []`. |
| Original FastAPI `POST /admin/storage/archive`, `{days: 30}` | 200, `ok: true`, zero archived rows and `file: null` for the isolated recent records. |
| Original FastAPI archive, `{days: 0}` | 400 with the backend's structured `admin_error`. |
| Both storage paths against the existing fixture without storage handlers | Original 404/body preserved; upstream request records confirm both exact paths were reached. |

The backend launcher uses temporary databases/credentials and redirects or
disables bytecode outside the original source tree. No runtime gateway change
was made; this task added regression coverage and diagnostic documentation.

The local source routes are present. A deployed backend version mismatch,
unregistered route, incorrect upstream target or reverse-proxy path issue
remains unconfirmed until the failing deployment is checked. No runtime
gateway correction is justified by source inspection alone. Missing routes
must keep their 404 status; the gateway must not return synthetic storage data.

## Two deployment checks

Run these **inside the actual backend container or host**, where
`127.0.0.1:8787` addresses the running FastAPI process. In this repository's
Compose example, replace the `python3` prefix with
`docker compose exec -T upstream python3`. Neither command prints a key,
cookie or token, and both use GET only.

First inspect the running process's OpenAPI route table:

```sh
python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:8787/openapi.json",timeout=5)); print("version:",d.get("info",{}).get("version")); [print(m.upper(),p,"present:",m in d.get("paths",{}).get(p,{})) for m,p in [("get","/admin/storage"),("post","/admin/storage/archive")]]'
```

Then query the storage read endpoint with the existing backend key supplied
through `CODEBUDDY2API_KEY`. Set that environment variable through your normal
secret configuration if it is not already present; do not place its value in
the command or share it in diagnostic output.

```sh
python3 -c 'import http.client,json,os; c=http.client.HTTPConnection("127.0.0.1",8787,timeout=5); c.request("GET","/admin/storage",headers={"Authorization":"Bearer "+os.environ["CODEBUDDY2API_KEY"]}); r=c.getresponse(); b=r.read(); print("status:",r.status); print("content-type:",r.getheader("content-type")); d=json.loads(b) if "application/json" in (r.getheader("content-type") or "") else {}; print("storage_fields_present:",isinstance(d,dict) and all(k in d for k in ("db_bytes","wal_bytes","archives"))); print("fastapi_not_found:",isinstance(d,dict) and d.get("detail")=="Not Found"); c.close()'
```

Interpret the output together with the failing browser request's full URL,
method, HTTP status and response shape:

- Missing OpenAPI routes plus authenticated direct 404 confirms that this
  running backend does not expose the expected route. Compare its loaded
  image/source and route installation with the source above; the cause may
  be version or startup wiring.
- Present routes plus direct 200 with storage fields establishes that the
  backend read route works. Compare the actual gateway `UPSTREAM_ORIGIN` and
  reverse-proxy path with the browser request to locate the remaining hop.
- Direct 401/403 means the authentication check must be resolved before using
  that response to judge route availability. Direct 503 indicates backend
  storage/auth state failure. OpenAPI being unavailable makes the first
  check inconclusive; it is not proof that the storage route is absent.

No deployed-service diagnosis or fix is claimed without that comparison.
