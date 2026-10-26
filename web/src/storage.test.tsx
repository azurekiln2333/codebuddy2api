// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Storage, routeFailureMessage } from "./pages/Storage";

const storagePayload = {
  degraded: false,
  db_bytes: 5 * 1024 * 1024,
  wal_bytes: 1024,
  shm_bytes: 32,
  logical_bytes: 2 * 1024 * 1024,
  request_count: 120,
  event_count: 8,
  retention_days: 30,
  page_count: 1300,
  freelist_pages: 512,
  reclaimable_bytes: 512 * 4096,
  pending_cleanup: false,
  archives: ["audit-20260901-000000-abcdef12.jsonl"],
};

afterEach(() => vi.restoreAllMocks());

describe("storage page", () => {
  it("shows sizes with reclaimable estimate and archives old logs on demand", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: storagePayload });
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { ok: true, archived_requests: 4, archived_events: 2, file: "audit-x.jsonl" },
    });
    render(<Storage />);
    expect(await screen.findByText("可回收空间")).toBeTruthy();
    expect(screen.getAllByText("2.0 MB").length).toBeGreaterThan(0);
    expect(screen.getByText(/约可回收 2.0 MB/)).toBeTruthy();
    expect(screen.getByText("audit-20260901-000000-abcdef12.jsonl")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "归档并删除" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/storage/archive", { days: 7 }));
    expect(await screen.findByText(/已归档 6 条/)).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
  it("shows an actionable notice when the gateway page whitelist lacks storage", async () => {
    vi.spyOn(api, "get").mockImplementation((path: string) =>
      path === "/storage"
        ? Promise.reject(
            Object.assign(new Error("Request failed"), {
              isAxiosError: true,
              response: { status: 404, data: { detail: "Not Found" } },
            }),
          )
        : Promise.resolve({ data: storagePayload }),
    );
    render(<Storage />);
    expect(await screen.findByText(/页面暂不可用/)).toBeTruthy();
  });

  it("explains a route or API that is not deployed instead of a bare not-found", () => {
    // Generic routing/deployment wording: no page whitelist, no storage-only text.
    const redirected = routeFailureMessage(null, { status: 302 });
    expect(redirected).toContain("重定向");
    expect(redirected).not.toContain("白名单");
    expect(routeFailureMessage(null, { status: 404 })).toContain("GET /admin/storage");
    const html = routeFailureMessage(new Error('<!doctype html><div id="root">'));
    expect(html).toContain("接口暂时不可用");
    expect(html).not.toContain("白名单");
    // The same helper serves any console route, not just storage.
    expect(routeFailureMessage(null, { status: 404, apiPath: "/admin/logs" })).toContain(
      "GET /admin/logs",
    );
    expect(routeFailureMessage(new Error("网络不可用"))).toBe("网络不可用");
  });
});

const asMarker = (value: unknown) => value as { marker: string };
const CACHE_OPTS = { cache: true };

describe("cached resources", () => {
  function Probe({ path }: { path: string }) {
    const { data, loading } = useResource(path, asMarker, CACHE_OPTS);
    if (loading || !data) return <span>加载中</span>;
    return <span>{data.marker}</span>;
  }

  it("renders the cached snapshot immediately on remount while refreshing", async () => {
    let call = 0;
    const get = vi
      .spyOn(api, "get")
      .mockImplementation(
        (path: string) =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { marker: `fresh-${path}-${++call}` } }), 5),
          ),
      );
    const first = render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-1")).toBeTruthy();
    first.unmount();
    // Second mount: cached value shows synchronously, then the fresh GET replaces it.
    render(<Probe path="/cache-probe" />);
    expect(screen.queryByText("加载中")).toBeNull();
    expect(screen.getByText("fresh-/cache-probe-1")).toBeTruthy();
    expect(await screen.findByText("fresh-/cache-probe-2")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
