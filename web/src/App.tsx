import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import {
  api,
  list,
  object,
  endSession,
  establishSession,
  errorMessage,
  loadAuthConfig,
  signInWithKey,
  SSO_LOGIN_URL,
  useAuthConfig,
  useSession,
} from "./api";
import { Drawer, ErrorNotice, Icon } from "./components";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Credentials } from "./pages/Credentials";
import { Keys } from "./pages/Keys";
import { Logs } from "./pages/Logs";
import { Media } from "./pages/Media";
import { Settings } from "./pages/Settings";
import { Storage } from "./pages/Storage";
import { Updates } from "./pages/Updates";
import { Appearance } from "./appearance";
import s from "./ui.module.scss";
import { LanguageProvider, chooseLanguage, serverPreference, useT } from "./i18n";

// Two reference-style groups: operational console surfaces first, then the
// management and access surfaces.
const navigationGroups = [
  {
    title: "nav.caption.console",
    tag: "nav.caption.consoleTag",
    items: [
      ["", "nav.overview", "grid"],
      ["/credentials", "nav.credentials", "key"],
      ["/models", "nav.models", "model"],
      ["/media", "nav.media", "image"],
    ],
  },
  {
    title: "nav.caption.manage",
    items: [
      ["/keys", "nav.keys", "key"],
      ["/logs", "nav.logs", "logs"],
      ["/storage", "nav.storage", "database"],
      ["/settings", "nav.settings", "settings"],
      ["/updates", "nav.updates", "up"],
    ],
  },
];
const navigation = navigationGroups.flatMap((group) => group.items);
// The SSO callback returns a machine code; the page explains the ones an
// operator can act on and shows any other code verbatim.
const authErrorLabels: Record<string, string> = {
  access_denied: "单点登录被取消或拒绝，请重试。",
  invalid_request: "单点登录请求无效，请重试。",
  invalid_state: "登录状态已失效，请重新发起。",
  invalid_nonce: "登录校验已失效，请重新发起。",
  email_unverified: "该账号的邮箱未经提供方验证，无法登录。",
  not_allowed: "该账号不在管理员白名单中。",
  discovery_failed: "无法连接单点登录服务，请稍后重试或联系管理员。",
  sso_disabled: "单点登录未启用，请使用面板密钥登录。",
};
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="m16 3 12 7v13l-12 7L4 23V10L16 3Z" fill="currentColor" />
      <path
        d="m4 10 12 7 12-7M16 17v13M10 6.5l12 7v6.8"
        stroke="var(--brand, #3169df)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
