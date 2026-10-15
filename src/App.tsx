import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { endSession, establishSession, errorMessage, SSO_LOGIN_URL, useSession } from "./api";
import { ErrorNotice, Icon } from "./components";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Credentials } from "./pages/Credentials";
import { Logs } from "./pages/Logs";
import { Settings } from "./pages/Settings";
import { Storage } from "./pages/Storage";
import { Appearance } from "./appearance";
import s from "./ui.module.scss";
import { LanguageProvider, useT } from "./i18n";

const navigation = [
  ["", "nav.overview", "grid"],
  ["/models", "nav.models", "model"],
  ["/credentials", "nav.credentials", "key"],
  ["/logs", "nav.logs", "logs"],
  ["/storage", "nav.storage", "database"],
  ["/settings", "nav.settings", "settings"],
];
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="m16 3 12 7v13l-12 7L4 23V10L16 3Z" fill="currentColor" />
      <path
        d="m4 10 12 7 12-7M16 17v13M10 6.5l12 7v6.8"
        stroke="var(--surface, #fff)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
export function Guard() {
  const t = useT();
  const { status, error } = useSession();
  if (status === "checking")
    return (
      <div className={s.center} role="status">
        {t("app.verifying")}
      </div>
    );
  if (status === "error" || status === "forbidden")
    return (
      <div className={s.center}>
        {status === "forbidden" && <h1>无管理权限</h1>}
        <ErrorNotice
          message={error}
          retry={() => {
            void establishSession();
          }}
        />
        <a className={s.linkButton} href={SSO_LOGIN_URL}>
          {status === "forbidden" ? "使用其他账号登录" : t("app.backToSignIn")}
        </a>
      </div>
    );
  return status === "authenticated" ? <Outlet /> : <Navigate to="/dashboard/login" replace />;
}
function Shell() {
  const t = useT();
  const location = useLocation();
  const user = useSession((state) => state.user);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  return (
    <div className={`${s.app} ${collapsed ? s.collapsed : ""}`}>
      <a href="#main" className={s.skip}>
        {t("app.skip")}
      </a>
      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <NavLink className={s.brand} to="/dashboard/" aria-label="AzureKiln 管理概览">
            <span className={s.brandIcon}>
              <BrandMark />
            </span>
            <span className={s.brandText}>
              AzureKiln<small>{t("app.brandSubtitle")}</small>
            </span>
          </NavLink>
          <button
            className={s.sidebarToggle}
            onClick={toggleSidebar}
            aria-label={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
            aria-expanded={!collapsed}
            aria-controls="workspace-navigation"
            title={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
          >
            <Icon name={collapsed ? "expand" : "collapse"} />
          </button>
        </div>
        <p className={s.navLabel}>{t("app.workspace")}</p>
        <nav id="workspace-navigation" aria-label={t("app.primaryNav")}>
          {navigation.map(([path, labelKey, icon]) => {
            const label = t(labelKey);
            return (
              <NavLink
                key={path}
                to={`/dashboard${path}`}
                end={path === ""}
                aria-label={label}
                title={collapsed ? label : undefined}
                data-label={label}
                className={({ isActive }) => `${s.navItem} ${isActive ? s.active : ""}`}
              >
                <Icon name={icon} />
                <span className={s.navText}>{label}</span>
                <span className={s.navArrow}>
                  <Icon name="arrow" />
                </span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <div className={s.workspace}>
        <header className={s.header}>
          <span>
            {t("app.workspace")} <span className={s.separator}>/</span>{" "}
            {t(
              navigation.find(([path]) => `/dashboard${path}` === location.pathname)?.[1] ??
                "nav.overview",
            )}
          </span>
          <div className={s.actions}>
            <Appearance />
            <span className={s.session} title={user?.sub}>
              <span />
              {user?.name || user?.username || t("app.sessionActive")}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void endSession()
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("app.signOut")}
            </button>
          </div>
        </header>
        <main id="main" className={s.main}>
          <ErrorNotice message={error} />
          <Outlet />
        </main>
        <footer className={s.footer}>AzureKiln · 管理控制台</footer>
      </div>
    </div>
  );
}
function Login() {
  const { status, error } = useSession();
  if (status === "authenticated") return <Navigate to="/dashboard/" replace />;
  return (
    <div className={s.login}>
      <div className={s.loginAppearance}>
        <Appearance />
      </div>
      <section className={s.loginIntro}>
        <div className={s.brand}>
          <span className={s.brandIcon}>
            <BrandMark />
          </span>
          AzureKiln
        </div>
        <h1>管理控制台</h1>
        <p>集中管理上游账号、模型路由和服务运行状态。</p>
      </section>
      <section className={s.loginCard}>
        <Icon name="shield" />
        <h2>{status === "forbidden" ? "无管理权限" : "登录 AzureKiln"}</h2>
        <p>使用统一身份账号登录。仅管理员可以访问此控制台。</p>
        {status === "checking" ? (
          <p role="status">正在验证登录状态…</p>
        ) : (
          <>
            <ErrorNotice message={error} />
            <a className={`${s.linkButton} ${s.primary}`} href={SSO_LOGIN_URL}>
              {status === "forbidden" ? "使用其他账号登录" : "使用统一身份登录"}
              <Icon name="arrow" />
            </a>
            {(status === "error" || status === "forbidden") && (
              <button
                onClick={() => {
                  void establishSession();
                }}
              >
                重新检查登录状态
              </button>
            )}
          </>
        )}
      </section>
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
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<Settings />} />
          <Route path="storage" element={<Storage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard/" replace />} />
    </Routes>
  );
}
export default function App() {
  useEffect(() => {
    void establishSession();
  }, []);
  return (
    <LanguageProvider>
      <AppRoutes />
    </LanguageProvider>
  );
}
