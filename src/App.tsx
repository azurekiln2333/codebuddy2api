import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { endSession, establishSession, errorMessage, SSO_LOGIN_URL, useSession } from "./api";
import { Drawer, ErrorNotice, Icon } from "./components";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Credentials } from "./pages/Credentials";
import { Logs } from "./pages/Logs";
import { Settings } from "./pages/Settings";
import { Storage } from "./pages/Storage";
import { Appearance } from "./appearance";
import s from "./ui.module.scss";
import { LanguageProvider, useT } from "./i18n";

const navigationGroups = [
  {
    title: "app.navGroup.workspace",
    items: [
      ["", "nav.overview", "grid"],
      ["/logs", "nav.logs", "logs"],
    ],
  },
  {
    title: "app.navGroup.resources",
    items: [
      ["/credentials", "nav.credentials", "key"],
      ["/models", "nav.models", "model"],
    ],
  },
  {
    title: "app.navGroup.system",
    items: [
      ["/storage", "nav.storage", "database"],
      ["/settings", "nav.settings", "settings"],
    ],
  },
];
const navigation = navigationGroups.flatMap((group) => group.items);
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
  const user = useSession((state) => state.user);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  const renderNavigation = (inDrawer = false) => (
    <nav
      id={inDrawer ? "mobile-navigation" : "workspace-navigation"}
      aria-label={t("app.primaryNav")}
    >
      {navigationGroups.map((group) => (
        <div className={s.navGroup} key={group.title}>
          <p className={s.navLabel}>{t(group.title)}</p>
          {group.items.map(([path, labelKey, icon]) => {
            const label = t(labelKey);
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
                <Icon name={icon} />
                <span className={s.navText}>{label}</span>
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
  return (
    <div className={`${s.app} ${collapsed ? s.collapsed : ""}`}>
      <a href="#main" className={s.skip}>
        {t("app.skip")}
      </a>
      <header className={s.header}>
        <div className={s.headerBrand}>
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
          <NavLink className={s.brand} to="/dashboard/" aria-label={t("app.brandAria")}>
            <span className={s.brandIcon}>
              <BrandMark />
            </span>
            <span className={s.brandText}>AzureKiln</span>
          </NavLink>
          <span className={s.headerContext}>{t("app.brandSubtitle")}</span>
        </div>
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
      {!mobile && (
        <aside className={s.sidebar}>
          <div className={s.sidebarWorkspace}>
            <span className={s.workspaceSymbol}>
              <Icon name="shield" />
            </span>
            <div className={s.workspaceLabel}>
              <strong>{t("app.adminWorkspace")}</strong>
              <small>{t("app.administrator")}</small>
            </div>
          </div>
          {renderNavigation()}
          <div className={s.sidebarFoot}>
            <span className={s.statusDot} />
            <span>{t("app.adminSession")}</span>
          </div>
        </aside>
      )}
      {mobile && navigationOpen && (
        <Drawer
          title={t("app.primaryNav")}
          className={s.navigationDrawer}
          onClose={() => setNavigationOpen(false)}
        >
          {renderNavigation(true)}
        </Drawer>
      )}
      <div className={s.workspace}>
        <main id="main" className={s.main}>
          <div className={s.breadcrumb} aria-label={t("app.breadcrumb")}>
            <span>{t("app.workspace")}</span>
            <span aria-hidden="true">/</span>
            <span>
              {t(
                navigation.find(
                  ([path]) => `/dashboard${path}` === location.pathname.replace(/\/$/, ""),
                )?.[1] ?? "nav.overview",
              )}
            </span>
          </div>
          <ErrorNotice message={error} />
          <Outlet />
        </main>
        <footer className={s.footer}>AzureKiln · {t("app.brandSubtitle")}</footer>
      </div>
    </div>
  );
}
function Login() {
  const t = useT();
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
        <h1>{t("app.brandSubtitle")}</h1>
        <p>{t("login.description")}</p>
      </section>
      <section className={s.loginCard}>
        <Icon name="shield" />
        <h2>{status === "forbidden" ? t("app.accessDenied") : t("login.azurekilnSignIn")}</h2>
        <p>{t("login.accessHint")}</p>
        {status === "checking" ? (
          <p role="status">{t("app.verifying")}</p>
        ) : (
          <>
            <ErrorNotice message={error} />
            <a className={`${s.linkButton} ${s.primary}`} href={SSO_LOGIN_URL}>
              {status === "forbidden" ? t("app.otherAccount") : t("login.ssoSignIn")}
              <Icon name="arrow" />
            </a>
            {(status === "error" || status === "forbidden") && (
              <button
                onClick={() => {
                  void establishSession();
                }}
              >
                {t("login.recheck")}
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
