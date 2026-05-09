import { Outlet } from "react-router-dom"
import { NavBar } from "./nav-bar"

export function Layout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
