import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, object, useSession } from "./api";
import { Drawer, DrawerPresence, Icon } from "./components";
import { chooseLanguage, languagePreference, useT, type LangPref } from "./i18n";
import s from "./ui.module.scss";
import "./theme.scss";

export type Mode = "system" | "light" | "dark";
// Legacy palette values remain readable while the AzureKiln brand stays fixed.
export type Palette = "green" | "blue" | "rose" | "amber";
const key = "azurekiln.appearance";
const legacyKey = "codebuddy.appearance";
const modes: Mode[] = ["system", "light", "dark"];
export function parseAppearance(raw: string | null): { mode: Mode; palette: Palette } {
  try {
    const value = JSON.parse(raw ?? "null") as { mode?: Mode; palette?: Palette } | null;
    return {
      mode: modes.includes(value?.mode as Mode) ? value!.mode! : "system",
      palette: "blue",
    };
  } catch {
    return { mode: "system", palette: "blue" };
  }
}
function savedAppearance() {
  try {
    return parseAppearance(localStorage.getItem(key) ?? localStorage.getItem(legacyKey));
  } catch {
    return parseAppearance(null);
  }
}
export const useAppearance = create(() => ({ ...savedAppearance(), dark: false, persisted: true }));
export function initializeAppearance() {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const apply = () => {
    const { mode } = useAppearance.getState();
    const dark = mode === "dark" || (mode === "system" && !!media?.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.palette = "blue";
    if (dark !== useAppearance.getState().dark) useAppearance.setState({ dark });
  };
  apply();
  media?.addEventListener("change", apply);
  const unsubscribe = useAppearance.subscribe(apply);
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === legacyKey || event.key === null)
      useAppearance.setState({ ...savedAppearance(), persisted: true });
  };
  window.addEventListener("storage", storage);
  return () => {
    media?.removeEventListener("change", apply);
    unsubscribe();
    window.removeEventListener("storage", storage);
  };
}
export function chooseAppearance(value: Partial<{ mode: Mode; palette: Palette }>) {
  const next = {
    mode: useAppearance.getState().mode,
    ...value,
    palette: "blue" as const,
  };
  let persisted = true;
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    persisted = false;
  }
  useAppearance.setState({ ...next, persisted });
}
/** Save through the API as well, so the CLI and other browsers share the choice. */
function persistLanguage(value: LangPref) {
  if (useSession.getState().status !== "authenticated") return;
  void api
    .get<unknown>("/settings")
    .then((response) =>
      api.patch("/settings", {
        values: { language: value === "system" ? "auto" : value },
        revision: object(response.data).revision,
      }),
    )
    .catch(() => undefined);
}
export function Appearance() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { mode, persisted } = useAppearance();
  useEffect(initializeAppearance, []);
  return (
    <>
      <button
        className={s.appearanceButton}
        aria-label="外观设置"
        title="外观设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="appearance" />
      </button>
      <DrawerPresence>
        {open && (
          <Drawer title="外观设置" className={s.appearanceDrawer} onClose={() => setOpen(false)}>
            <fieldset className={s.appearanceChoices}>
              <legend>显示模式</legend>
              {(
                [
                  ["system", "跟随系统", "system"],
                  ["light", "浅色", "sun"],
                  ["dark", "深色", "moon"],
                ] as const
              ).map(([value, label, icon]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="appearance-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => chooseAppearance({ mode: value })}
                  />
                  <Icon name={icon} />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <p className={s.note}>
              界面采用 CodeBuddy2Api 蓝色。显示模式跟随系统时，会自动响应系统的明暗切换。
            </p>
            {!persisted && <p role="status">浏览器无法保存偏好，本次会话内仍然生效。</p>}
            <fieldset className={s.langChoices}>
              <legend>{t("appearance.language")}</legend>
              {(
                [
                  ["system", t("appearance.lang.system")],
                  ["zh", "中文"],
                  ["en", "EN"],
                ] as [LangPref, string][]
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="ui-language"
                    value={value}
                    checked={languagePreference() === value}
                    onChange={() => {
                      chooseLanguage(value);
                      persistLanguage(value);
                    }}
                  />
                  <span className={s.langDot}>{label}</span>
                </label>
              ))}
            </fieldset>
          </Drawer>
        )}
      </DrawerPresence>
    </>
  );
}
