import { useEffect, useState } from "react"
import { Check, KeyRound, Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useMoshaarMCP, testMCPConnection } from "@/hooks/useMoshaarMCP"

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; toolsCount: number }
  | { kind: "fail"; error: string }

export interface MCPSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MCPSettingsDialog({ open, onOpenChange }: MCPSettingsDialogProps) {
  const mcp = useMoshaarMCP()
  const [url, setUrl] = useState(mcp.url)
  const [key, setKey] = useState(mcp.key)
  const [test, setTest] = useState<TestState>({ kind: "idle" })

  // Sync local state when dialog (re)opens
  useEffect(() => {
    if (open) {
      setUrl(mcp.url)
      setKey(mcp.key)
      setTest({ kind: "idle" })
    }
  }, [open, mcp.url, mcp.key])

  const onTest = async () => {
    if (!key.trim()) {
      setTest({ kind: "fail", error: "أدخل المفتاح أولاً." })
      return
    }
    setTest({ kind: "testing" })
    const res = await testMCPConnection(url.trim(), key.trim())
    if (res.ok) setTest({ kind: "ok", toolsCount: res.toolsCount })
    else setTest({ kind: "fail", error: res.error })
  }

  const onSave = () => {
    mcp.save(url, key)
    onOpenChange(false)
  }

  const onClear = () => {
    mcp.clear()
    setUrl(mcp.url)  // pick up the reset default
    setKey("")
    setTest({ kind: "idle" })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            ربط حساب موسحار
          </DialogTitle>
          <DialogDescription className="text-right">
            أدخل مفتاح MCP الخاص بك من لوحة موسحار لتفعيل إدارة المهام
            والقضايا والتقويم عبر المحادثة الصوتية. المفتاح يُحفظ في
            متصفحك فقط ولا يُرسل إلى أي خادم إلا عند بدء المكالمة.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="mcp-url" className="text-right block">
              عنوان MCP Endpoint
            </Label>
            <Input
              id="mcp-url"
              dir="ltr"
              className="text-left font-mono text-sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.moshaar.com/v2/mcp/master"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mcp-key" className="text-right block">
              مفتاح API
            </Label>
            <Input
              id="mcp-key"
              type="password"
              dir="ltr"
              className="text-left font-mono text-sm"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="mcp_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground text-right">
              تحصل عليه من لوحة موسحار &laquo; الإعدادات &laquo; MCP API Keys
            </p>
          </div>

          <div className="flex items-center gap-2 justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTest}
              disabled={test.kind === "testing" || !key.trim()}
            >
              {test.kind === "testing" ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> جاري الاختبار…
                </>
              ) : (
                <>اختبر الاتصال</>
              )}
            </Button>

            {test.kind === "ok" && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="size-4" />
                متصل · {test.toolsCount} أداة
              </span>
            )}
            {test.kind === "fail" && (
              <span className="flex items-center gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                <X className="size-4" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter className="flex-row-reverse gap-2 sm:gap-2">
          <Button type="button" onClick={onSave}>
            حفظ
          </Button>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            إلغاء
          </Button>
          {mcp.isConnected && (
            <Button
              type="button"
              variant="ghost"
              className="text-rose-600 hover:text-rose-700 me-auto"
              onClick={onClear}
            >
              قطع الاتصال
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
