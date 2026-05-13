import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { Layout } from "@/components/layout"

const LibraryPage = lazy(() => import("@/pages/library"))
const ClonePage = lazy(() => import("@/pages/clone"))
const TranscribePage = lazy(() => import("@/pages/transcribe"))
const DialoguePage = lazy(() => import("@/pages/dialogue"))
const CallPage = lazy(() => import("@/pages/call"))
const CallsPage = lazy(() => import("@/pages/calls"))

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
          {/* Public-share mode: any visit lands on /calls. The other
              pages still resolve if someone types the path manually so
              we don't lose them — but root + unknown-path both go to
              مكالمات. */}
          <Route index element={<Navigate to="/calls" replace />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="clone" element={<ClonePage />} />
          <Route path="transcribe" element={<TranscribePage />} />
          <Route path="dialogue" element={<DialoguePage />} />
          <Route path="call" element={<CallPage />} />
          <Route path="calls" element={<CallsPage />} />
          <Route path="*" element={<Navigate to="/calls" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
