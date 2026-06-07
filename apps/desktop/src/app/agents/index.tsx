import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { BrailleSpinner } from '@/components/ui/braille-spinner'
import { FadeText } from '@/components/ui/fade-text'
import { type Translations, useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2, Sparkles } from '@/lib/icons'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $activeSessionId } from '@/store/session'
import {
  $subagentsBySession,
  buildSubagentTree,
  type SubagentNode,
  type SubagentStatus,
  type SubagentStreamEntry
} from '@/store/subagents'

import { getAgentRoster, getLogs, getStatus } from '@/hermes'
import type { AgentRosterEntry, StatusResponse } from '@/hermes'

import { OverlayActionButton } from '../overlays/overlay-chrome'
import { OverlayCard } from '../overlays/overlay-chrome'
import { OverlayView } from '../overlays/overlay-view'

// ── Tab type ─────────────────────────────────────────────────────────────────

type AgentsTab = 'roster' | 'running' | 'system'

// ── Subagent glyph / stream helpers (unchanged from original) ────────────────

function statusGlyph(status: SubagentStatus, a: Translations['agents']): ReactNode {
  if (status === 'running' || status === 'queued') {
    return (
      <BrailleSpinner
        ariaLabel={a.running}
        className="size-3.5 shrink-0 text-[0.95rem] text-muted-foreground/80"
        spinner="breathe"
      />
    )
  }

  if (status === 'failed' || status === 'interrupted') {
    return <AlertCircle aria-label={a.failed} className="size-3.5 shrink-0 text-destructive" />
  }

  return <CheckCircle2 aria-label={a.done} className="size-3.5 shrink-0 text-emerald-600/85 dark:text-emerald-400/85" />
}

const STREAM_TONE: Record<SubagentStreamEntry['kind'], string> = {
  progress: 'text-muted-foreground/75',
  summary: 'text-foreground/85',
  thinking: 'text-muted-foreground/80',
  tool: 'text-foreground/85'
}

function streamGlyph(entry: SubagentStreamEntry): ReactNode {
  if (entry.isError) {
    return <AlertCircle aria-hidden className="mt-0.5 size-3 shrink-0 text-destructive" />
  }

  if (entry.kind === 'tool') {
    return <span aria-hidden className="mt-0.5 size-1.5 shrink-0 rounded-full bg-foreground/55" />
  }

  if (entry.kind === 'summary') {
    return <CheckCircle2 aria-hidden className="mt-0.5 size-3 shrink-0 text-emerald-600/85 dark:text-emerald-400/85" />
  }

  if (entry.kind === 'thinking') {
    return (
      <span aria-hidden className="font-mono text-[0.7rem] leading-none text-muted-foreground/70">
        …
      </span>
    )
  }

  return <span aria-hidden className="mt-0.5 size-1 shrink-0 rounded-full bg-muted-foreground/55" />
}

// ── AgentsView entry ─────────────────────────────────────────────────────────

interface AgentsViewProps {
  onClose: () => void
}

const TABS: readonly { id: AgentsTab; labelKey: 'roster' | 'running' | 'system' }[] = [
  { id: 'roster', labelKey: 'roster' },
  { id: 'running', labelKey: 'running' },
  { id: 'system', labelKey: 'system' }
]

