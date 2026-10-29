import { useId, useState } from "react";
import { api, errorMessage, list, object, text, useResource, type RecordValue } from "../api";
import {
  Badge,
  Empty,
  ErrorNotice,
  Fields,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
} from "../components";
import s from "../ui.module.scss";
import m from "../management.module.scss";
import { t, useT } from "../i18n";
type Setting = {
  key: string;
  value: unknown;
  stored: unknown;
  source: string;
  mode: string;
  type: string;
  label: string;
  choices?: unknown[];
  min?: number;
  max?: number;
  locked: boolean;
};
const sourceLabels: Record<string, string> = {
  cli: "settings.source.cli",
  environment: "settings.source.environment",
  env: "settings.source.environment",
  dotenv: "settings.source.dotenv",
  generated: "settings.source.generated",
  management: "settings.source.management",
  default: "settings.source.default",
  internal: "settings.source.internal",
};
const modeLabels: Record<string, string> = {
  hot: "settings.mode.hot",
  restart: "settings.mode.restart",
  startup: "settings.mode.startup",
  readonly: "settings.mode.readonly",
};
function displayValue(value: unknown) {
  return typeof value === "boolean"
    ? t(value ? "settings.enabled" : "settings.disabled")
    : text(value);
}
const settingSections = [
  {
    key: "service",
    title: "settings.section.service",
    description: "settings.section.serviceHint",
  },
  {
    key: "routing",
    title: "settings.section.routing",
    description: "settings.section.routingHint",
  },
  { key: "data", title: "settings.section.data", description: "settings.section.dataHint" },
  { key: "other", title: "settings.section.other", description: "settings.section.otherHint" },
];
function sectionFor(key: string) {
  if (/log|audit|cache|storage|retention|history|database|sqlite/.test(key)) return "data";
  if (/model|route|retry|cooldown|concurr|rate|pool|balance|credential|account|checkin/.test(key))
    return "routing";
  if (/host|port|proxy|timeout|url|endpoint|worker|listen|debug|language/.test(key))
    return "service";
  return "other";
}
function normalize(value: unknown): {
  revision: number;
  items: Setting[];
  audit: RecordValue;
  session: RecordValue;
} {
  const d = object(value);
  if (typeof d.revision !== "number") throw new Error("设置响应缺少 revision");
  const items = list(d.items).map((item) => {
    if (
      typeof item.key !== "string" ||
      typeof item.locked !== "boolean" ||
      typeof item.type !== "string" ||
      typeof item.source !== "string" ||
      typeof item.mode !== "string" ||
      !("value" in item) ||
      !("stored" in item)
    )
      throw new Error("设置 schema 字段不完整");
    return {
      key: item.key,
      value: item.value,
      stored: item.stored,
      source: item.source,
      mode: item.mode,
      type: item.type,
      label: typeof item.label === "string" ? item.label : item.key,
      locked: item.locked,
      choices: Array.isArray(item.choices) ? item.choices : undefined,
      min: typeof item.min === "number" ? item.min : undefined,
      max: typeof item.max === "number" ? item.max : undefined,
    };
  });
  return {
    revision: d.revision,
    items,
    audit: object(d.audit, "审计状态"),
    session: object(d.session ?? {}, "会话存储状态"),
  };
}
function SettingsForm({
  data,
  reload,
}: {
  data: ReturnType<typeof normalize>;
  reload: () => void;
}) {
  const t = useT();
  const [values, setValues] = useState<RecordValue>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const groups: [string, string, Setting[]][] = [
    ["editable", t("settings.category.editable"), []],
    ["external", t("settings.category.external"), []],
    ["system", t("settings.category.system"), []],
  ];
  for (const item of data.items) {
    // Administrative credentials belong to the gateway's server configuration.
    if (item.key === "api_key") continue;
    if (item.key === "model_guard" || item.key === "model_capability_guard") continue;
    if (!item.locked) groups[0][2].push(item);
    else if (["cli", "environment", "env", "dotenv"].includes(item.source)) groups[1][2].push(item);
    else groups[2][2].push(item);
  }
  const [tab, setTab] = useState(groups[0][2].length ? "editable" : "external");
  const visible = groups.find(([key]) => key === tab)?.[2] ?? [];
  const emptyTitles: Record<string, string> = {
    editable: t("settings.empty.editable"),
    external: t("settings.empty.external"),
    system: t("settings.empty.system"),
  };
  const categoryDetails: Record<string, { title: string; hint: string; icon: string }> = {
    editable: {
      title: t("settings.editableTitle"),
      hint: t("settings.editableHint"),
      icon: "settings",
    },
    external: {
      title: t("settings.externalTitle"),
      hint: t("settings.externalHint"),
      icon: "shield",
    },
    system: {
      title: t("settings.systemTitle"),
      hint: t("settings.systemHint"),
      icon: "system",
    },
  };
  const selectedCategory = categoryDetails[tab];
  const count = Object.keys(values).length;
  const update = (item: Setting, value: unknown) => {
    setSaved(false);
    setValues((old) => {
      const next = { ...old };
      if (value === (item.stored ?? item.value)) delete next[item.key];
      else next[item.key] = value;
      return next;
    });
  };
  return (
    <form
      className={m.settingsForm}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        void api
          .patch("/settings", { revision: data.revision, values })
          .then(() => {
            setValues({});
            setSaved(true);
            reload();
          })
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setBusy(false));
      }}
    >
      <div className={m.settingsLayout}>
        <aside className={m.settingsNavigation}>
          <p className={m.navigationLabel}>{t("settings.navigation")}</p>
          <div
            className={m.categoryList}
            role="tablist"
            aria-label={t("settings.groups")}
            aria-orientation="vertical"
          >
            {groups.map(([key, label, rows]) => (
              <button
                key={key}
                id={`${id}-${key}`}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls={`${id}-content`}
                tabIndex={tab === key ? 0 : -1}
                className={tab === key ? m.categoryActive : ""}
                onClick={() => setTab(key)}
                onKeyDown={(e) => {
                  const index = groups.findIndex(([groupKey]) => groupKey === key);
                  let next = index;
                  if (["ArrowDown", "ArrowRight"].includes(e.key))
                    next = (index + 1) % groups.length;
                  else if (["ArrowUp", "ArrowLeft"].includes(e.key))
                    next = (index + groups.length - 1) % groups.length;
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = groups.length - 1;
                  else return;
                  e.preventDefault();
                  setTab(groups[next][0]);
                  document.getElementById(`${id}-${groups[next][0]}`)?.focus();
                }}
              >
                <Icon name={categoryDetails[key].icon} />
                <span>
                  {label}（{rows.length}）
                </span>
              </button>
            ))}
          </div>
          <p className={m.navigationHint}>{t("settings.navigationHint")}</p>
        </aside>
        <div
          className={m.settingsContent}
          role="tabpanel"
          id={`${id}-content`}
          aria-labelledby={`${id}-${tab}`}
        >
          <div className={m.settingsIntro}>
            <div>
              <h2>{selectedCategory.title}</h2>
              <p>{selectedCategory.hint}</p>
            </div>
            <span className={m.sectionCount}>{t("settings.itemCount", { n: visible.length })}</span>
          </div>
          <section className={m.settingsPanel} aria-label={t("settings.items")}>
            {!visible.length && <Empty title={emptyTitles[tab]} />}
            {settingSections.map((section) => {
              const items = visible.filter((item) => sectionFor(item.key) === section.key);
              if (!items.length) return null;
              return (
                <section key={section.key} className={m.settingSection}>
                  <div className={m.sectionHeading}>
                    <h3>{t(section.title)}</h3>
                    <p>{t(section.description)}</p>
                  </div>
                  {items.map((item) => {
                    const value = Object.hasOwn(values, item.key)
                      ? values[item.key]
                      : (item.stored ?? item.value);
                    const knownType = [
                      "boolean",
                      "bool",
                      "integer",
                      "int",
                      "number",
                      "float",
                      "string",
                      "str",
                    ].includes(item.type);
                    const numeric = ["integer", "int", "number", "float"].includes(item.type);
                    const boolean = ["boolean", "bool"].includes(item.type);
                    const concealed =
                      item.locked && ["secret", "paths", "path"].includes(item.type);
                    const pendingValue =
                      item.stored !== null &&
                      item.stored !== undefined &&
                      item.stored !== item.value;
                    return (
                      <div className={m.settingRow} key={item.key}>
                        <div className={`${s.settingDescription} ${m.settingDescription}`}>
                          <strong title={item.key}>{item.label}</strong>
                          {item.label !== item.key && (
                            <code className={m.settingKey}>{item.key}</code>
                          )}
                          {item.key === "model_capability_guard" && (
                            <small>
                              仅关闭新增能力预检；元数据展示、国际图片归并及其他安全限制不变，新请求生效。
                            </small>
                          )}
                          <div className={s.actions}>
                            <Badge>
                              {t(sourceLabels[item.source] ?? "settings.source.unknown")}
                            </Badge>
                            <Badge tone={item.mode === "hot" ? "good" : "warn"}>
                              {t(modeLabels[item.mode] ?? "settings.mode.unknown")}
                            </Badge>
                            {item.locked && item.source !== "internal" && (
                              <Badge tone="warn">{t("settings.category.external")}</Badge>
                            )}
                          </div>
                          {!concealed && (item.locked || pendingValue) && (
                            <small>
                              {t("settings.effectiveValue", { value: displayValue(item.value) })}
                            </small>
                          )}
                          {!concealed && pendingValue && (
                            <small>
                              {t("settings.storedValue", { value: displayValue(item.stored) })}
                            </small>
                          )}
                        </div>
                        <div className={`${s.settingControl} ${m.settingControl}`}>
                          {item.locked ? (
                            item.source !== "internal" && (
                              <p className={s.note}>{t("settings.changeAtStartup")}</p>
                            )
                          ) : !knownType && !item.choices ? (
                            <p className={s.note}>{t("settings.unsupported")}</p>
                          ) : (
                            <label className={s.field}>
                              <span className={s.srOnly}>{item.label}</span>
                              {item.choices ? (
                                <select
                                  value={JSON.stringify(value)}
                                  onChange={(e) =>
                                    update(item, JSON.parse(e.target.value) as unknown)
                                  }
                                >
                                  {!item.choices.some(
                                    (choice) => JSON.stringify(choice) === JSON.stringify(value),
                                  ) && (
                                    <option value={JSON.stringify(value)} disabled>
                                      {text(value)}
                                    </option>
                                  )}
                                  {item.choices.map((choice) => (
                                    <option
                                      value={JSON.stringify(choice)}
                                      key={JSON.stringify(choice)}
                                    >
                                      {text(choice)}
                                    </option>
                                  ))}
                                </select>
                              ) : boolean ? (
                                <span className={s.check}>
                                  <input
                                    type="checkbox"
                                    checked={value === true}
                                    onChange={(e) => update(item, e.target.checked)}
                                  />
                                  {t(value === true ? "settings.enabled" : "settings.disabled")}
                                </span>
                              ) : (
                                <input
                                  type={numeric ? "number" : "text"}
                                  value={value === null || value === undefined ? "" : text(value)}
                                  min={item.min}
                                  max={item.max}
                                  step={["int", "integer"].includes(item.type) ? 1 : "any"}
                                  required={numeric}
                                  onChange={(e) =>
                                    update(
                                      item,
                                      numeric
                                        ? e.target.value === ""
                                          ? ""
                                          : Number(e.target.value)
                                        : e.target.value,
                                    )
                                  }
                                />
                              )}
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </section>
          <div className={m.settingsFooter}>
            <div aria-live="polite">
              <strong>
                {count
                  ? t("settings.pendingCount", { n: count })
                  : saved
                    ? t("settings.saved")
                    : t("settings.noChanges")}
              </strong>
              <p>{t("settings.saveHint")}</p>
            </div>
            <button className={s.primary} disabled={!count || busy}>
              {busy ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
          <ErrorNotice message={error} />
          {data.session.degraded === true && (
            <Panel title="会话存储">
              <Badge tone="bad">撤销未生效</Badge>
              <p>
                会话快照无法写入或清除，退出登录可能未真正生效。请检查管理目录权限后重试退出登录。
              </p>
              <details className={s.chartData}>
                <summary>查看存储详情</summary>
                <Fields data={data.session} />
              </details>
            </Panel>
          )}
        </div>
      </div>
    </form>
  );
}
export function Settings() {
  const t = useT();
  const resource = useResource("/settings", normalize);
  return (
    <>
      <PageTitle
        title={t("nav.settings")}
        description={t("settings.description")}
        actions={
          <button onClick={resource.reload}>
            <Icon name="refresh" />
            {t("settings.reload")}
          </button>
        }
      />
      <ResourceState {...resource} />
      {resource.data && <SettingsForm data={resource.data} reload={resource.reload} />}
    </>
  );
}
