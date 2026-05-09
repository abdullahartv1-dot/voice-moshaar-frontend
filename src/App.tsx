import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { Layout } from "@/components/layout"

const LibraryPage = lazy(() => import("@/pages/library"))
const ClonePage = lazy(() => import("@/pages/clone"))
const TranscribePage = lazy(() => import("@/pages/transcribe"))
const DialoguePage = lazy(() => import("@/pages/dialogue"))
const CallPage = lazy(() => import("@/pages/call"))

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/library" replace />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="clone" element={<ClonePage />} />
          <Route path="transcribe" element={<TranscribePage />} />
          <Route path="dialogue" element={<DialoguePage />} />
          <Route path="call" element={<CallPage />} />
          <Route path="*" element={<Navigate to="/library" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
