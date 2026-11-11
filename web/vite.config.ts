import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Installable app (Android "Add to home screen" / Install). The app shell is cached so the
    // rep app opens with no connection; API calls are NEVER cached by the service worker
    // (tenant data must not linger in shared caches) — the rep app keeps its own offline queue.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/apple-touch-icon.png"],
      manifest: {
        name: "GOLDEN ERP", short_name: "GOLDEN ERP", description: "نظام تخطيط موارد المؤسسات — الرقائق الذهبية",
        lang: "ar", dir: "rtl", start_url: "/", scope: "/", display: "standalone", orientation: "any",
        background_color: "#f5f6f8", theme_color: "#7B3F00",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "يومي (المندوب)", short_name: "يومي", url: "/field" },
          { name: "بوابتي (الحضور والراتب)", short_name: "بوابتي", url: "/me" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/iclock\//],
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff2}"],
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//, handler: "StaleWhileRevalidate", options: { cacheName: "fonts", expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } } },
        ],
      },
    }),
  ],
  server: { port: 5173, proxy: { "/api": "http://localhost:4000" } },
});
