import { NavLink } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useAtom } from "jotai"
import { Globe, Moon, Sun } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { themeAtom } from "@/store/atoms"
import { Orb } from "@/components/ui/orb"

const navItems = [
  { to: "/library", key: "library" as const },
  { to: "/clone", key: "clone" as const },
  { to: "/transcribe", key: "transcribe" as const },
  { to: "/dialogue", key: "dialogue" as const },
  { to: "/call", key: "call" as const },
  { to: "/calls", key: "calls" as const },
]

export function NavBar() {
  const { t, i18n } = useTranslation()
  const [theme, setTheme] = useAtom(themeAtom)

  const toggleLang = () => {
    void i18n.changeLanguage(i18n.language === "ar" ? "en" : "ar")
  }
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark")
  }

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <NavLink to="/library" className="flex items-center gap-2 font-semibold">
          <div className="size-7">
            <Orb agentState="idle" />
          </div>
          <span className="hidden sm:inline">{t("app.name")}</span>
        </NavLink>

        <nav className="ms-4 hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )
              }
            >
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggleLang} aria-label={t("nav.language")}>
            <Globe className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={t("nav.theme")}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>

      {/* Mobile nav */}
      <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )
            }
          >
            {t(`nav.${item.key}`)}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