function BrandText() {
  const t = useT();
  return (
    <span className={s.brandText}>
      {t("app.brandPrefix")}
      <span className={s.brandAccent}>{t("app.brandAccent")}</span>
      {t("app.brandSuffix")}
    </span>
  );
}
// First painted frame: brand mark, restrained loader and the exact reference
// status copy. The status role keeps assistive technology informed.
function BootScreen() {
  const t = useT();
  return (
    <div className={s.boot} role="status">
      <span className={s.brandIcon}>
        <BrandMark />
      </span>
      <span className={s.spin}>
        <Icon name="loader" size={20} />
      </span>
      <span>{t("app.connecting")}</span>
    </div>
  );
}
export function Guard() {
  const t = useT();
  const { status, error } = useSession();
  if (status === "checking") return <BootScreen />;
  if (status === "error" || status === "forbidden")
    return (
      <div className={s.center}>
        {status === "forbidden" && <h1>{t("app.accessDenied")}</h1>}
        <ErrorNotice
          message={error}
          retry={() => {
            void establishSession();
          }}
        />
        <a className={s.linkButton} href={SSO_LOGIN_URL}>
          {status === "forbidden" ? t("app.otherAccount") : t("app.backToSignIn")}
        </a>
      </div>
    );
  return status === "authenticated" ? <Outlet /> : <Navigate to="/dashboard/login" replace />;
}
function Shell() {
  const t = useT();
  const location = useLocation();
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Routes share one scroll container, but each page starts at its heading.
    if (workspace.current) workspace.current.scrollTop = 0;
  }, [location.pathname]);
  const user = useSession((state) => state.user);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    // Cached server-side; the gateway checks releases in the background.
    void api
      .get<unknown>("/update")
      .then((response) => setUpdateAvailable(object(response.data).update_available === true))
      .catch(() => undefined);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.("(max-width: 800px)").matches ?? false,
  );
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 800px)");
    if (!media) return;
    const changed = () => {
      setMobile(media.matches);
      setNavigationOpen(false);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  // Dismiss the account panel on Escape or an outside pointer press.
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setMenuOpen(false);
        return;
      }
      const target = event.target;
      if (target instanceof Node && menu.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [menuOpen]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("azurekiln.sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("azurekiln.sidebar.collapsed", String(next));
    } catch {
      /* Session-only preference when storage is unavailable. */
    }
  };
  const signOut = () => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    void endSession()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const initial = (user?.name || user?.username || "").trim().slice(0, 1).toUpperCase();
  const activeKey =
    navigation.find(
      ([path]) => `/dashboard${path}` === location.pathname.replace(/\/$/, ""),
    )?.[1] ?? "nav.overview";
  const renderNavigation = (inDrawer = false) => (
    <>
      <nav
        id={inDrawer ? "mobile-navigation" : "workspace-navigation"}
        aria-label={t("app.primaryNav")}
      >
        {navigationGroups.map((group) => (
          <div className={s.navGroup} key={group.title}>
            <p className={s.navCaption}>
              {t(group.title)}
              {group.tag && <span>{t(group.tag)}</span>}
            </p>
            {group.items.map(([path, labelKey, icon]) => {
              const flagged = path === "/updates" && updateAvailable;
              const label = flagged ? `${t(labelKey)} · ${t("updates.available")}` : t(labelKey);
              return (
                <NavLink
                  key={path}
                  to={
                    path === ""
                      ? location.pathname === "/dashboard"
                        ? "/dashboard"
                        : "/dashboard/"
                      : `/dashboard${path}`
                  }
                  end={path === ""}
                  aria-label={label}
                  title={!inDrawer && collapsed ? label : undefined}
                  data-label={label}
                  onClick={() => setNavigationOpen(false)}
                  className={({ isActive }) => `${s.navItem} ${isActive ? s.active : ""}`}
                >
                  <Icon name={icon} size={17} />
                  <span className={s.navText}>{t(labelKey)}</span>
                  {flagged && <span className={s.navDot} />}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className={s.sidebarBottom}>
        <span className={s.sidebarHelp}>
          <i className={s.blueDot} />
          {t("footer.gateway")}
        </span>
      </div>
    </>
  );
  return (
    <div className={`${s.app} ${collapsed ? s.collapsed : ""}`}>
      <a href="#main" className={s.skip}>
        {t("app.skip")}
      </a>
      <header className={s.header}>
        <div className={s.topbarLeading}>
          <button
            type="button"
            className={s.sidebarToggle}
            onClick={() => (mobile ? setNavigationOpen(true) : toggleSidebar())}
            aria-label={
              mobile
                ? t("app.openNavigation")
                : collapsed
                  ? t("app.expandSidebar")
                  : t("app.collapseSidebar")
            }
            aria-expanded={mobile ? navigationOpen : !collapsed}
            aria-controls={mobile ? "mobile-navigation" : "workspace-navigation"}
            aria-haspopup={mobile ? "dialog" : undefined}
            title={
              mobile
                ? t("app.openNavigation")
                : collapsed
                  ? t("app.expandSidebar")
                  : t("app.collapseSidebar")
            }
          >
            <Icon name={mobile ? "menu" : collapsed ? "expand" : "collapse"} />
          </button>
          <Link className={s.brand} to="/dashboard/" aria-label={t("app.brandAria")}>
            <span className={s.brandIcon}>
              <BrandMark />
            </span>
            <BrandText />
          </Link>
          <div className={s.breadcrumbs}>
            <span>{t("nav.caption.console")}</span>
            <Icon name="chevronRight" size={13} />
            <strong>{t(activeKey)}</strong>
          </div>
        </div>
        <div className={s.actions}>
          <Appearance />
          <span className={s.topbarSeparator} />
          <div className={s.userMenu} ref={menu}>
            <button
              type="button"
              className={s.userTrigger}
              aria-label={t("app.userMenu")}
              title={user?.sub}
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className={s.userAvatar}>{initial || <Icon name="user" size={15} />}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {menuOpen && (
              <div id={menuId} className={s.userPanel} role="group" aria-label={t("app.userMenu")}>
                <div className={s.userIdentity}>
                  <span className={`${s.userAvatar} ${s.large}`}>
                    {initial || <Icon name="user" size={17} />}
                  </span>
                  <span className={s.userIdentityText}>
                    <strong>{user?.name || user?.username || t("app.adminSession")}</strong>
                    <small>{user?.sub}</small>
                  </span>
                </div>
                <div className={s.userMenuSep} />
                <button type="button" className={s.userLogout} disabled={busy} onClick={signOut}>
                  <Icon name="logout" size={15} />
                  <span>{t("app.signOut")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {!mobile && <aside className={s.sidebar}>{renderNavigation()}</aside>}
      {mobile && navigationOpen && (
        <Drawer
          title={t("app.primaryNav")}
          className={s.navigationDrawer}
          onClose={() => setNavigationOpen(false)}
        >
          {renderNavigation(true)}
        </Drawer>
      )}
      <div className={s.workspace} ref={workspace}>
        <main id="main" className={s.main}>
          <ErrorNotice message={error} />
          <Outlet />
        </main>
        <footer className={s.pageFooter}>
          <span>
            <i className={s.blueDot} />
            {t("footer.gateway")}
            <span className={s.footerDot}>·</span>
            <span className={s.footerProduct}>{t("app.brandName")}</span>
          </span>
          {/* Plain anchors: the gateway serves these two documents as text/plain,
           * so the browser must navigate instead of the SPA router handling it.
           * Without this the built notices have no reachable entry point. */}
          <span className={s.footerLinks}>
            <a href="/dashboard/THIRD_PARTY_NOTICES.txt">{t("footer.notices")}</a>
            <a href="/dashboard/THIRD_PARTY_LICENSES.txt" rel="license">
              {t("footer.licenses")}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
function Login() {
  const t = useT();
  const { status, error } = useSession();
  const config = useAuthConfig();
  const location = useLocation();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  if (status === "authenticated") return <Navigate to="/dashboard/" replace />;
  const forbidden = status === "forbidden";
  // The SSO callback reports failures in the URL; the message must survive the
  // redirect so the operator knows whether to retry or ask for access.
  const authError = new URLSearchParams(location.search).get("auth_error");
  const authErrorText = authError
    ? (authErrorLabels[authError] ?? `单点登录失败（${authError}），请重试。`)
    : null;
  const ssoLabel =
    config.sso.providerName && config.sso.providerName !== "SSO"
      ? `使用 ${config.sso.providerName} 登录`
      : t("login.ssoSignIn");
  const ssoHref = `${config.sso.loginUrl || "/sso/login"}?return_to=/dashboard/`;
  return (
    <div className={s.loginShell}>
      <section className={s.loginStory}>
        <span className={s.brand}>
          <span className={s.brandIcon}>
            <BrandMark />
          </span>
          <BrandText />
          <span className={s.brandTag}>{t("app.consoleTag")}</span>
        </span>
        <div className={s.loginStoryContent}>
          <span className={s.eyebrow}>
            <i className={s.blueDot} />
            {t("login.story.eyebrow")}
          </span>
          <h1>
            {t("login.story.headline1")}
            <br />
            {t("login.story.headline2")}
          </h1>
          <div className={s.networkArt} aria-hidden="true">
            <div className={s.networkCenter}>
              <Icon name="model" size={26} />
              <span>{t("login.network.center")}</span>
            </div>
            <svg className={s.networkEdges} viewBox="0 0 440 200">
              <path d="M110 100H210Q240 100 240 50T280 25H335M210 100H335M210 100Q240 100 240 150T280 175H335" />
            </svg>
            {[1, 2, 3].map((node) => (
              <div className={`${s.networkNode} ${s[`node${node}`]}`} key={node}>
                <Icon name="cloud" size={19} />
                <span>{t("login.network.node", { n: node })}</span>
                <i />
              </div>
            ))}
          </div>
        </div>
        <div className={s.loginStoryFooter}>
          <span>{t("login.story.footer")}</span>
        </div>
      </section>
      <main className={s.loginMain}>
        <div className={s.loginTheme}>
          <Appearance />
        </div>
        <div className={s.loginCard}>
          <span className={s.loginLock}>
            <Icon name="shield" size={25} />
          </span>
          <span className={s.eyebrow}>{t("login.form.eyebrow")}</span>
          <h2>{forbidden ? t("app.accessDenied") : t("login.codebuddy2apiSignIn")}</h2>
          <p>
            {config.keyLoginEnabled && config.sso.enabled
              ? "使用面板密钥或统一身份登录，仅管理员可访问。"
              : config.keyLoginEnabled
                ? "使用面板密钥登录，仅管理员可访问。"
                : "使用统一身份登录，仅管理员可访问。"}
          </p>
          <ErrorNotice message={error ?? authErrorText} />
          {config.keyLoginEnabled && (
            <form
              className={s.grid}
              onSubmit={(event) => {
                event.preventDefault();
                if (!key.trim() || busy) return;
                setBusy(true);
                void signInWithKey(key.trim())
                  // The store holds the reason; the form only stops being busy.
                  .catch(() => undefined)
                  .finally(() => {
                    setBusy(false);
                    setKey("");
                  });
              }}
            >
              <label className={s.field}>
                面板密钥
                <input
                  type="password"
                  value={key}
                  autoComplete="current-password"
                  disabled={busy}
                  placeholder="PANEL_ADMIN_KEY"
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
              <button className={`${s.primary} ${s.loginSubmit}`} disabled={busy || !key.trim()}>
                <Icon name="shield" size={16} />
                <span>{t("login.enter")}</span>
              </button>
            </form>
          )}
          {config.sso.enabled && (
            <a className={`${s.linkButton} ${s.loginSubmit}`} href={ssoHref}>
              <Icon name="shield" size={16} />
              <span>{forbidden ? t("app.otherAccount") : ssoLabel}</span>
              <Icon name="arrow" size={16} />
            </a>
          )}
          {(status === "error" || status === "forbidden") && (
            <button
              type="button"
              className={s.loginRecheck}
              onClick={() => {
                void establishSession();
              }}
            >
              {t("login.recheck")}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/dashboard/login" element={<Login />} />
      <Route element={<Guard />}>
        <Route path="/dashboard" element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="models" element={<Models />} />
          <Route path="credentials" element={<Credentials />} />
          <Route path="keys" element={<Keys />} />
          <Route path="logs" element={<Logs />} />
          <Route path="media" element={<Media />} />
          <Route path="settings" element={<Settings />} />
          <Route path="storage" element={<Storage />} />
          <Route path="updates" element={<Updates />} />
          <Route path="updates/:tag" element={<Updates />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard/" replace />} />
    </Routes>
  );
}
export default function App() {
  useEffect(() => {
    // The public login config decides which methods the login page offers, so
    // it is loaded alongside the session instead of after it.
    void loadAuthConfig();
    void establishSession();
  }, []);
  const status = useSession((state) => state.status);
  useEffect(() => {
    if (status !== "authenticated") return;
    // The stored language wins over the browser cache once the session is known.
    void api
      .get<unknown>("/settings")
      .then((response) => {
        const data = object(response.data);
        const stored = list(data.items).find((item) => item.key === "language");
        if (stored) chooseLanguage(serverPreference(stored.value));
      })
      .catch(() => undefined);
  }, [status]);
  return (
    <LanguageProvider>
      <AppRoutes />
    </LanguageProvider>
  );
}
