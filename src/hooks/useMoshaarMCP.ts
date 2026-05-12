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
}

export function useMoshaarMCP() {
  const [url, setUrlState] = useState<string>(DEFAULT_URL)
  const [key, setKeyState] = useState<string>("")
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const stored = read()
    if (stored.url) setUrlState(stored.url)
    if (stored.key) setKeyState(stored.key)
    setLoaded(true)
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
