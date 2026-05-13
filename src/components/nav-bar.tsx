import { NavLink } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useAtom } from "jotai"
import { Globe, Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { themeAtom } from "@/store/atoms"
import { Orb } from "@/components/ui/orb"

// Public-share mode: nav tabs hidden entirely. To restore the dev
// nav, reintroduce a `navItems` array and the <nav> blocks that
// were here (see git history of this file for the previous shape).

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
        <NavLink to="/calls" className="flex items-center gap-2 font-semibold">
          <div className="size-7">
            <Orb agentState="idle" />
          </div>
          <span className="hidden sm:inline">{t("app.name")}</span>
        </NavLink>

        {/* Nav hidden in public-share mode (only one route exposed).
            Restore the desktop nav block below if you bring more tabs
            back via navItems. */}

        <div className="ms-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggleLang} aria-label={t("nav.language")}>
            <Globe className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={t("nav.theme")}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>

      {/* Mobile nav hidden too — only one route in public-share mode. */}
    </header>
  )
}
