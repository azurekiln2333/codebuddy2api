import { useState } from "react";
import { api, errorMessage, number, object, text, useResource } from "../api";
import { useT } from "../i18n";
import {
  Badge,
  ClearLogs,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
} from "../components";
import s from "../ui.module.scss";

function normalize(value: unknown) {
  return object(value, "存储状态");
}

// The console and the admin API share one origin behind the gateway, so a route
// that is not wired up in this deployment surfaces as a redirect back to the
// overview, a 404, or an HTML document instead of JSON. Turn those into an
// actionable deployment notice instead of a bare "not found" or a raw contract
// error. The wording stays about routing/deployment in general: it is not tied
// to any single page or to a gateway page whitelist.
const SPA_INDEX_MARKERS = ["<!doctype html", "<html", '<div id="root"'];
export function routeFailureMessage(
  error: unknown,
  options: { documentUrl?: string; status?: number | null; apiPath?: string } = {},
) {
  const status = options.status ?? null;
  const apiPath = options.apiPath ?? "/admin/storage";
  const documentUrl = options.documentUrl ?? "";
  const escaped = apiPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const servedByApi = new RegExp(`${escaped}/?(?:[?#].*)?$`);
  const viaRedirect =
    status === 302 || status === 301 || (documentUrl !== "" && !servedByApi.test(documentUrl));
  if (viaRedirect)
    return "页面暂时不可用：当前部署没有把该路由交给控制台，访问会被重定向回概览。请确认网关已放行该页面与对应接口。";
  if (status === 404)
    return `接口暂时不可用：当前部署没有提供 GET ${apiPath}。请确认后端已部署该接口，并且网关已放行。`;
  const message = errorMessage(error);
  if (SPA_INDEX_MARKERS.some((marker) => message.toLowerCase().includes(marker)))
    return "接口暂时不可用：该地址返回的是页面内容而不是接口数据，通常是网关没有把这个接口转发给后端。";
  return message;
}

function bytes(value: unknown): string {
  const n = number(value);
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function ArchivePanel({ archives, reload }: { archives: unknown[]; reload: () => void }) {
  const t = useT();
  // Default shorter than the 30-day retention window so opening the page (which
  // prunes expired rows) still leaves older in-retention logs to archive.
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  return (
    <Panel title={t("storage.archive")} hint={t("storage.archiveHint")}>
      <div className={s.panelBody}>
        <form
          className={s.archiveForm}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setResult(null);
            void api
              .post("/storage/archive", { days })
              .then((response) => {
                const d = object(response.data, t("storage.archiveResult"));
                const count = (number(d.archived_requests) ?? 0) + (number(d.archived_events) ?? 0);
                setResult(
                  count === 0
                    ? t("storage.archiveEmpty", { days })
                    : t("storage.archiveDone", { count, file: text(d.file) }),
                );
                reload();
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          <label className={s.field}>
            {t("storage.archiveDays")}
            <input
              type="number"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(3650, Number(e.target.value) || 1)))}
            />
          </label>
          <button className={s.primary} disabled={busy}>
            {busy ? t("storage.archiveBusy") : t("storage.archiveSubmit")}
          </button>
        </form>
        {result && <p className={s.resultNote}>{result}</p>}
        <ErrorNotice message={error} />
        <div className={s.storageSection}>
          <div className={s.storageSectionHead}>
            <strong>{t("storage.archives")}</strong>
            <span>{archives.length}</span>
          </div>
          {archives.length ? (
            <ul className={s.archiveList}>
              {archives.map((name) => (
                <li key={String(name)}>{text(name)}</li>
              ))}
            </ul>
          ) : (
            <Empty title={t("storage.archivesEmpty")} />
          )}
        </div>
      </div>
    </Panel>
  );
}

