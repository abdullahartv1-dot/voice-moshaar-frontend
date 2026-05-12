import { useCallback, useEffect, useState } from "react"

/**
 * Per-user Moshaar MCP credentials, kept in localStorage so each browser
 * session remembers its own key. NEVER sent anywhere except as query
 * params on the conversation WebSocket connection, where the backend
 * holds them in memory for the call duration only.
 *
 * The default endpoint can be overridden via VITE_DEFAULT_MCP_URL.
 */

const STORAGE_KEY = "moshaar:mcp:v1"
// Custom event so all useMoshaarMCP() hooks stay in sync within the
// same tab. The browser's built-in "storage" event only fires for
// OTHER tabs, not the tab that called setItem. We dispatch our own
// "moshaar-mcp:changed" event after every write so the dialog → page
// → header buttons all refresh together.
const CHANGE_EVENT = "moshaar-mcp:changed"

const DEFAULT_URL =
  (import.meta.env.VITE_DEFAULT_MCP_URL as string | undefined) ||
  "https://api.moshaar.com/v2/mcp/master"

export interface MoshaarMCPConfig {
  url: string
  key: string
}

interface StoredMCP {
  url?: string
  key?: string
}

function read(): StoredMCP {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    return parsed as StoredMCP
  } catch {
    return {}
  }
}

function write(value: StoredMCP) {
  try {
    if (!value.url && !value.key) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    }
  } catch {
    // ignore (private mode etc.)
  }
  // Broadcast so every other useMoshaarMCP() hook in this tab can
  // refresh its in-memory copy (the browser's built-in 'storage'
  // event doesn't fire for same-tab writes).
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new Event(CHANGE_EVENT))
    } catch {
      // ignore
    }
  }
}

export function useMoshaarMCP() {
  const [url, setUrlState] = useState<string>(DEFAULT_URL)
  const [key, setKeyState] = useState<string>("")
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // Initial load from localStorage
    const refresh = () => {
      const stored = read()
      setUrlState(stored.url || DEFAULT_URL)
      setKeyState(stored.key || "")
    }
    refresh()
    setLoaded(true)

    // Listen for in-tab + cross-tab changes so all hook instances stay
    // in sync. Without this, the settings dialog can save the key but
    // the page (which has its own useState copy) keeps the old value
    // until a hard reload.
    if (typeof window !== "undefined") {
      window.addEventListener(CHANGE_EVENT, refresh)
      window.addEventListener("storage", refresh)
      return () => {
        window.removeEventListener(CHANGE_EVENT, refresh)
        window.removeEventListener("storage", refresh)
      }
    }
  }, [])

  const save = useCallback((nextUrl: string, nextKey: string) => {
    const cleanUrl = nextUrl.trim() || DEFAULT_URL
    const cleanKey = nextKey.trim()
    setUrlState(cleanUrl)
    setKeyState(cleanKey)
    write({ url: cleanUrl, key: cleanKey })
  }, [])

  const clear = useCallback(() => {
    setUrlState(DEFAULT_URL)
    setKeyState("")
    write({})
  }, [])

  const isConnected = Boolean(key.trim())

  return { url, key, isConnected, loaded, save, clear }
}

/**
 * Lightweight server-side check: hit the MCP endpoint with a
 * `tools/list` request and see if it returns 200 + a tools array.
 * Used by the settings dialog's "Test connection" button.
 *
 * Note: This works because the MCP server CORS-allows browser origins
 * for read-only methods. If CORS blocks, the user just won't see the
 * green check — but it still works at call time (server-side).
 */
export async function testMCPConnection(
  url: string,
  key: string,
): Promise<{ ok: true; toolsCount: number } | { ok: false; error: string }> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-mcp-api-key": key,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    })
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: "المفتاح غير صحيح أو منتهي." }
    }
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` }
    }
    const data = await resp.json()
    const tools = data?.result?.tools
    if (!Array.isArray(tools)) {
      return { ok: false, error: "استجابة غير متوقعة من السيرفر." }
    }
    return { ok: true, toolsCount: tools.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "خطأ شبكة" }
  }
}
