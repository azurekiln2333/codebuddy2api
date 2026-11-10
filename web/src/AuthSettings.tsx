import { useCallback, useEffect, useId, useState } from "react";
import {
  errorMessage,
  readAuthSettings,
  saveAuthSettings,
  useAuthConfig,
  type AuthSettings,
  type AuthSettingsPatch,
} from "./api";
import { Badge, ErrorNotice, Icon, Panel } from "./components";
import { useT } from "./i18n";
import m from "./management.module.scss";
import { notify } from "./toast";
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

// The gateway enforces the same rules; repeating them here turns a failed
// round-trip into an immediate hint next to the field (design D2.4).
function problem(draft: Draft, hasStoredSecret: boolean): string | null {
  const subjects = entries(draft.allowedSubjects);
  const emails = entries(draft.allowedEmails);
  const secretReady = hasStoredSecret || draft.clientSecret.trim().length > 0;
  if (draft.ssoEnabled) {
    if (!draft.issuer.trim()) return "启用 SSO 需要填写颁发者地址。";
    if (!/^https?:\/\/\S+$/i.test(draft.issuer.trim()))
      return "颁发者地址需要完整的 http(s) 地址，例如 https://sso.example.com。";
    if (!draft.clientId.trim()) return "启用 SSO 需要填写 Client ID。";
    if (!secretReady) return "启用 SSO 需要填写 Client Secret。";
    if (!subjects.length && !emails.length)
      return "启用 SSO 需要至少一个管理员 subject 或邮箱白名单。";
    if (!draft.scope.split(/\s+/).includes("openid")) return "Scope 必须包含 openid。";
  }
  const badEmail = emails.find((email) => !/^[^@\s]+@[^@\s]+$/.test(email));
  if (badEmail) return `邮箱白名单里的 ${badEmail} 不是有效邮箱地址。`;
  if (!draft.keyLoginEnabled && !(draft.ssoEnabled && secretReady))
    return "关闭面板密钥登录前请先启用有效的 SSO，否则将无法进入控制台。";
  return null;
}

export function AuthSettingsPanel() {
  const t = useT();
  const id = useId();
  const authConfig = useAuthConfig();
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A gateway without the route keeps the console usable; the section says so
  // instead of occupying the page's error channel.
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    void readAuthSettings()
      .then((value) => {
        const next = draftOf(value);
        setSettings(value);
        setDraft(next);
        setSnapshot(JSON.stringify(next));
        setShowSecret(false);
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
  const dirty = draft ? JSON.stringify(draft) !== snapshot : false;
  const save = () => {
    if (!draft) return;
    const refusal = problem(draft, Boolean(settings?.hasClientSecret));
    if (refusal) {
      setSaved(false);
      setError(refusal);
      return;
    }
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
        const next = draftOf(value);
        setSettings(value);
        setDraft(next);
        setSnapshot(JSON.stringify(next));
        setSaved(true);
        notify({ key: "auth-settings-saved", tone: "good", title: "登录设置已保存" });
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => notify({ key: "auth-settings-copied", tone: "good", title: "已复制" }))
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };
  const keyLoginBlocked = Boolean(
    draft &&
    !draft.keyLoginEnabled &&
    !(draft.ssoEnabled && (settings?.hasClientSecret || draft.clientSecret.trim())),
  );
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
              <small>允许管理员通过外部 OIDC 提供方登录控制台。</small>
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
              <small>在 SSO 提供方登记的客户端编号。</small>
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
                  type={showSecret ? "text" : "password"}
                  value={draft.clientSecret}
                  disabled={busy}
                  autoComplete="new-password"
                  placeholder={
                    settings?.hasClientSecret ? "已设置，留空保持不变" : "输入客户端密钥"
                  }
                  onChange={(e) => update("clientSecret", e.target.value)}
                />
              </label>
              <button
                type="button"
                className={s.linkButton}
                disabled={busy}
                aria-label={showSecret ? "隐藏 Client Secret" : "显示 Client Secret"}
                onClick={() => setShowSecret((shown) => !shown)}
              >
                <Icon name={showSecret ? "eyeOff" : "eye"} />
              </button>
            </div>
          </div>
          <div className={m.settingRow}>
            <div className={`${s.settingDescription} ${m.settingDescription}`}>
              <strong>Scope</strong>
              <small>至少包含 openid；邮箱白名单需要 email。</small>
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
              <small>在 SSO 提供方登记这个地址，只读。</small>
            </div>
            <div className={`${s.settingControl} ${m.settingControl}`}>
              <code className={m.settingKey}>{settings?.callbackUrl || "保存后由网关生成"}</code>
              <button
                type="button"
                className={s.linkButton}
                aria-label="复制回调地址"
                disabled={!settings?.callbackUrl}
                onClick={() => settings?.callbackUrl && copy(settings.callbackUrl)}
              >
                <Icon name="copy" />
              </button>
            </div>
          </div>
          {authConfig.sso.loginUrl && (
            <div className={m.settingRow}>
              <div className={`${s.settingDescription} ${m.settingDescription}`}>
                <strong>单点登录入口</strong>
                <small>可直接用它开始登录。</small>
              </div>
              <div className={`${s.settingControl} ${m.settingControl}`}>
                <code className={m.settingKey}>{authConfig.sso.loginUrl}</code>
                <button
                  type="button"
                  className={s.linkButton}
                  aria-label="复制单点登录入口"
                  onClick={() => copy(authConfig.sso.loginUrl)}
                >
                  <Icon name="copy" />
                </button>
              </div>
            </div>
          )}
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
          {keyLoginBlocked && <p className={s.note}>关闭面板密钥登录前请先启用有效的 SSO。</p>}
          <div className={m.settingsFooter}>
            <div aria-live="polite">
              <strong>{saved ? t("settings.saved") : t("settings.saveHint")}</strong>
              {dirty && !saved && <small> · 有未保存修改</small>}
            </div>
            <button type="button" className={s.linkButton} disabled={busy} onClick={load}>
              重新读取
            </button>
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
