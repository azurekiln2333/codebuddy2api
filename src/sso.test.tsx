import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRoutes, Guard } from "./App";
import { api, endSession, establishSession, sso, useSession } from "./api";

const admin = { sub: "admin-1", username: "operator", name: "管理员", role: "admin" as const };
const session = { authenticated: true, csrf_token: "gateway-csrf", user: admin };
const adminAdapter = api.defaults.adapter;
const ssoAdapter = sso.defaults.adapter;
function response(data: unknown, config: InternalAxiosRequestConfig) {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
}
function httpError(status: number, config: InternalAxiosRequestConfig) {
  return new AxiosError("denied", "ERR_BAD_REQUEST", config, undefined, {
    ...response({}, config),
    status,
  });
}
function authenticate() {
  useSession.setState({
    status: "authenticated",
    csrf: session.csrf_token,
    user: admin,
    error: null,
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  api.defaults.adapter = adminAdapter;
  sso.defaults.adapter = ssoAdapter;
  useSession.setState({ status: "checking", csrf: null, user: null, error: null });
});

describe("gateway SSO contract", () => {
  it("accepts only a gateway admin identity with nonempty CSRF", async () => {
    sso.defaults.adapter = (config) => Promise.resolve(response(session, config));
    await establishSession();
    expect(useSession.getState()).toMatchObject({
      status: "authenticated",
      csrf: "gateway-csrf",
      user: admin,
    });
  });

  it("keeps the newest bootstrap result when StrictMode checks finish out of order", async () => {
    let finishFirst!: () => void;
    sso.defaults.adapter = vi
      .fn()
      .mockImplementationOnce(
        (config: InternalAxiosRequestConfig) =>
          new Promise((resolve) => {
            finishFirst = () => resolve(response(session, config));
          }),
      )
      .mockImplementationOnce((config: InternalAxiosRequestConfig) =>
        Promise.resolve(response({ authenticated: false, csrf_token: null, user: null }, config)),
      );
    const first = establishSession();
    await establishSession();
    finishFirst();
    await first;
    expect(useSession.getState()).toMatchObject({ status: "anonymous", csrf: null, user: null });
  });

  it.each([401, 403])("ignores an old bootstrap HTTP %s after a newer login", async (status) => {
    let rejectFirst!: () => void;
    sso.defaults.adapter = vi
      .fn()
      .mockImplementationOnce(
        (config: InternalAxiosRequestConfig) =>
          new Promise((_resolve, reject) => {
            rejectFirst = () => reject(httpError(status, config));
          }),
      )
      .mockImplementationOnce((config: InternalAxiosRequestConfig) =>
        Promise.resolve(response(session, config)),
      );
    const first = establishSession();
    await establishSession();
    rejectFirst();
    await first;
    expect(useSession.getState()).toMatchObject({ status: "authenticated", user: admin });
  });

  it("cannot restore a revoked session from an in-flight successful bootstrap", async () => {
    let finish!: () => void;
    sso.defaults.adapter = (config) =>
      new Promise((resolve) => {
        finish = () => resolve(response(session, config));
      });
    const bootstrap = establishSession();
    api.defaults.adapter = (config) => Promise.reject(httpError(403, config));
    await expect(api.get("/models")).rejects.toThrow("denied");
    finish();
    await bootstrap;
    expect(useSession.getState()).toMatchObject({ status: "forbidden", csrf: null, user: null });
  });

  it.each([401, 403])("ignores an old admin HTTP %s after a new session", async (status) => {
    authenticate();
    let rejectOld!: () => void;
    const send = vi.fn(
      (config: InternalAxiosRequestConfig) =>
        new Promise<ReturnType<typeof response>>((_resolve, reject) => {
          rejectOld = () => reject(httpError(status, config));
        }),
    );
    api.defaults.adapter = send;
    const oldRequest = api.get("/credentials");
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    sso.defaults.adapter = (config) => Promise.resolve(response(session, config));
    await establishSession();
    rejectOld();
    await expect(oldRequest).rejects.toThrow("denied");
    expect(useSession.getState()).toMatchObject({ status: "authenticated", user: admin });
  });

  it.each([
    { ...session, csrf_token: "  " },
    { ...session, user: null },
    { ...session, user: { role: "admin" } },
    { ...session, user: { sub: " ", role: "admin" } },
    { ...session, user: { ...admin, name: 3 } },
    { authenticated: false, csrf_token: "unexpected", user: null },
  ])("rejects a malformed or unsafe session: %j", async (data) => {
    authenticate();
    sso.defaults.adapter = (config) => Promise.resolve(response(data, config));
    await establishSession();
    expect(useSession.getState()).toMatchObject({ status: "error", csrf: null, user: null });
  });

  it("keeps an anonymous gateway response anonymous", async () => {
    sso.defaults.adapter = (config) =>
      Promise.resolve(response({ authenticated: false, csrf_token: null, user: null }, config));
    await establishSession();
    expect(useSession.getState()).toMatchObject({ status: "anonymous", csrf: null, user: null });
  });

  it("denies an authenticated non-admin identity", async () => {
    sso.defaults.adapter = (config) =>
      Promise.resolve(response({ ...session, user: { ...admin, role: "user" } }, config));
    await establishSession();
    expect(useSession.getState()).toMatchObject({ status: "forbidden", csrf: null, user: null });
  });

  it.each([401, 403])("clears identity and CSRF after an admin HTTP %s", async (status) => {
    authenticate();
    api.defaults.adapter = (config) => Promise.reject(httpError(status, config));
    await expect(api.get("/credentials")).rejects.toThrow("denied");
    expect(useSession.getState()).toMatchObject({
      status: status === 401 ? "anonymous" : "forbidden",
      csrf: null,
      user: null,
    });
  });

  it("reports a gateway 403 as denied rather than an anonymous session", async () => {
    sso.defaults.adapter = (config) => Promise.reject(httpError(403, config));
    await establishSession();
    expect(useSession.getState()).toMatchObject({ status: "forbidden", csrf: null, user: null });
  });

  it("includes cookies and the gateway CSRF on real admin writes", async () => {
    authenticate();
    const seen: InternalAxiosRequestConfig[] = [];
    api.defaults.adapter = (config) => {
      seen.push(config);
      return Promise.resolve(response({ ok: true }, config));
    };
    await api.patch("/settings", { revision: 3, values: { port: 8000 } });
    expect(seen[0].baseURL).toBe("/admin");
    expect(seen[0].withCredentials).toBe(true);
    expect(seen[0].headers.get("X-CSRF-Token")).toBe("gateway-csrf");
    expect(seen[0].headers.get("Authorization")).toBeUndefined();
    expect(JSON.parse(seen[0].data as string)).toEqual({ revision: 3, values: { port: 8000 } });
  });

  it("does not send an admin mutation without an authenticated CSRF", async () => {
    const send = vi.fn();
    api.defaults.adapter = send;
    useSession.setState({ status: "authenticated", csrf: " ", user: admin });
    await expect(api.post("/credentials", {})).rejects.toThrow("请重新登录");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not poll upstream OAuth without an authenticated gateway CSRF", async () => {
    const send = vi.fn();
    api.defaults.adapter = send;
    useSession.setState({ status: "anonymous", csrf: null, user: null });
    await expect(api.get("/oauth/poll", { params: { login_id: "pending" } })).rejects.toThrow(
      "请重新登录",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("posts logout to the gateway with CSRF and clears identity after success", async () => {
    authenticate();
    const seen: InternalAxiosRequestConfig[] = [];
    sso.defaults.adapter = (config) => {
      seen.push(config);
      return Promise.resolve(response(null, config));
    };
    await endSession();
    expect(seen[0]).toMatchObject({
      baseURL: "/sso",
      url: "/logout",
      method: "post",
      withCredentials: true,
    });
    expect(seen[0].headers.get("X-CSRF-Token")).toBe("gateway-csrf");
    expect(useSession.getState()).toMatchObject({ status: "anonymous", csrf: null, user: null });
  });

  it("cannot restore a logged-out session from an older bootstrap response", async () => {
    let finishFirst!: () => void;
    sso.defaults.adapter = vi
      .fn()
      .mockImplementationOnce(
        (config: InternalAxiosRequestConfig) =>
          new Promise((resolve) => {
            finishFirst = () => resolve(response(session, config));
          }),
      )
      .mockImplementation((config: InternalAxiosRequestConfig) =>
        Promise.resolve(response(config.url === "/session" ? session : null, config)),
      );
    const first = establishSession();
    await establishSession();
    await endSession();
    finishFirst();
    await first;
    expect(useSession.getState()).toMatchObject({ status: "anonymous", csrf: null, user: null });
  });

  it.each([401, 403])("clears a denied logout session on HTTP %s", async (status) => {
    authenticate();
    sso.defaults.adapter = (config) => Promise.reject(httpError(status, config));
    await expect(endSession()).rejects.toThrow("denied");
    expect(useSession.getState()).toMatchObject({
      status: status === 401 ? "anonymous" : "forbidden",
      csrf: null,
      user: null,
    });
  });

  it("keeps a retryable session when gateway logout fails", async () => {
    authenticate();
    sso.defaults.adapter = () => Promise.reject(new Error("gateway unavailable"));
    await expect(endSession()).rejects.toThrow("gateway unavailable");
    expect(useSession.getState()).toMatchObject({
      status: "authenticated",
      csrf: "gateway-csrf",
      user: admin,
    });
  });
});

describe("SSO entry and access feedback", () => {
  it("offers only unified identity login and never an API Key field", () => {
    useSession.setState({ status: "anonymous" });
    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard/login"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "使用统一身份登录" }).getAttribute("href")).toBe(
      "/sso/login?return_to=/dashboard/",
    );
    expect(container.querySelector("form, input")).toBeNull();
    expect(container.textContent).toContain("AzureKiln");
  });

  it("removes the protected page and explains revoked admin access", async () => {
    authenticate();
    api.defaults.adapter = (config) => Promise.reject(httpError(403, config));
    render(
      <MemoryRouter initialEntries={["/dashboard/models"]}>
        <Routes>
          <Route element={<Guard />}>
            <Route path="/dashboard/models" element={<p>protected content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("protected content")).toBeTruthy();
    await act(async () => {
      await api.get("/models").catch(() => {});
    });
    expect(screen.queryByText("protected content")).toBeNull();
    expect(screen.getByRole("heading", { name: "无管理权限" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("权限已撤回");
    expect(screen.getByRole("link", { name: "使用其他账号登录" }).getAttribute("href")).toBe(
      "/sso/login?return_to=/dashboard/",
    );
  });

  it("rechecks a failed gateway session and displays real success", async () => {
    useSession.setState({ status: "error", error: "gateway unavailable" });
    sso.defaults.adapter = (config) =>
      Promise.resolve(response({ authenticated: false, csrf_token: null, user: null }, config));
    render(
      <MemoryRouter initialEntries={["/dashboard/login"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert").textContent).toBe("gateway unavailable");
    fireEvent.click(screen.getByRole("button", { name: "重新检查登录状态" }));
    await waitFor(() => expect(useSession.getState().status).toBe("anonymous"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
