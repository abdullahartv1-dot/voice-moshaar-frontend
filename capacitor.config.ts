import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.mostashar.voice",
  appName: "Mostashar Voice",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https",
    // For local dev with --live-reload, set CAPACITOR_LIVE_RELOAD_URL in env
    // and uncomment the url field below pointing to your dev server.
    // url: "http://10.0.2.2:5173",
    // cleartext: true,
  },
  ios: {
    contentInset: "automatic",
  },
  android: {
    backgroundColor: "#0f0d14",
  },
  plugins: {
    StatusBar: {
      backgroundColor: "#0f0d14",
      style: "DARK",
    },
    Keyboard: {
      resize: "body",
      style: "DARK",
    },
  },
}

export default config
