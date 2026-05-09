import * as React from "react"
import { useAtomValue } from "jotai"
import { themeAtom, type Theme } from "@/store/atoms"

/**
 * Applies the theme atom value to <html> via the `dark` class.
 * `system` follows the OS color scheme.
 */
export function ThemeApplier({ children }: { children: React.ReactNode }) {
  const theme = useAtomValue(themeAtom)

  React.useEffect(() => {
    const apply = (t: Theme) => {
      const root = document.documentElement
      const dark =
        t === "dark" ||
        (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      root.classList.toggle("dark", dark)
    }
    apply(theme)

    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => apply("system")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [theme])

  return children
}
