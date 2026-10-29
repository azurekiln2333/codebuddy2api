# Storage management Not Found diagnosis

## Goal

Determine why storage management displays Not Found and fix only demonstrated
gateway defects. If the checked-in chain works, provide source-backed diagnosis
and exact deployment checks without claiming an unverified deployment cause.

## Requirements

- Trace GET `/admin/storage` and POST `/admin/storage/archive` through current
  original FastAPI routes, gateway classification/proxy, and UI API/normalizer.
- Add real-backend integration coverage for storage and archive, including
  expected errors; never synthesize absent endpoints or hide a 404 as success.
- UI source, original backend business code, OAuth/reference projects and
  approval helper scripts remain untouched. Other agents own UI visuals.
- Limit edits to necessary gateway tests/code, docs and this task's artifacts.
  Run targeted checks/build and commit explicit paths using Conventional Commit.
- No push or deployment. Authorization to implement/check/commit is already
  explicit in the user's request; no further confirmation is needed.

## Acceptance

- Identify the actual source route definitions and UI error propagation.
- Demonstrate the current gateway's storage behavior against original FastAPI
  with isolated temporary state and the existing compiled-JavaScript runner.
- If deployment evidence is absent, distinguish verified repository behavior
  from possible deployment causes and give exact non-destructive checks.
- Report findings, test evidence and commit hash to the root coordinator.

## Investigation boundary

Current source declares both storage routes in `app/admin_api.py`; `server.ts`
allows the `/admin/` namespace after live administrator authorization and
`proxy.ts` forwards the pathname unchanged. Start with tests and trace evidence;
change runtime behavior only if this reproduces a gateway defect. UI reads are
restricted to source inspection; its workspace has concurrent visual work.