export function AgentsView({ onClose }: AgentsViewProps) {
  const { t } = useI18n()
  const a = t.agents
  const [tab, setTab] = useState<AgentsTab>('roster')

  // ── Running tab data (existing subagent tree) ────────────────────────────

  const activeSessionId = useStore($activeSessionId)
  const subagentsBySession = useStore($subagentsBySession)

  const activeSubagents = useMemo(
    () => (activeSessionId ? (subagentsBySession[activeSessionId] ?? []) : []),
    [activeSessionId, subagentsBySession]
  )

  const tree = useMemo(() => buildSubagentTree(activeSubagents), [activeSubagents])

  // ── Roster tab data ──────────────────────────────────────────────────────

  const [roster, setRoster] = useState<AgentRosterEntry[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState('')

  useEffect(() => {
    setRosterLoading(true)
    setRosterError('')
    getAgentRoster()
      .then(r => setRoster(r.agents))
      .catch(e => setRosterError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRosterLoading(false))
  }, [])

  // ── System tab data ──────────────────────────────────────────────────────

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [systemLoading, setSystemLoading] = useState(false)
  const [systemError, setSystemError] = useState('')

  const refreshSystem = useCallback(async () => {
    setSystemLoading(true)
    setSystemError('')
    try {
      const [nextStatus, nextLogs] = await Promise.all([
        getStatus(),
        getLogs({ file: 'agent', lines: 60 })
      ])
      setStatus(nextStatus)
      setLogs(nextLogs.lines)
    } catch (error) {
      setSystemError(error instanceof Error ? error.message : String(error))
    } finally {
      setSystemLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'system' && !status && !systemLoading) {
      void refreshSystem()
    }
  }, [tab, status, systemLoading, refreshSystem])

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <OverlayView
      closeLabel={a.close}
      contentClassName="px-5 pt-4 pb-4 sm:px-6"
      onClose={onClose}
      rootClassName="mx-auto max-w-3xl"
    >
      <header className="mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-foreground">{a.title}</h2>
        <p className="text-xs text-muted-foreground/80">{a.subtitle}</p>
        <nav className="mt-3 flex gap-1" role="tablist">
          {TABS.map(({ id, labelKey }) => (
            <button
              aria-selected={tab === id}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                tab === id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              )}
              key={id}
              onClick={() => setTab(id)}
              role="tab"
              type="button"
            >
              {a[labelKey]}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'roster' ? (
        <RosterTab agents={roster} error={rosterError} loading={rosterLoading} />
      ) : tab === 'running' ? (
        <SubagentTree tree={tree} />
      ) : (
        <SystemTab
          error={systemError}
          loading={systemLoading}
          logs={logs}
          onRefresh={() => void refreshSystem()}
          status={status}
        />
      )}
    </OverlayView>
  )
}

// ── Roster tab ──────────────────────────────────────────────────────────────

function RosterTab({
  agents,
  error,
  loading
}: {
  agents: AgentRosterEntry[]
  error: string
  loading: boolean
}) {
  const { t } = useI18n()
  const a = t.agents

  if (loading) {
    return (
      <div className="grid place-items-center gap-2 py-12 text-center">
        <BrailleSpinner ariaLabel={a.loading} className="size-5 text-muted-foreground/60" spinner="breathe" />
        <p className="text-xs text-muted-foreground/75">{a.loading}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="grid place-items-center gap-2 py-12 text-center">
        <AlertCircle className="size-5 text-destructive" />
        <p className="text-xs text-destructive">{error}</p>
      </div>
    )
  }

  if (agents.length === 0) {
    return (
      <div className="grid place-items-center gap-2 py-12 text-center">
        <Sparkles className="size-5 text-muted-foreground/60" />
        <p className="text-xs text-muted-foreground/75">{a.rosterEmpty}</p>
      </div>
    )
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
      <div className="grid gap-2">
        {agents.map(agent => (
          <AgentRosterRow agent={agent} key={agent.id} />
        ))}
      </div>
    </div>
  )
}

// ── Runtime label helpers ────────────────────────────────────────────────────

const RUNTIME_LABELS: Record<string, string> = {
  claude_code_cli: 'Claude Code CLI',
  codex_cli: 'Codex CLI',
  deepseek_tui_cli: 'DeepSeek TUI CLI',
  opencode_cli: 'OpenCode CLI'
}

function runtimeLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime] || runtime || 'internal'
}

function isExternalRuntime(runtime: string): boolean {
  return runtime in RUNTIME_LABELS
}

// ── Agent roster row ────────────────────────────────────────────────────────

