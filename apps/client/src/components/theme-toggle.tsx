import { useAtomValue } from "@/lib/atoms/react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { themeAtom, setTheme } from "@/lib/theme";

/** Flips between explicit light and dark. "system" resolves against the OS
 * preference here so the first click always inverts what's on screen. */
export function ThemeToggle() {
  const theme = useAtomValue(themeAtom);

  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  return (
    <Button
      variant="outline"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
      icon={resolved === "dark" ? <SunIcon /> : <MoonIcon />}
    />
  );
}
