/**
 * ChatMarkdown — renders assistant messages with Markdown support
 * (tables via remark-gfm + bold/lists/headings stock).
 *
 * Why a custom renderer and not bare `<ReactMarkdown>`:
 *   - We want compact spacing inside a chat bubble, not the airy
 *     prose-style spacing the default elements come with.
 *   - Tables get their own scrollable wrapper so a wide schedule
 *     doesn't blow out the bubble on mobile.
 *   - The text is in RTL Arabic, so list bullets and table headers
 *     need explicit text-right alignment.
 *
 * User messages don't need Markdown (they're pure transcripts), so we
 * keep ChatMarkdown for assistant turns only — see calls.tsx.
 */
import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

interface ChatMarkdownProps {
  content: string
  className?: string
}

export function ChatMarkdown({ content, className }: ChatMarkdownProps) {
  return (
    <div className={cn("space-y-1.5 text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraphs sit tight inside the bubble — no large vertical
          // margin like prose-class would add.
          p: ({ children }) => <p className="m-0">{children}</p>,
          // Strong + bold both render the same.
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          // Lists: keep bullets/numbers but in compact spacing.
          ul: ({ children }) => (
            <ul className="my-1 list-inside list-disc space-y-0.5">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 list-inside list-decimal space-y-0.5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="m-0">{children}</li>,
          // Tables — scroll horizontally on narrow viewports so a
          // schedule with many columns doesn't break the bubble.
          table: ({ children }) => (
            <div className="my-2 -mx-1 overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/60">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border border-border/60 px-2 py-1 text-right font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border/60 px-2 py-1 text-right align-top">
              {children}
            </td>
          ),
          // Inline code — light tint to stand out without screaming.
          code: ({ children }) => (
            <code className="rounded bg-muted/70 px-1 py-0.5 font-mono text-[11px]">
              {children}
            </code>
          ),
          // Block quotes — used when Sara repeats a confirmation line.
          blockquote: ({ children }) => (
            <blockquote className="border-r-2 border-primary/40 pe-2 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          // Links open in a new tab; we don't expect Sara to emit URLs
          // often but if she does (case detail link, etc.) make it safe.
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:text-primary"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