function AgentRosterRow({ agent }: { agent: AgentRosterEntry }) {
  const { t } = useI18n()
  const a = t.agents

  const permission = agent.permission || 'ask'
  const isReadOnly = permission === 'read_only'
  const runtime = agent.runtime || ''
  const external = isExternalRuntime(runtime)
  const maxRisk = agent.risk_allowed.length > 0 ? agent.risk_allowed[agent.risk_allowed.length - 1] : ''

  return (
    <OverlayCard className="grid gap-2 p-3">
      {/* Top line: name + permission badge + runtime badge */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            isReadOnly ? 'bg-amber-500' : 'bg-sky-500'
          )}
          title={isReadOnly ? a.permissionReadOnly : a.permissionAsk}
        />
        <span className="min-w-0 truncate text-[0.82rem] font-medium text-foreground/90">
          {agent.display_name}
        </span>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-medium',
            isReadOnly
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
          )}
        >
          {isReadOnly ? a.permissionReadOnly : a.permissionAsk}
        </span>
        {external && (
          <span className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[0.6rem] font-medium text-violet-600 dark:text-violet-400">
            {runtimeLabel(runtime)}
          </span>
        )}
        {runtime && !external && (
          <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
            {runtime}
          </span>
        )}
      </div>

      {/* Role summary */}
      <p className="text-[0.72rem] leading-relaxed text-muted-foreground/80">
        {agent.role_summary}
      </p>

      {/* Bottom metadata row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-muted-foreground/65">
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-muted-foreground/70">{a.modelRef}:</span>
          <span className="font-mono text-[0.62rem]">{agent.model_ref || '—'}</span>
        </span>
        {maxRisk && (
          <span className="inline-flex items-center gap-1">
            <span className="font-medium text-muted-foreground/70">{a.riskLevel}:</span>
            <span className="font-mono text-[0.62rem]">{agent.risk_allowed.join(' ')}</span>
          </span>
        )}
        {agent.skills.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="font-medium text-muted-foreground/70">{a.skills}:</span>
            <span className="font-mono text-[0.62rem]">{agent.skills.length}</span>
          </span>
        )}
        {agent.tools.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="font-medium text-muted-foreground/70">{a.tools}:</span>
            <span className="font-mono text-[0.62rem]">{agent.tools.join(', ')}</span>
          </span>
        )}
      </div>
    </OverlayCard>
  )
}

// ── System tab ──────────────────────────────────────────────────────────────

function SystemTab({
  error,
  loading,
  logs,
  onRefresh,
  status
}: {
  error: string
  loading: boolean
  logs: string[]
  onRefresh: () => void
  status: StatusResponse | null
}) {
  const { t } = useI18n()
  const a = t.agents

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden">
      {/* Gateway status card */}
      <OverlayCard className="p-3">
        {status ? (
          <div className="grid gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      status.gateway_running ? 'bg-emerald-500' : 'bg-amber-500'
                    )}
                  />
                  <span className="text-[0.82rem] font-medium text-foreground">
                    {status.gateway_running ? a.gatewayRunning : a.gatewayStopped}
                  </span>
                </div>
                <div className="mt-1 text-[0.65rem] text-muted-foreground/75">
                  {a.gatewayInfo(status.version, status.active_sessions)} · {status.hermes_home}
                </div>
              </div>
              <OverlayActionButton className="h-7 px-2.5 text-xs" onClick={onRefresh}>
                {loading ? a.refreshing : a.refresh}
              </OverlayActionButton>
            </div>

            {status.gateway_platforms && Object.keys(status.gateway_platforms).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(status.gateway_platforms).map(([key, p]) => (
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[0.6rem] font-medium',
                      p.state === 'connected' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted/50 text-muted-foreground'
                    )}
                    key={key}
                  >
                    {key}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BrailleSpinner ariaLabel={a.loading} className="size-3.5" spinner="breathe" />
            {a.loading}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">{a.systemNoData}</div>
        )}
      </OverlayCard>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Recent logs */}
      <OverlayCard className="min-h-0 overflow-hidden p-2">
        <div className="mb-1.5 text-[0.7rem] font-medium text-muted-foreground">{a.recentLogs}</div>
        <pre className="h-full min-h-0 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[0.62rem] leading-relaxed text-muted-foreground/80">
          {logs.length ? logs.slice(-40).join('\n') : a.noLogs}
        </pre>
      </OverlayCard>
    </div>
  )
}

// ── Subagent tree (unchanged from original) ──────────────────────────────────

const fmtDuration = (seconds: number | undefined, a: Translations['agents']) => {
  if (!seconds || seconds <= 0) {
    return ''
  }

  if (seconds < 60) {
    return a.durationSeconds(seconds.toFixed(1))
  }

  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)

  return a.durationMinutes(m, s)
}

const fmtTokens = (value: number | undefined, a: Translations['agents']) => {
  if (!value) {
    return ''
  }

  return value >= 1000 ? a.tokensK((value / 1000).toFixed(1)) : a.tokens(value)
}

const fmtAge = (updatedAt: number, nowMs: number, a: Translations['agents']) => {
  const s = Math.max(0, Math.round((nowMs - updatedAt) / 1000))

  if (s < 2) {
    return a.ageNow
  }

  if (s < 60) {
    return a.ageSeconds(s)
  }

  const m = Math.floor(s / 60)

  if (m < 60) {
    return a.ageMinutes(m)
  }

  return a.ageHours(Math.floor(m / 60))
}

const flatten = (nodes: readonly SubagentNode[]): SubagentNode[] =>
  nodes.flatMap(node => [node, ...flatten(node.children)])

interface RootGroup {
  id: string
  delegationIndex: number
  nodes: SubagentNode[]
  taskCount: number
}

