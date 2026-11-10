import axios from "axios";
import { create } from "zustand";
import { useCallback, useEffect, useState } from "react";

export type RecordValue = Record<string, unknown>;
export type SessionProvider = "key" | "sso";
export type AdminUser = {
  sub: string;
  username?: string;
  name?: string;
  /** Absent on panel-key sessions: the key holder is the administrator. */
  role?: "admin";
  provider?: string;
};
export type Session = { authenticated: true; csrf_token: string; user: AdminUser };
export type AuthConfig = {
  keyLoginEnabled: boolean;
  sso: { enabled: boolean; providerName: string; loginUrl: string };
};
type AuthState = {
  status: "checking" | "authenticated" | "anonymous" | "forbidden" | "error";
  csrf: string | null;
  user: AdminUser | null;
  /** Which login issued the session; decides the logout route. */
  provider: SessionProvider | null;
  error: string | null;
};
export const useSession = create<AuthState>(() => ({
  status: "checking",
  csrf: null,
  user: null,
  provider: null,
  error: null,
}));
// The public login-page contract. The fallback keeps the SSO button when the
// gateway cannot answer, so an older deployment can still be signed into.
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  keyLoginEnabled: true,
  sso: { enabled: true, providerName: "SSO", loginUrl: "/sso/login" },
};
export const useAuthConfig = create<AuthConfig>(() => DEFAULT_AUTH_CONFIG);
export async function loadAuthConfig(): Promise<AuthConfig> {
  try {
    const data = object((await sso.get<unknown>("/config")).data, "登录配置");
    const ssoConfig = object(data.sso, "单点登录配置");
    const config: AuthConfig = {
      keyLoginEnabled: data.keyLoginEnabled === true,
      sso: {
        enabled: ssoConfig.enabled === true,
        providerName:
          typeof ssoConfig.providerName === "string" && ssoConfig.providerName.trim()
            ? ssoConfig.providerName.trim()
            : "SSO",
        loginUrl: typeof ssoConfig.loginUrl === "string" ? ssoConfig.loginUrl : "",
      },
    };
    useAuthConfig.setState(config);
    return config;
  } catch {
    // A gateway without the route (or an unreachable one) keeps the default.
    useAuthConfig.setState(DEFAULT_AUTH_CONFIG);
    return DEFAULT_AUTH_CONFIG;
  }
}
export const api = axios.create({ baseURL: "/admin", withCredentials: true, timeout: 20000 });
export const sso = axios.create({ baseURL: "/sso", withCredentials: true, timeout: 20000 });
// The panel-key login is the one /admin write that runs without a session, so it
// uses a bare client: no CSRF injection and no session invalidation on 401.
export const loginApi = axios.create({ baseURL: "/admin", withCredentials: true, timeout: 20000 });
export const SSO_LOGIN_URL = "/sso/login?return_to=/dashboard/";
// A session check may finish after a newer check, revocation or logout. Only
// requests from the current generation may change the active session.
let sessionGeneration = 0;
const requestSessions = new WeakMap<object, number>();
const forbiddenMessage =
  "访问被拒绝：当前账号没有管理员权限、权限已撤回，或会话校验失败。请重新登录或联系管理员。";
