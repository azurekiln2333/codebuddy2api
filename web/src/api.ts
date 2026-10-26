import axios from "axios";
import { create } from "zustand";
import { useCallback, useEffect, useState } from "react";

export type RecordValue = Record<string, unknown>;
export type AdminUser = { sub: string; username?: string; name?: string; role: "admin" };
export type Session = { authenticated: true; csrf_token: string; user: AdminUser };
type AuthState = {
  status: "checking" | "authenticated" | "anonymous" | "forbidden" | "error";
  csrf: string | null;
  user: AdminUser | null;
  error: string | null;
};
export const useSession = create<AuthState>(() => ({
  status: "checking",
  csrf: null,
  user: null,
  error: null,
}));
export const api = axios.create({ baseURL: "/admin", withCredentials: true, timeout: 20000 });
export const sso = axios.create({ baseURL: "/sso", withCredentials: true, timeout: 20000 });
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
    useSession.setState({ status: "anonymous", csrf: null, user: null, error: null });
  }
  if (error.response?.status === 403) {
    sessionGeneration++;
    useSession.setState({ status: "forbidden", csrf: null, user: null, error: forbiddenMessage });
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
export async function establishSession() {
  const generation = ++sessionGeneration;
  useSession.setState({ status: "checking", csrf: null, user: null, error: null });
  try {
    const response = await sso.get<unknown>("/session");
    if (generation !== sessionGeneration) return;
    const data = object(response.data, "会话");
    if (data.authenticated === false) {
      if (data.csrf_token !== null || data.user !== null)
        throw new Error("未登录会话响应不符合接口契约");
      useSession.setState({ status: "anonymous", csrf: null, user: null, error: null });
      return;
    }
    if (
      data.authenticated !== true ||
      typeof data.csrf_token !== "string" ||
      !data.csrf_token.trim()
    )
      throw new Error("会话响应缺少认证状态或有效的 CSRF token");
    const user = object(data.user, "管理员身份");
    if (
      typeof user.sub !== "string" ||
      !user.sub.trim() ||
      (user.username !== undefined && typeof user.username !== "string") ||
      (user.name !== undefined && typeof user.name !== "string")
    )
      throw new Error("会话响应缺少有效的管理员身份");
    if (user.role !== "admin") {
      useSession.setState({ status: "forbidden", csrf: null, user: null, error: forbiddenMessage });
      return;
    }
    useSession.setState({
      status: "authenticated",
      csrf: data.csrf_token,
      user: {
        sub: user.sub,
        role: "admin",
        ...(typeof user.username === "string" ? { username: user.username } : {}),
        ...(typeof user.name === "string" ? { name: user.name } : {}),
      },
      error: null,
    });
  } catch (error) {
    if (generation !== sessionGeneration) return;
    if (axios.isAxiosError(error) && [401, 403].includes(error.response?.status ?? 0)) {
      invalidateSession(error, generation);
      return;
    }
    useSession.setState({ status: "error", csrf: null, user: null, error: errorMessage(error) });
  }
}
export async function endSession() {
  const { csrf, status } = useSession.getState();
  if (status !== "authenticated" || !csrf?.trim()) throw new Error("当前会话不可用，请重新登录。");
  const generation = ++sessionGeneration;
  try {
    await sso.post("/logout", null, { headers: { "X-CSRF-Token": csrf } });
    if (generation !== sessionGeneration) return;
    sessionGeneration++;
    useSession.setState({ status: "anonymous", csrf: null, user: null, error: null });
  } catch (error) {
    invalidateSession(error, generation);
    throw error;
  }
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
    error: string | null;
  }>({
    path,
    data: cached === undefined ? null : normalize(cached),
    loading: cached === undefined,
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
      return { path, data, loading: data === null, error: null };
    });
    void api
      .get<unknown>(path, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (options?.cache) resourceCache.set(path, response.data);
        setState({ path, data: normalize(response.data), loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          path,
          data: prev.path === path ? prev.data : null,
          loading: false,
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
    error: state.path === path ? state.error : null,
    reload,
  };
}
export type ModelRule = {
  id: string;
  public_id: string;
  upstream_id?: string;
  custom?: boolean;
  available?: boolean;
  enabled: boolean;
  keep_original: boolean;
  region: string;
  profile: string;
  credential_ids: string[];
  credits?: unknown;
  credits_by_profile?: unknown;
  capabilities?: unknown;
  limits?: unknown;
  metadata_by_profile?: unknown;
};
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
      "travel_supported",
      "trial_supported",
      "daily_chat_supported",
    ])
      if (c[field] !== undefined && typeof c[field] !== "boolean")
        throw new Error("自动任务状态必须为布尔值");
    for (const field of ["checkin", "travel", "trial", "daily_chat"])
      if (c[field] !== undefined && c[field] !== null) object(c[field], "自动任务结果");
    return { ...c, id, name: typeof name === "string" && !/[\\/]/.test(name) ? name : null };
  });
}