function groupDelegations(roots: readonly SubagentNode[]): RootGroup[] {
  const groups: RootGroup[] = []
  let n = 0

  for (const node of roots) {
    const prev = groups.at(-1)
    const prevTail = prev?.nodes.at(-1)
    const closeInTime = prevTail ? Math.abs(node.startedAt - prevTail.startedAt) <= 5_000 : false
    const sameShape = prev && node.taskCount > 1 && prev.taskCount === node.taskCount
    const uniqueStep = prev ? !prev.nodes.some(item => item.taskIndex === node.taskIndex) : false

    if (prev && sameShape && closeInTime && uniqueStep) {
      prev.nodes.push(node)

      continue
    }

    if (node.taskCount > 1) {
      n += 1
      groups.push({ id: `delegation-${n}`, delegationIndex: n, nodes: [node], taskCount: node.taskCount })

      continue
    }

    groups.push({ id: node.id, delegationIndex: 0, nodes: [node], taskCount: node.taskCount })
  }

  return groups
}

function SubagentTree({ tree }: { tree: SubagentNode[] }) {
  const { t } = useI18n()
  const flat = useMemo(() => flatten(tree), [tree])
  const groups = useMemo(() => groupDelegations(tree), [tree])
  const [nowMs, setNowMs] = useState(() => Date.now())

  const active = flat.filter(n => n.status === 'running' || n.status === 'queued').length
  const failed = flat.filter(n => n.status === 'failed' || n.status === 'interrupted').length
  const tools = flat.reduce((sum, n) => sum + (n.toolCount ?? 0), 0)
  const files = flat.reduce((sum, n) => sum + n.filesRead.length + n.filesWritten.length, 0)
  const tokens = flat.reduce((sum, n) => sum + (n.inputTokens ?? 0) + (n.outputTokens ?? 0), 0)
  const cost = flat.reduce((sum, n) => sum + (n.costUsd ?? 0), 0)

  useEffect(() => {
    if (active <= 0 || typeof window === 'undefined') {
      return
    }

    const id = window.setInterval(() => setNowMs(Date.now()), 500)

    return () => window.clearInterval(id)
  }, [active])

  if (tree.length === 0) {
    return (
      <div className="grid place-items-center gap-3 py-12 text-center">
        <Sparkles className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground/90">{t.agents.emptyTitle}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground/75">{t.agents.emptyDesc}</p>
      </div>
    )
  }

  const summary = [
    t.agents.agentsCount(flat.length),
    active > 0 ? t.agents.activeCount(active) : '',
    failed > 0 ? t.agents.failedCount(failed) : '',
    tools > 0 ? t.agents.toolsCount(tools) : '',
    files > 0 ? t.agents.filesCount(files) : '',
    tokens > 0 ? fmtTokens(tokens, t.agents) : '',
    cost > 0 ? `$${cost.toFixed(2)}` : ''
  ].filter(Boolean)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      <p className="shrink-0 text-[0.7rem] text-muted-foreground/70">{summary.join(' · ')}</p>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
        <div className="flex min-w-0 flex-col gap-6">
          {groups.map(group => (
            <DelegationGroup group={group} key={group.id} nowMs={nowMs} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DelegationGroup({ group, nowMs }: { group: RootGroup; nowMs: number }) {
  const { t } = useI18n()

  if (group.nodes.length === 1 && group.taskCount <= 1) {
    return <SubagentRow node={group.nodes[0]!} nowMs={nowMs} />
  }

  const activeWorkers = group.nodes.filter(n => n.status === 'running' || n.status === 'queued').length

  return (
    <section className="grid min-w-0 gap-3">
      <p className="text-[0.66rem] font-medium uppercase tracking-wider text-muted-foreground/70">
        {group.delegationIndex > 0 ? t.agents.delegation(group.delegationIndex) : ''}{' '}
        <span className="text-muted-foreground/50">·</span> {t.agents.workers(group.nodes.length)}
        {activeWorkers > 0 ? <span className="text-primary/85"> · {t.agents.workersActive(activeWorkers)}</span> : null}
      </p>
      <div className="grid min-w-0 gap-4">
        {group.nodes.map(node => (
          <SubagentRow key={node.id} node={node} nowMs={nowMs} />
        ))}
      </div>
    </section>
  )
}

function StreamLine({
  active,
  entry,
  parentRunning,
  rowKey
}: {
  active: boolean
  entry: SubagentStreamEntry
  parentRunning: boolean
  rowKey: string
}) {
  const { t } = useI18n()
  const enterRef = useEnterAnimation(parentRunning, `subagent-stream:${rowKey}`)
  const isMono = entry.kind === 'tool'
  const tone = entry.isError ? 'text-destructive' : STREAM_TONE[entry.kind]

  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[0.72rem] leading-relaxed" ref={enterRef}>
      <span className="flex h-[0.95rem] shrink-0 items-center">{streamGlyph(entry)}</span>
      <span className={cn('min-w-0 flex-1 wrap-anywhere', tone, isMono && 'font-mono text-[0.69rem]')}>
        {entry.text}
        {active ? (
          <BrailleSpinner
            ariaLabel={t.agents.streaming}
            className="ml-1 inline-block size-2.5 align-middle text-muted-foreground/70"
            spinner="breathe"
          />
        ) : null}
      </span>
    </div>
  )
}

function SubagentRow({ node, depth = 0, nowMs }: { node: SubagentNode; depth?: number; nowMs: number }) {
  const { t } = useI18n()
  const running = node.status === 'running' || node.status === 'queued'
  const elapsed = useElapsedSeconds(running, `subagent:${node.id}`)

  const durationSeconds =
    typeof node.durationSeconds === 'number' ? Math.max(0, Math.round(node.durationSeconds)) : elapsed

  const [open, setOpen] = useState(() => running || depth < 2)
  const enterRef = useEnterAnimation(true, `subagent-row:${node.id}`)

  useEffect(() => {
    if (running) {
      setOpen(true)
    }
  }, [running])

  const visibleRows = open ? node.stream.slice(-10) : node.stream.slice(-2)
  const fileLines = [...node.filesWritten.map(p => `+ ${p}`), ...node.filesRead.map(p => `· ${p}`)]

  const subtitle = [
    node.model,
    fmtDuration(durationSeconds, t.agents),
    node.toolCount ? t.agents.toolsCount(node.toolCount) : '',
    fmtTokens((node.inputTokens ?? 0) + (node.outputTokens ?? 0), t.agents),
    t.agents.updatedAgo(fmtAge(node.updatedAt, nowMs, t.agents))
  ].filter(Boolean)

  return (
    <div className={cn('grid min-w-0 max-w-full gap-2', depth > 0 && 'pl-4')} data-slot="tool-block" ref={enterRef}>
      <button
        aria-expanded={open}
        className="group flex w-full min-w-0 items-start gap-2.5 text-left"
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        <span className="mt-0.5 flex h-[1.1rem] shrink-0 items-center">{statusGlyph(node.status, t.agents)}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'wrap-anywhere text-[0.82rem] font-medium leading-[1.1rem] text-foreground/90 transition-colors group-hover:text-foreground',
              running && 'shimmer text-foreground/65'
            )}
          >
            {node.goal}
          </span>
          {subtitle.length > 0 ? (
            <FadeText className="text-[0.66rem] leading-[1.05rem] text-muted-foreground/65">
              {subtitle.join(' · ')}
            </FadeText>
          ) : null}
        </span>
        {running ? <ActivityTimerText className="mt-1 shrink-0 text-[0.6rem]" seconds={durationSeconds} /> : null}
      </button>

      {visibleRows.length > 0 ? (
        <div className="grid min-w-0 gap-1 pl-6">
          {visibleRows.map((entry, i) => (
            <StreamLine
              active={running && i === visibleRows.length - 1}
              entry={entry}
              key={`${entry.kind}:${entry.at}:${i}`}
              parentRunning={running}
              rowKey={`${node.id}:${entry.kind}:${entry.at}`}
            />
          ))}
        </div>
      ) : null}

      {open && fileLines.length > 0 ? (
        <div className="grid min-w-0 gap-0.5 pl-6">
          <p className="text-[0.58rem] font-medium tracking-wider text-muted-foreground/60 uppercase">{t.agents.files}</p>
          {fileLines.slice(0, 8).map(line => (
            <p className="wrap-break-word font-mono text-[0.67rem] leading-relaxed text-muted-foreground/80" key={line}>
              {line}
            </p>
          ))}
          {fileLines.length > 8 ? (
            <p className="font-mono text-[0.67rem] leading-relaxed text-muted-foreground/65">
              {t.agents.moreFiles(fileLines.length - 8)}
            </p>
          ) : null}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className="grid min-w-0 gap-3 pl-6">
          {node.children.map(child => (
            <SubagentRow depth={depth + 1} key={child.id} node={child} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
