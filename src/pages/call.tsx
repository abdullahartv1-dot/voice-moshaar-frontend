import { useTranslation } from "react-i18next"
import { Orb } from "@/components/ui/orb"

export default function CallPage() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-16 text-center">
      <div className="size-32">
        <Orb agentState="thinking" />
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("call.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("call.subtitle")}</p>
      </div>
      <span className="rounded-full border border-primary/30 bg-primary/10 px-4 py-1 text-sm font-medium text-primary">
        {t("call.coming_soon")}
      </span>
    </div>
  )
}
