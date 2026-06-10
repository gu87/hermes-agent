import {
  Command,
  FolderOpen,
  Globe,
  MessageSquareText,
  Search,
  Terminal
} from '@/lib/icons'
import { cn } from '@/lib/utils'

interface LauncherCard {
  title: string
  subtitle: string
  shortcut: string
  icon: typeof Globe
  active: boolean
}

const CARDS: LauncherCard[] = [
  {
    title: '文件',
    subtitle: '浏览项目文件',
    shortcut: '⌘O',
    icon: FolderOpen,
    active: false
  },
  {
    title: '侧边聊天',
    subtitle: '对话面板',
    shortcut: '⌘L',
    icon: MessageSquareText,
    active: false
  },
  {
    title: '浏览器',
    subtitle: '打开网站',
    shortcut: '⌘T',
    icon: Globe,
    active: true
  },
  {
    title: '审查',
    subtitle: '代码审查',
    shortcut: '⌘R',
    icon: Search,
    active: false
  },
  {
    title: '终端',
    subtitle: '打开终端',
    shortcut: '⌃`',
    icon: Terminal,
    active: false
  }
]

export function WorkspaceLauncher({
  onOpenBrowser
}: {
  onOpenBrowser?: () => void
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      <div className="w-full max-w-[21rem] rounded-2xl border border-(--ui-stroke-secondary) bg-(--ui-bg-card)/60 p-2 shadow-sm">
        {CARDS.map(card => (
          <LauncherCardItem
            card={card}
            key={card.title}
            onOpenBrowser={onOpenBrowser}
          />
        ))}
      </div>

      <p className="mt-4 text-xs text-muted-foreground/50">
        Workspace launcher
      </p>
    </div>
  )
}

function LauncherCardItem({
  card,
  onOpenBrowser
}: {
  card: LauncherCard
  onOpenBrowser?: () => void
}) {
  const Icon = card.icon
  const isBrowser = card.title === '浏览器'
  const isClickable = card.active && isBrowser && onOpenBrowser

  return (
    <button
      className={cn(
        'group flex w-full items-center gap-4 rounded-xl px-4 py-3.5 text-left transition-colors',
        isClickable &&
          'cursor-pointer bg-(--ui-bg-card) hover:bg-(--ui-bg-secondary)/60',
        !isClickable &&
          'cursor-default opacity-50'
      )}
      disabled={!isClickable}
      onClick={() => {
        if (isBrowser && onOpenBrowser) {onOpenBrowser()}
      }}
      type="button"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-(--ui-bg-secondary) text-(--ui-text-secondary)">
        <Icon className="size-5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{card.title}</div>
        <div className="text-xs text-muted-foreground">{card.subtitle}</div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground/60">
        <Command className="size-3" />
        <span className="tabular-nums">{card.shortcut.replace(/[⌘⌃]/g, '')}</span>
      </div>

      {!isClickable && (
        <span className="shrink-0 rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/50">
          Soon
        </span>
      )}
    </button>
  )
}