export function Storage() {
  const t = useT();
  const resource = useResource("/storage", normalize);
  const [clearing, setClearing] = useState(false);
  const d = resource.data;
  const unavailable = resource.error ? routeFailureMessage(resource.error) : null;
  const reclaimable = number(d?.reclaimable_bytes);
  const archives = Array.isArray(d?.archives) ? d.archives : [];
  const stateLabel =
    d?.degraded === true
      ? t("storage.stateDegraded")
      : d?.degraded === false
        ? t("dash.status.normal")
        : t("storage.stateUnknown");
  return (
    <>
      <PageTitle
        title={t("storage.title")}
        description={t("storage.desc")}
        actions={
          <>
            {d && (
              <Badge tone={d.degraded === true ? "bad" : d.degraded === false ? "good" : "neutral"}>
                {t("storage.status")} · {stateLabel}
              </Badge>
            )}
            <button onClick={resource.reload}>
              <Icon name="refresh" />
              {t("dash.refresh")}
            </button>
          </>
        }
      />
      <ResourceState {...resource} error={unavailable} />
      {!d && unavailable && (
        <Panel title={t("storage.title")} hint={t("storage.stateUnavailable")}>
          <div className={s.panelBody}>
            <p className={s.storageLead}>{unavailable}</p>
            <small className={s.storageSubtle}>{t("storage.unavailableHint")}</small>
          </div>
        </Panel>
      )}
      {d && (
        <>
          <div className={s.kpiGrid}>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.dbFile")}</span>
                <span>
                  <Icon name="database" />
                </span>
              </div>
              <strong>{bytes(d.db_bytes)}</strong>
              <small>
                {t("storage.counts", {
                  requests: number(d.request_count) ?? "—",
                  events: number(d.event_count) ?? "—",
                  days: number(d.retention_days) ?? "—",
                })}
              </small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.walFile")}</span>
                <span>
                  <Icon name="logs" />
                </span>
              </div>
              <strong>{bytes(d.wal_bytes)}</strong>
              <small>SHM {bytes(d.shm_bytes)}</small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.logical")}</span>
                <span>
                  <Icon name="cache" />
                </span>
              </div>
              <strong>{bytes(d.logical_bytes)}</strong>
              <small>{d.pending_cleanup === true ? t("storage.pendingCleanup") : stateLabel}</small>
            </article>
            <article className={s.kpiCard}>
              <div>
                <span>{t("storage.reclaimable")}</span>
                <span>
                  <Icon name="leaf" />
                </span>
              </div>
              <strong>{bytes(d.reclaimable_bytes)}</strong>
              <small>
                {number(d.freelist_pages) ?? 0} / {number(d.page_count) ?? 0} pages
              </small>
            </article>
          </div>
          <div className={s.storageSplit}>
            <ArchivePanel archives={archives} reload={resource.reload} />
            <Panel title={t("storage.vacuum")} hint={t("storage.cleanup")}>
              <div className={s.panelBody}>
                <p className={s.storageLead}>
                  {t("storage.vacuumDesc", {
                    reclaimable:
                      reclaimable !== null && reclaimable > 0
                        ? t("storage.vacuumReclaim", { size: bytes(reclaimable) })
                        : "",
                  })}
                </p>
                <pre className={s.codeBlock}>
                  {`${t("storage.step.stop")}
docker compose down        ${t("storage.step.stopLocal")}

${t("storage.step.vacuum")}
sqlite3 "\${CODEBUDDY_AUTH_DIR:-auth}/logs.sqlite3" \\
  "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"

${t("storage.step.restart")}
docker compose up -d`}
                </pre>
                <small className={s.storageSubtle}>{t("storage.vacuumNote")}</small>
                <div className={s.cleanupBox}>
                  <div>
                    <strong>{t("storage.cleanup")}</strong>
                    <p>{t("storage.cleanupDesc")}</p>
                  </div>
                  <button type="button" onClick={() => setClearing(true)}>
                    {t("storage.cleanupOpen")}
                  </button>
                </div>
              </div>
            </Panel>
          </div>
        </>
      )}
      <DrawerPresence>
        {clearing && (
          <ClearLogs onClose={() => setClearing(false)} onDone={() => resource.reload()} />
        )}
      </DrawerPresence>
    </>
  );
}
