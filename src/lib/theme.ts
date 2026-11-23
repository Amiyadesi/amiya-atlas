import { get, writable, readonly } from "svelte/store";

export type Theme = "light" | "dark";
export type Preference = "system" | Theme;
export const themeNames = {
  system: "跟随系统",
  light: "浅色",
  dark: "暗色",
} as const;
const key = "relakeep:theme";
const preference = writable<Preference>("system");
const resolved = writable<Theme>("light");
export const themePreference = readonly(preference);
export const resolvedTheme = readonly(resolved);

export function initTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function read() {
    const value = localStorage.getItem(key);
    preference.set(value === "light" || value === "dark" ? value : "system");
  }
  function apply() {
    const value = get(preference);
    const theme =
      value === "system" ? (media.matches ? "dark" : "light") : value;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    resolved.set(theme);
  }
  const sync = (event: StorageEvent) => {
    if (event.key === key || event.key === null) read();
  };
  read();
  const unsubscribe = preference.subscribe(apply);
  media.addEventListener("change", apply);
  window.addEventListener("storage", sync);
  return () => {
    unsubscribe();
    media.removeEventListener("change", apply);
    window.removeEventListener("storage", sync);
  };
}

export function setTheme(value: Preference) {
  localStorage.setItem(key, value);
  preference.set(value);
}
export function cycleTheme() {
  setTheme(
    ({ system: "light", light: "dark", dark: "system" } as const)[
      get(preference)
    ],
  );
}
