import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

/** Browser-dev fallback: `app.getVersion()` needs the Tauri host. */
const DEV_VERSION = "0.1.0";

export function useAppVersion(): string {
  const [version, setVersion] = useState(DEV_VERSION);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void import("@tauri-apps/api/app").then(async ({ getVersion }) => {
      const v = await getVersion();
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return `tt v${version}`;
}
