import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useSession } from "./api";
import { AuthSettingsPanel } from "./AuthSettings";

const adapter = api.defaults.adapter;
const gatewaySettings = {
  ssoEnabled: false,
  keyLoginEnabled: true,
  issuer: "",
  clientId: "",
  hasClientSecret: false,
  scope: "openid profile email",
  providerName: "",
  allowedSubjects: [],
  allowedEmails: [],
  callbackUrl: "https://console.example.com/sso/callback",
};
function response(data: unknown, config: InternalAxiosRequestConfig) {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
}
function failure(status: number, data: unknown, config: InternalAxiosRequestConfig) {
  return new AxiosError("denied", "ERR_BAD_REQUEST", config, undefined, {
    ...response(data, config),
    status,
  });
}
beforeEach(() => {
  useSession.setState({
    status: "authenticated",
    csrf: "panel-csrf",
    user: { sub: "panel:key" },
    provider: "key",
    error: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  api.defaults.adapter = adapter;
});

describe("console auth settings", () => {
  it("renders the gateway state without the client secret", async () => {
    api.defaults.adapter = (config) => Promise.resolve(response(gatewaySettings, config));
    render(<AuthSettingsPanel />);
    expect(await screen.findByText("https://console.example.com/sso/callback")).toBeTruthy();
    expect(screen.getByText("尚未设置。")).toBeTruthy();
    // The secret is write-only, so the input never carries a stored value.
    const secret = screen.getByLabelText("Client Secret") as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.type).toBe("password");
    expect(screen.getByText("面板密钥登录已开启")).toBeTruthy();
  });

  it("patches the enabled flag and the allow-lists, and omits a blank secret", async () => {
    const writes: InternalAxiosRequestConfig[] = [];
    api.defaults.adapter = (config) => {
      if (config.method === "patch") {
        writes.push(config);
        return Promise.resolve(
          response({ ...gatewaySettings, ssoEnabled: true, issuer: "https://sso.example.com" }, config),
        );
      }
      return Promise.resolve(response(gatewaySettings, config));
    };
    render(<AuthSettingsPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "停用" }));
    const issuer = await screen.findByLabelText("颁发者地址");
    fireEvent.change(issuer, { target: { value: "https://sso.example.com" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "console" } });
    fireEvent.change(screen.getByLabelText("管理员 subject 白名单"), {
      target: { value: "admin-1\nadmin-2" },
    });
    fireEvent.change(screen.getByLabelText("管理员邮箱白名单"), {
      target: { value: "ops@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0].data as string)).toEqual({
      enabled: true,
      keyLoginEnabled: true,
      issuer: "https://sso.example.com",
      clientId: "console",
      scope: "openid profile email",
      providerName: "",
      allowedSubjects: ["admin-1", "admin-2"],
      allowedEmails: ["ops@example.com"],
    });
    expect(writes[0].headers.get("X-CSRF-Token")).toBe("panel-csrf");
  });

  it("sends a new client secret once and then shows it as stored", async () => {
    const writes: InternalAxiosRequestConfig[] = [];
    api.defaults.adapter = (config) => {
      if (config.method === "patch") {
        writes.push(config);
        return Promise.resolve(response({ ...gatewaySettings, hasClientSecret: true }, config));
      }
      return Promise.resolve(response(gatewaySettings, config));
    };
    render(<AuthSettingsPanel />);
    const secret = await screen.findByLabelText("Client Secret");
    fireEvent.change(secret, { target: { value: "s3cret-value" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0].data as string).clientSecret).toBe("s3cret-value");
    expect(await screen.findByText("已设置，留空保持不变。")).toBeTruthy();
    expect((screen.getByLabelText("Client Secret") as HTMLInputElement).value).toBe("");
  });

  it("surfaces the gateway refusal when closing key login without an SSO session", async () => {
    api.defaults.adapter = (config) =>
      config.method === "patch"
        ? Promise.reject(
            failure(403, { error: { message: "请先通过 SSO 登录验证，再关闭面板密钥登录" } }, config),
          )
        : Promise.resolve(response(gatewaySettings, config));
    render(<AuthSettingsPanel />);
    await screen.findByText("面板密钥登录已开启");
    fireEvent.click(screen.getByLabelText("面板密钥登录已开启"));
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("请先通过 SSO 登录验证");
  });
});
