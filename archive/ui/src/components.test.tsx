import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AppRoutes, Guard } from "./App";
import { api, useSession, type ModelRule } from "./api";
import { CLEAR_CONFIRMATION, ClearLogs } from "./components";
import { ModelEditor, validateRule } from "./pages/Models";
const rule: ModelRule = {
  id: "upstream",
  public_id: "public",
  enabled: true,
  keep_original: false,
  region: "",
  profile: "",
  credential_ids: [],
};
afterEach(() => {
  vi.restoreAllMocks();
  useSession.setState({ status: "checking", csrf: null, error: null });
});
describe("model rules and route preview", () => {
  it("rejects alias collisions and region/profile conflicts", () => {
    expect(
      validateRule({ ...rule, public_id: "other" }, [rule, { ...rule, id: "other" }]),
    ).toContain("冲突");
    expect(validateRule({ ...rule, region: "cn", profile: "intl-cli" }, [rule])).toContain(
      "不匹配",
    );
    expect(validateRule({ ...rule, public_id: " bad" }, [rule])).toContain("空白");
    expect(validateRule(rule, [rule])).toBeNull();
  });
  it("previews unsaved scope and saves with revision", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { candidates: [], excluded: [{ name: "one.info", reason: "人工停用" }] },
    });
    const put = vi.spyOn(api, "put").mockResolvedValue({ data: { revision: 8 } });
    const saved = vi.fn();
    const close = vi.fn();
    render(
      <ModelEditor
        model={rule}
        models={[rule]}
        credentials={[{ id: "account-1", name: "one.info", enabled: false }]}
        revision={7}
        onClose={close}
        onSaved={saved}
      />,
    );
    fireEvent.change(screen.getByLabelText("对外 ID"), { target: { value: "new-id" } });
    fireEvent.click(screen.getByRole("radio", { name: /指定账号/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /one.info/ }));
    fireEvent.click(screen.getByText("预览候选路由"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/models/upstream/preview",
        expect.objectContaining({
          revision: 7,
          public_id: "new-id",
          credential_ids: ["account-1"],
          region: null,
          profile: null,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByText(/人工停用/)).toBeTruthy();
    fireEvent.click(screen.getByText("保存规则"));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/models/upstream",
        expect.objectContaining({ revision: 7, public_id: "new-id" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(saved).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it("retains the editor on rejected save", async () => {
    vi.spyOn(api, "put").mockRejectedValue(new Error("revision rejected"));
    const saved = vi.fn();
    render(
      <ModelEditor
        model={rule}
        models={[rule]}
        credentials={[]}
        revision={1}
        onClose={vi.fn()}
        onSaved={saved}
      />,
    );
    fireEvent.click(screen.getByText("保存规则"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "revision rejected");
    expect(saved).not.toHaveBeenCalled();
  });
});
describe("destructive warnings", () => {
  it("requires the exact full-clear phrase and sends no administrative secret", async () => {
    let resolve!: (value: { data: { ok: boolean } }) => void;
    const post = vi.spyOn(api, "post").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const close = vi.fn();
    const done = vi.fn();
    render(<ClearLogs onClose={close} onDone={done} />);
    fireEvent.change(screen.getByLabelText("清理范围"), { target: { value: "all" } });
    const submit = screen.getByRole("button", { name: "确认不可撤销的清理" });
    expect(submit).toHaveProperty("disabled", true);
    expect(screen.getByText(/将永久删除全部请求明细/)).toBeTruthy();
    expect(screen.queryByLabelText("当前 API key")).toBeNull();
    const confirmation = screen.getByLabelText(`输入“${CLEAR_CONFIRMATION}”`);
    fireEvent.change(confirmation, {
      target: { value: `${CLEAR_CONFIRMATION} ` },
    });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.submit(submit.closest("form")!);
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(confirmation, { target: { value: CLEAR_CONFIRMATION } });
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    expect(post).toHaveBeenCalledExactlyOnceWith("/logs/clear", {
      scope: "all",
      confirmation: CLEAR_CONFIRMATION,
    });
    expect(screen.getByRole("button", { name: "正在清理…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "关闭抽屉" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("清理范围")).toHaveProperty("disabled", true);
    expect(confirmation).toHaveProperty("disabled", true);
    fireEvent.submit(submit.closest("form")!);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(post).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await act(async () => resolve({ data: { ok: true } }));
    expect(done).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a rejected full clear open with its confirmation and supports retry", async () => {
    const post = vi
      .spyOn(api, "post")
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({ data: { ok: true } });
    const close = vi.fn();
    const done = vi.fn();
    render(<ClearLogs onClose={close} onDone={done} />);
    fireEvent.change(screen.getByLabelText("清理范围"), { target: { value: "all" } });
    const confirmation = screen.getByLabelText(`输入“${CLEAR_CONFIRMATION}”`);
    fireEvent.change(confirmation, { target: { value: CLEAR_CONFIRMATION } });
    fireEvent.click(screen.getByRole("button", { name: "确认不可撤销的清理" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "storage unavailable");
    const retry = screen.getByRole("button", { name: "确认不可撤销的清理" });
    expect(retry).toHaveProperty("disabled", false);
    expect(confirmation).toHaveProperty("value", CLEAR_CONFIRMATION);
    expect(done).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith("/logs/clear", {
      scope: "all",
      confirmation: CLEAR_CONFIRMATION,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("ordinary clear preserves statistics and sends no key", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: { ok: true } });
    render(<ClearLogs onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText("仅清空日志明细，保留累计统计")).toBeTruthy();
    fireEvent.click(screen.getByText("确认不可撤销的清理"));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/logs/clear", { scope: "details", confirmation: "" }),
    );
  });
  it("does not treat ok:false as successful clear", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ data: { ok: false } });
    const done = vi.fn();
    render(<ClearLogs onClose={vi.fn()} onDone={done} />);
    fireEvent.click(screen.getByText("确认不可撤销的清理"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "后端未确认清理成功，请检查存储状态",
    );
    expect(done).not.toHaveBeenCalled();
  });
});
function Location() {
  return <output>{useLocation().pathname}</output>;
}
describe("dashboard-prefixed routing", () => {
  it("redirects unauthenticated deep links to login", async () => {
    useSession.setState({ status: "anonymous" });
    render(
      <MemoryRouter initialEntries={["/dashboard/models"]}>
        <Routes>
          <Route element={<Guard />}>
            <Route path="/dashboard/models" element={<p>protected</p>} />
          </Route>
          <Route path="/dashboard/login" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("/dashboard/login")).toBeTruthy();
    expect(screen.queryByText("protected")).toBeNull();
  });
  it("replaces unknown pages with dashboard then login", async () => {
    useSession.setState({ status: "anonymous" });
    render(
      <MemoryRouter initialEntries={["/unknown"]}>
        <AppRoutes />
        <Location />
      </MemoryRouter>,
    );
    expect(await screen.findByText("/dashboard/login")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "登录 CodeBuddy2Api" })).toBeTruthy();
  });
});