function invalidateSession(error: unknown, generation: number) {
  if (generation !== sessionGeneration || !axios.isAxiosError(error)) return;
  if (error.response?.status === 401) {
    sessionGeneration++;
    useSession.setState({
      status: "anonymous",
      csrf: null,
      user: null,
      provider: null,
      error: null,
    });
  }
  if (error.response?.status === 403) {
    sessionGeneration++;
    useSession.setState({
      status: "forbidden",
      csrf: null,
      user: null,
      provider: null,
      error: forbiddenMessage,
    });
  }
}
api.interceptors.request.use((config) => {
  const { csrf, status } = useSession.getState();
  const write = !["get", "head", "options"].includes(config.method?.toLowerCase() ?? "get");
  const poll = config.url?.split("?")[0] === "/oauth/poll";
  if ((write || poll) && (status !== "authenticated" || !csrf?.trim()))
    throw new Error("当前会话不可用，请重新登录后再操作。");
  if (csrf?.trim()) config.headers.set("X-CSRF-Token", csrf);
  requestSessions.set(config, sessionGeneration);
  return config;
});
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.config)
      invalidateSession(error, requestSessions.get(error.config) ?? -1);
    return Promise.reject(error);
  },
);
export function object(value: unknown, context = "响应"): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${context}格式不符合接口契约`);
  return value as RecordValue;
}
export function list(value: unknown, context = "列表"): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`${context}缺失或格式错误`);
  return value.map((item) => object(item, context));
}
export function text(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return `${value}`;
  return "—";
}
export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function metric(value: unknown): string {
  const n = number(value);
  return n === null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
}
// Axis-scale abbreviation: 1234 → 1.2K, 429669080 → 429.7M; exact values stay in tooltips.
export function compact(value: unknown): string {
  const n = number(value);
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
}
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const bodyData: unknown = error.response?.data;
    const serverMessage =
      bodyData &&
      typeof bodyData === "object" &&
      "error" in bodyData &&
      bodyData.error &&
      typeof bodyData.error === "object" &&
      "message" in bodyData.error &&
      typeof bodyData.error.message === "string"
        ? bodyData.error.message
        : null;
    if (error.response?.status === 409) {
      if (serverMessage?.includes("凭证")) return serverMessage;
      const body: unknown = error.response.data;
      if (
        body &&
        typeof body === "object" &&
        "detail" in body &&
        body.detail &&
        typeof body.detail === "object" &&
        "models" in body.detail
      ) {
        const models = body.detail.models;
        return `凭证仍被模型规则引用，请先解除绑定：${Array.isArray(models) ? models.map(text).join("、") : text(models)}`;
      }
      return "保存冲突：配置已被其他操作更新。请关闭编辑并刷新后重新修改。";
    }
    if (error.response?.status === 401) return "会话已失效，请重新登录。";
    if (error.response?.status === 403) return serverMessage ?? forbiddenMessage;
    if (serverMessage) return serverMessage;
    const data: unknown = error.response?.data;
    if (data && typeof data === "object" && "detail" in data) {
      const detail: unknown = data.detail;
      if (typeof detail === "string") return detail;
      if (
        detail &&
        typeof detail === "object" &&
        "message" in detail &&
        typeof detail.message === "string"
      )
        return detail.message;
      if (detail && typeof detail === "object" && "error" in detail) {
        const nested: unknown = detail.error;
        if (
          nested &&
          typeof nested === "object" &&
          "message" in nested &&
          typeof nested.message === "string"
        )
          return nested.message;
      }
    }
    return error.response
      ? `请求失败（HTTP ${error.response.status}），请检查服务状态。`
      : "无法连接管理 API，请检查网络或服务状态后重试。";
  }
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
type SessionOutcome =
  | { kind: "anonymous" }
  | { kind: "forbidden" }
  | { kind: "authenticated"; provider: SessionProvider; csrf: string; user: AdminUser };

// Both login methods answer the same session shape, so one reader covers them.
// Only the SSO side carries a role claim; holding the panel key is the grant.
function readSession(provider: SessionProvider, value: unknown): SessionOutcome {
  const data = object(value, "会话");
  if (data.authenticated === false) {
    if (data.csrf_token !== null || data.user !== null)
      throw new Error("未登录会话响应不符合接口契约");
    return { kind: "anonymous" };
  }
  if (data.authenticated !== true || typeof data.csrf_token !== "string" || !data.csrf_token.trim())
    throw new Error("会话响应缺少认证状态或有效的 CSRF token");
  const user = object(data.user, "管理员身份");
  if (
    typeof user.sub !== "string" ||
    !user.sub.trim() ||
    (user.username !== undefined && typeof user.username !== "string") ||
    (user.name !== undefined && typeof user.name !== "string")
  )
    throw new Error("会话响应缺少有效的管理员身份");
  if (provider === "sso" && user.role !== "admin") return { kind: "forbidden" };
  return {
    kind: "authenticated",
    provider,
    csrf: data.csrf_token,
    user: {
      sub: user.sub,
      ...(provider === "sso" ? { role: "admin" as const } : {}),
      ...(typeof user.username === "string" ? { username: user.username } : {}),
      ...(typeof user.name === "string" ? { name: user.name } : {}),
      ...(typeof user.provider === "string" ? { provider: user.provider } : {}),
    },
  };
}

// The OIDC session keeps its own route; a 401 only means "no SSO session", and
// 403 stays the denied answer that the guard explains.
async function probeSsoSession(): Promise<SessionOutcome | null> {
  try {
    return readSession("sso", (await sso.get<unknown>("/session")).data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 403) return { kind: "forbidden" };
      // 401 (no cookie), 404 (route missing) and 5xx (store unavailable) all
      // mean this method has no session; the key probe decides next.
      if (error.response) return null;
      throw error;
    }
    throw error;
  }
}

// The panel-key session lives on /admin/session. A deployment without the
// route (or without a session) answers with an error, which is not a failure.
async function probePanelSession(): Promise<SessionOutcome | null> {
  try {
    return readSession("key", (await api.get<unknown>("/session")).data);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 403) return { kind: "forbidden" };
      // Transport failures here must not turn an anonymous visitor into an
      // error page: the SSO probe already reported whether the gateway answers.
      return null;
    }
    throw error;
  }
}

export async function establishSession() {
  const generation = ++sessionGeneration;
  useSession.setState({ status: "checking", csrf: null, user: null, provider: null, error: null });
  try {
    let outcome = await probeSsoSession();
    if (!outcome || outcome.kind === "anonymous") {
      const panel = await probePanelSession();
      if (panel && panel.kind !== "anonymous") outcome = panel;
      else if (!outcome) outcome = panel;
    }
    if (generation !== sessionGeneration) return;
    if (!outcome || outcome.kind === "anonymous") {
      useSession.setState({
        status: "anonymous",
        csrf: null,
        user: null,
        provider: null,
        error: null,
      });
      return;
    }
    if (outcome.kind === "forbidden") {
      useSession.setState({
        status: "forbidden",
        csrf: null,
        user: null,
        provider: null,
        error: forbiddenMessage,
      });
      return;
    }
    useSession.setState({
      status: "authenticated",
      csrf: outcome.csrf,
      user: outcome.user,
      provider: outcome.provider,
      error: null,
    });
  } catch (error) {
    if (generation !== sessionGeneration) return;
    if (axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)) {
      invalidateSession(error, generation);
      return;
    }
    useSession.setState({
      status: "error",
      csrf: null,
      user: null,
      provider: null,
      error: errorMessage(error),
    });
  }
}

// A failed login is not an expired session: the gateway's own reason (wrong
// key, key login disabled, throttled) is the useful message here.
function loginErrorText(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body: unknown = error.response?.data;
    if (body && typeof body === "object" && "error" in body) {
      const inner: unknown = (body as RecordValue).error;
      if (
        inner &&
        typeof inner === "object" &&
        "message" in inner &&
        typeof (inner as RecordValue).message === "string" &&
        (inner as RecordValue).message
      )
        return (inner as RecordValue).message as string;
    }
    if (error.response?.status === 429) return "登录尝试过多，请 10 分钟后重试。";
  }
  return errorMessage(error);
}

// Panel-key login. The browser only holds the session cookie afterwards; the
// key itself is never stored.
export async function signInWithKey(key: string) {
  const generation = ++sessionGeneration;
  useSession.setState({ status: "checking", csrf: null, user: null, provider: null, error: null });
  try {
    const outcome = readSession("key", (await loginApi.post<unknown>("/session", { key })).data);
    if (generation !== sessionGeneration) return;
    if (outcome.kind !== "authenticated") throw new Error("登录响应缺少会话信息");
    useSession.setState({
      status: "authenticated",
      csrf: outcome.csrf,
      user: outcome.user,
      provider: "key",
      error: null,
    });
  } catch (error) {
    if (generation !== sessionGeneration) return;
    useSession.setState({
      status: "anonymous",
      csrf: null,
      user: null,
      provider: null,
      error: loginErrorText(error),
    });
    throw error;
  }
}

export async function endSession() {
  const { csrf, status, provider } = useSession.getState();
  if (status !== "authenticated" || !csrf?.trim()) throw new Error("当前会话不可用，请重新登录。");
  const generation = ++sessionGeneration;
  try {
    // Each method revokes its own session; the CSRF token is the one the
    // session reported, and both routes demand it.
    if (provider === "key") await api.delete("/session", { headers: { "X-CSRF-Token": csrf } });
    else await sso.post("/logout", null, { headers: { "X-CSRF-Token": csrf } });
    if (generation !== sessionGeneration) return;
    sessionGeneration++;
    useSession.setState({
      status: "anonymous",
      csrf: null,
      user: null,
      provider: null,
      error: null,
    });
  } catch (error) {
    invalidateSession(error, generation);
    throw error;
  }
}
export function updateCsrf(token: string) {
  useSession.setState({ csrf: token });
}

// ------------------------------------------------ console auth settings (D2.4)
// The console reads `ssoEnabled` and writes `enabled`, matching the gateway
// document; the client secret only travels one way and comes back as a flag.
export type AuthSettings = {
  ssoEnabled: boolean;
  keyLoginEnabled: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scope: string;
  providerName: string;
  allowedSubjects: string[];
  allowedEmails: string[];
  callbackUrl: string;
};
export type AuthSettingsPatch = {
  ssoEnabled?: boolean;
  keyLoginEnabled?: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  providerName?: string;
  allowedSubjects?: string[];
  allowedEmails?: string[];
};
function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${context}必须是字符串数组`);
  return value as string[];
}
export function authSettingsResponse(value: unknown): AuthSettings {
  const data = object(value, "认证配置");
  for (const field of ["ssoEnabled", "keyLoginEnabled", "hasClientSecret"])
    if (typeof data[field] !== "boolean") throw new Error(`认证配置缺少 ${field}`);
  for (const field of ["issuer", "clientId", "scope", "providerName", "callbackUrl"])
    if (typeof data[field] !== "string") throw new Error(`认证配置缺少 ${field}`);
  return {
    ssoEnabled: data.ssoEnabled as boolean,
    keyLoginEnabled: data.keyLoginEnabled as boolean,
    hasClientSecret: data.hasClientSecret as boolean,
    issuer: data.issuer as string,
    clientId: data.clientId as string,
    scope: data.scope as string,
    providerName: data.providerName as string,
    callbackUrl: data.callbackUrl as string,
    allowedSubjects: stringList(data.allowedSubjects, "管理员 subject 白名单"),
    allowedEmails: stringList(data.allowedEmails, "管理员邮箱白名单"),
  };
}
// The gateway validates `enabled`; `ssoEnabled` is echoed for readers built
// against the console shape, and unknown fields are ignored server-side.
function authSettingsBody(patch: AuthSettingsPatch): RecordValue {
  const body: RecordValue = {};
  if (patch.ssoEnabled !== undefined) body.enabled = patch.ssoEnabled;
  if (patch.keyLoginEnabled !== undefined) body.keyLoginEnabled = patch.keyLoginEnabled;
  for (const field of [
    "issuer",
    "clientId",
    "clientSecret",
    "scope",
    "providerName",
    "allowedSubjects",
    "allowedEmails",
  ] as const)
    if (patch[field] !== undefined) body[field] = patch[field];
  return body;
}
export async function readAuthSettings(): Promise<AuthSettings> {
  return authSettingsResponse((await api.get<unknown>("/auth/settings")).data);
}
export async function saveAuthSettings(patch: AuthSettingsPatch): Promise<AuthSettings> {
  return authSettingsResponse(
    (await api.patch<unknown>("/auth/settings", authSettingsBody(patch))).data,
  );
}
// Session-level response cache for heavy pages (model routing): reopening the
// page renders the last snapshot instantly while a fresh fetch replaces it.
const resourceCache = new Map<string, unknown>();
useSession.subscribe((state, prev) => {
  if (state.status !== "authenticated" || state.csrf !== prev.csrf) resourceCache.clear();
});
export function useResource<T>(
  path: string,
  normalize: (value: unknown) => T,
  options?: { cache?: boolean },
) {
  const cached = options?.cache ? resourceCache.get(path) : undefined;
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
  }>({
    path,
    data: cached === undefined ? null : normalize(cached),
    loading: cached === undefined,
    refreshing: true,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const cachedForPath = options?.cache ? resourceCache.get(path) : undefined;
    // Keep same-path data (or a cached snapshot) on screen during refresh;
    // clear stale data when switching to a different path without a cache hit.
    setState((prev) => {
      const data =
        prev.path === path
          ? prev.data
          : cachedForPath === undefined
            ? null
            : normalize(cachedForPath);
      return { path, data, loading: data === null, refreshing: true, error: null };
    });
    void api
      .get<unknown>(path, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (options?.cache) resourceCache.set(path, response.data);
        setState({
          path,
          data: normalize(response.data),
          loading: false,
          refreshing: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          path,
          data: prev.path === path ? prev.data : null,
          loading: false,
          refreshing: false,
          error: errorMessage(error),
        }));
      });
    return () => controller.abort();
  }, [path, revision, normalize, options?.cache]);
  const currentData =
    state.path === path ? state.data : cached === undefined ? null : normalize(cached);
  return {
    data: currentData,
    loading: state.path === path ? state.loading : cached === undefined,
    // True during every fetch, including reloads that keep the previous data on screen.
    refreshing: state.path === path ? state.refreshing : true,
    error: state.path === path ? state.error : null,
    reload,
  };
}
export type ModelRoute = {
  upstream_id: string;
  weight: number | null;
  enabled: boolean;
  source: "builtin" | "cloud" | "manual";
};
export type ModelRule = {
  id: string;
  public_id: string;
  upstream_id?: string;
  routes?: ModelRoute[];
  custom?: boolean;
  available?: boolean;
  enabled: boolean;
  keep_original: boolean;
  region: string;
  profile: string;
  credential_ids: string[];
  credits?: unknown;
  credits_by_profile?: unknown;
  credits_override?: Record<string, number>;
  rate_details?: unknown;
  capabilities?: unknown;
  limits?: unknown;
  metadata_by_profile?: unknown;
  media_kinds?: string[];
  media_sources?: string[];
  media_defaults?: string[];
  embedding?: boolean;
  rerank?: boolean;
};
function rateOverride(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as RecordValue).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
export function modelResponse(value: unknown): {
  revision: number;
  models: ModelRule[];
  model_guard?: boolean;
  model_guard_locked?: boolean;
  model_capability_guard?: boolean;
  model_capability_guard_locked?: boolean;
} {
  const data = object(value);
  if (typeof data.revision !== "number") throw new Error("模型响应缺少 revision");
  const models = list(data.models).map((m) => {
    if (
      typeof m.id !== "string" ||
      typeof m.enabled !== "boolean" ||
      typeof m.keep_original !== "boolean" ||
      (m.upstream_id !== undefined && typeof m.upstream_id !== "string") ||
      (m.custom !== undefined && typeof m.custom !== "boolean") ||
      !Array.isArray(m.credential_ids) ||
      !m.credential_ids.every((id) => typeof id === "string")
    )
      throw new Error("模型规则字段不完整");
    return {
      ...m,
      id: m.id,
      public_id: typeof m.public_id === "string" ? m.public_id : m.id,
      upstream_id: typeof m.upstream_id === "string" ? m.upstream_id : m.id,
      custom: m.custom === true,
      available: typeof m.available === "boolean" ? m.available : undefined,
      enabled: m.enabled,
      keep_original: m.keep_original,
      region: typeof m.region === "string" ? m.region : "",
      profile: typeof m.profile === "string" ? m.profile : "",
      credential_ids: m.credential_ids as string[],
      routes: Array.isArray(m.routes)
        ? (m.routes.filter(
            (route): route is RecordValue =>
              !!route &&
              typeof route === "object" &&
              !Array.isArray(route) &&
              typeof route.upstream_id === "string" &&
              typeof route.enabled === "boolean" &&
              (route.weight === null || typeof route.weight === "number"),
          ) as ModelRoute[])
        : undefined,
      credits_override: rateOverride(m.credits_override),
    };
  });
  return {
    revision: data.revision,
    models,
    model_guard: typeof data.model_guard === "boolean" ? data.model_guard : undefined,
    model_guard_locked:
      typeof data.model_guard_locked === "boolean" ? data.model_guard_locked : undefined,
    model_capability_guard:
      typeof data.model_capability_guard === "boolean" ? data.model_capability_guard : undefined,
    model_capability_guard_locked:
      typeof data.model_capability_guard_locked === "boolean"
        ? data.model_capability_guard_locked
        : undefined,
  };
}
export type CatalogProfileVersions = {
  accounts: number;
  distinct: number;
  versions: { models: number; accounts: number }[];
};
export type CatalogScan = {
  status: "idle" | "running" | "completed" | "failed";
  total: number;
  completed: number;
  success: number;
  failed: number;
  differences: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  profiles: Record<string, CatalogProfileVersions>;
  accounts: RecordValue[];
};
export function catalogScanResponse(value: unknown): CatalogScan {
  const data = object(value, "目录扫描");
  const count = (field: string) => {
    const parsed = number(data[field]);
    if (parsed === null || parsed < 0) throw new Error(`目录扫描缺少 ${field}`);
    return parsed;
  };
  const status = data.status;
  if (status !== "idle" && status !== "running" && status !== "completed" && status !== "failed")
    throw new Error("目录扫描状态无效");
  return {
    status,
    total: count("total"),
    completed: count("completed"),
    success: count("success"),
    failed: count("failed"),
    differences: count("differences"),
    started_at: number(data.started_at),
    finished_at: number(data.finished_at),
    error: typeof data.error === "string" && data.error ? data.error : null,
    profiles: parseCatalogProfiles(data.profiles),
    accounts: Array.isArray(data.accounts) ? list(data.accounts, "目录扫描账号") : [],
  };
}
function parseCatalogProfiles(value: unknown): Record<string, CatalogProfileVersions> {
  if (!value || typeof value !== "object") return {};
  const profiles: Record<string, CatalogProfileVersions> = {};
  for (const [name, row] of Object.entries(value as Record<string, unknown>)) {
    const item = object(row, "目录版本");
    profiles[name] = {
      accounts: number(item.accounts) ?? 0,
      distinct: number(item.distinct) ?? 0,
      versions: list(item.versions, "目录版本列表").map((entry) => {
        const version = object(entry, "目录版本条目");
        return { models: number(version.models) ?? 0, accounts: number(version.accounts) ?? 0 };
      }),
    };
  }
  return profiles;
}
export type Credential = RecordValue & { id: string; name: string | null };
export function credentialResponse(value: unknown): Credential[] {
  return list(object(value).credentials, "凭证").map((c) => {
    const id = c.account_key ?? c.id;
    if (typeof id !== "string" || !id) throw new Error("凭证缺少公开 account_key");
    const name = c.name ?? c.filename;
    for (const field of [
      "auto_checkin",
      "auto_travel",
      "auto_daily_chat",
      "auto_growth",
      "travel_supported",
      "trial_supported",
      "daily_chat_supported",
      "growth_supported",
    ])
      if (c[field] !== undefined && typeof c[field] !== "boolean")
        throw new Error("自动任务状态必须为布尔值");
    if (c.restricted !== undefined && typeof c.restricted !== "boolean")
      throw new Error("官方限制状态必须为布尔值");
    for (const field of ["checkin", "travel", "trial", "daily_chat"])
      if (c[field] !== undefined && c[field] !== null) object(c[field], "自动任务结果");
    if (c.growth_auto !== undefined && c.growth_auto !== null)
      object(c.growth_auto, "成长任务开关");
    return { ...c, id, name: typeof name === "string" && !/[\\/]/.test(name) ? name : null };
  });
}
