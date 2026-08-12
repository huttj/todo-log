// Theme: system-follow by default, with a per-device override.
export type ThemePref = "system" | "light" | "dark";

const KEY = "todolog.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function setThemePref(pref: ThemePref) {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  applyTheme();
}

export function applyTheme() {
  const pref = getThemePref();
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
}

media.addEventListener("change", () => {
  if (getThemePref() === "system") applyTheme();
});
