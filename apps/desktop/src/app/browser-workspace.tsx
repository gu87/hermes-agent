import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Globe } from '@/lib/icons'

import { WorkspaceLauncher } from './workspace-launcher'

export function BrowserWorkspace() {
  const [showPlaceholder, setShowPlaceholder] = useState(false)

  if (showPlaceholder) {
    return <BrowserPlaceholder onBack={() => setShowPlaceholder(false)} />
  }

  return <WorkspaceLauncher onOpenBrowser={() => setShowPlaceholder(true)} />
}

function BrowserPlaceholder({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate()

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-6 bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/40 text-(--ui-text-tertiary)">
        <Globe className="size-7" />
      </div>

      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        Browser Workspace
      </h1>

      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        <p>Read-only shared browser context</p>

        <div className="mt-2 flex items-center gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/30 px-4 py-2.5">
          <span className="size-2 rounded-full bg-amber-400" />
          <span className="text-xs font-medium text-muted-foreground">
            Not connected yet
          </span>
        </div>
      </div>

      <div className="mt-2 max-w-xs text-center text-xs text-muted-foreground/70">
        <p className="mb-1 font-medium">Planned</p>
        <ul className="space-y-1">
          <li>URL navigation</li>
          <li>Page title &amp; screenshot</li>
          <li>DOM summary extraction</li>
        </ul>
      </div>

      <div className="mt-4 flex gap-3">
        <button
          className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/40 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-(--ui-bg-secondary)/60 hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          ← 返回
        </button>
        <button
          className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/40 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-(--ui-bg-secondary)/60 hover:text-foreground"
          onClick={() => navigate('/')}
          type="button"
        >
          回到聊天
        </button>
      </div>
    </div>
  )
}
