import { useCallback, useEffect, useId, useState } from "react";
import {
  errorMessage,
  readAuthSettings,
  saveAuthSettings,
  type AuthSettings,
  type AuthSettingsPatch,
} from "./api";
import { Badge, ErrorNotice, Icon, Panel } from "./components";
import { useT } from "./i18n";
import m from "./management.module.scss";
import s from "./ui.module.scss";

// Both login methods are configured here and stored by the gateway, so an
// operator never has to put OIDC values in the environment (design D2.2/D2.4).
// The client secret is write-only: the gateway answers with `hasClientSecret`.
type Draft = {
  ssoEnabled: boolean;
  keyLoginEnabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  providerName: string;
  allowedSubjects: string;
  allowedEmails: string;
};

function draftOf(settings: AuthSettings): Draft {
  return {
    ssoEnabled: settings.ssoEnabled,
    keyLoginEnabled: settings.keyLoginEnabled,
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecret: "",
    scope: settings.scope,
    providerName: settings.providerName,
    allowedSubjects: settings.allowedSubjects.join("\n"),
    allowedEmails: settings.allowedEmails.join("\n"),
  };
}

// One entry per line, with commas as a convenience separator; the gateway
// de-duplicates and validates each entry.
function entries(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isMissingRoute(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 404 || status === 405;
}

export function AuthSettingsPanel() {
  const t = useT();
  const id = useId();
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A gateway without the route keeps the console usable; the section says so
  // instead of occupying the page's error channel.
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    void readAuthSettings()
      .then((value) => {
        setSettings(value);
        setDraft(draftOf(value));
        setUnavailable(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isMissingRoute(err)) {
          setUnavailable(true);
          setError(null);
          return;
        }
        setError(errorMessage(err));
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  };
  const save = () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const patch: AuthSettingsPatch = {
      ssoEnabled: draft.ssoEnabled,
      keyLoginEnabled: draft.keyLoginEnabled,
      issuer: draft.issuer.trim(),
      clientId: draft.clientId.trim(),
      scope: draft.scope.trim(),
      providerName: draft.providerName.trim(),
      allowedSubjects: entries(draft.allowedSubjects),
      allowedEmails: entries(draft.allowedEmails),
    };
    // Blank means "keep the stored secret", which is how the gateway reads it.
    if (draft.clientSecret.trim()) patch.clientSecret = draft.clientSecret.trim();
    void saveAuthSettings(patch)
      .then((value) => {
        setSettings(value);
        setDraft(draftOf(value));
        setSaved(true);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Panel
      title="登录与 SSO"
      hint="面板密钥和单点登录都在此处配置，保存后立即生效。"
      action={
        settings && (
          <Badge tone={settings.ssoEnabled ? "good" : "neutral"}>
            {settings.ssoEnabled ? "SSO 已启用" : "SSO 未启用"}
          </Badge>
        )
      }
    >
      {loading && !draft && (
        <div className={s.loading} role="status">
          <span />
          {t("common.loading")}
        </div>
      )}
      {unavailable && !draft && (
        <p className={s.note}>当前网关未提供控制台认证配置接口，请升级后重试。</p>
      )}
      <ErrorNotice message={unavailable ? null : error} retry={load} />
      {draft && (
        <div className={m.settingsPanel} aria-label="登录与 SSO 设置">
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>启用单点登录</strong>
              <small>保存后会先校验颁发者的 discovery 文档。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <span className={s.check}>
                <input
                  id={`${id}-sso-enabled`}
                  type="checkbox"
                  checked={draft.ssoEnabled}
                  disabled={busy}
                  onChange={(e) => update("ssoEnabled", e.target.checked)}
                />
                <label htmlFor={`${id}-sso-enabled`}>{draft.ssoEnabled ? "启用" : "停用"}</label>
              </span>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>颁发者地址</strong>
              <small>OIDC Issuer，必须是 HTTPS 地址。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>颁发者地址</span>
                <input
                  type="url"
                  value={draft.issuer}
                  disabled={busy}
                  placeholder="https://sso.example.com"
                  onChange={(e) => update("issuer", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>Client ID</strong>
              <small>OIDC 客户端标识。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>Client ID</span>
                <input
                  type="text"
                  value={draft.clientId}
                  disabled={busy}
                  onChange={(e) => update("clientId", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>Client Secret</strong>
              <small>{settings?.hasClientSecret ? "已设置，留空保持不变。" : "尚未设置。"}</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>Client Secret</span>
                <input
                  type="password"
                  value={draft.clientSecret}
                  disabled={busy}
                  autoComplete="new-password"
                  placeholder={
                    settings?.hasClientSecret ? "已设置，留空保持不变" : "输入客户端密钥"
                  }
                  onChange={(e) => update("clientSecret", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>Scope</strong>
              <small>必须包含 openid。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>Scope</span>
                <input
                  type="text"
                  value={draft.scope}
                  disabled={busy}
                  onChange={(e) => update("scope", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>提供方名称</strong>
              <small>登录按钮上显示的名称，留空显示 SSO。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>提供方名称</span>
                <input
                  type="text"
                  value={draft.providerName}
                  disabled={busy}
                  onChange={(e) => update("providerName", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>管理员 subject 白名单</strong>
              <small>每行一个，登录时按 subject 精确匹配。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>管理员 subject 白名单</span>
                <textarea
                  value={draft.allowedSubjects}
                  rows={3}
                  disabled={busy}
                  onChange={(e) => update("allowedSubjects", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>管理员邮箱白名单</strong>
              <small>每行一个，仅接受提供方标记为已验证的邮箱。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <label className={s.field}>
                <span className={s.srOnly}>管理员邮箱白名单</span>
                <textarea
                  value={draft.allowedEmails}
                  rows={3}
                  disabled={busy}
                  onChange={(e) => update("allowedEmails", e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>回调地址</strong>
              <small>在 SSO 后台登记这个地址。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <code className={m.settingKey}>{settings?.callbackUrl || "—"}</code>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>关闭面板密钥登录</strong>
              <small>仅保留单点登录。关闭前必须先用 SSO 登录验证，否则网关会拒绝。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <span className={s.check}>
                <input
                  id={`${id}-key-login`}
                  type="checkbox"
                  checked={!draft.keyLoginEnabled}
                  disabled={busy}
                  onChange={(e) => update("keyLoginEnabled", !e.target.checked)}
                />
                <label htmlFor={`${id}-key-login`}>
                  {draft.keyLoginEnabled ? "面板密钥登录已开启" : "面板密钥登录已关闭"}
                </label>
              </span>
            </div>
          </div>
          <div className={m.settingsFooter}>
            <div aria-live="polite">
              <strong>{saved ? t("settings.saved") : t("settings.saveHint")}</strong>
            </div>
            <button type="button" className={s.primary} disabled={busy} onClick={save}>
              <Icon name={busy ? "loader" : "shield"} />
              {busy ? "正在保存登录设置…" : "保存登录设置"}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
