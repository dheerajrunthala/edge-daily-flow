import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";

export const themeInitScript = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

const Ctx = createContext<{ theme: ThemePref; setTheme: (t: ThemePref) => void }>({
  theme: "system",
  setTheme: () => {},
});

function apply(t: ThemePref) {
  const dark =
    t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>("system");
  useEffect(() => {
    setThemeState((localStorage.getItem("theme") as ThemePref) || "system");
  }, []);
  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => apply("system");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [theme]);
  const setTheme = useCallback((t: ThemePref) => {
    localStorage.setItem("theme", t);
    setThemeState(t);
  }, []);
  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
