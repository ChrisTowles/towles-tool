export default defineNuxtConfig({
  compatibilityDate: "2025-01-01",
  devtools: { enabled: true },
  modules: ["@nuxtjs/tailwindcss"],
  vite: {
    optimizeDeps: {
      include: ["vuedraggable", "@xterm/xterm", "@xterm/addon-fit", "@vueuse/core"],
    },
  },
  nitro: {
    experimental: {
      websocket: true,
    },
  },
  devServer: {
    host: process.env.AGENTBOARD_LAN === "1" ? "0.0.0.0" : "127.0.0.1",
    port: 4200,
  },
  app: {
    head: {
      title: "AgentBoard",
      link: [
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap",
        },
      ],
    },
  },
});
