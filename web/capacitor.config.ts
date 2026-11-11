import type { CapacitorConfig } from "@capacitor/cli";

// Native Android shell around the same web app. The web assets are bundled in the APK (so the
// rep app opens offline); the API address is compiled in with VITE_API_BASE at build time.
const config: CapacitorConfig = {
  appId: "ly.goldenchips.erp",
  appName: "GOLDEN ERP",
  webDir: "dist",
  android: { allowMixedContent: false },
  server: { androidScheme: "https" },
};
export default config;
