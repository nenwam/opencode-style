import type { Account, Todo, TodoStatus } from '../types'

const PLANS: Record<string, string> = {
  free: 'Claude Free',
  pro: 'Claude Pro',
  max: 'Claude Max',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
}

export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'

// One OpenCode-style inline row: `→ Read src/index.ts`.
export type ToolRow = { icon: string; title: string; detail?: string }

// The mod's options, as the manifest's `userConfig` declares them and `/config` sets them.
export type Settings = {
  autoOpenSidebar: boolean
  sessionTitles: boolean
  showEmail: boolean
  expandToolGroups: boolean
  restyleMessages: boolean
  restyleToolRows: boolean
  turnFooter: boolean
  plainSpinner: boolean
  asciiIcons: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  autoOpenSidebar: true,
  sessionTitles: true,
  showEmail: false,
  expandToolGroups: true,
  restyleMessages: true,
  restyleToolRows: true,
  turnFooter: true,
  plainSpinner: true,
  asciiIcons: false,
}

export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = options[key]
    if (typeof value === 'boolean') {
      settings[key] = value
    }
  }

  return settings
}

const SPINNER_WORDS: Record<SpinnerMode, string> = {
  requesting: 'Working',
  thinking: 'Thinking',
  responding: 'Writing',
  'tool-input': 'Preparing',
  'tool-use': 'Running',
}

// Tools whose result block OpenCode leaves out: the row says it all.
export const QUIET_RESULTS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'Skill',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
])

// Plain-ASCII stand-ins for the glyphs a terminal font may lack.
const ASCII: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '✱': '*',
  '◈': '?',
  '◉': '@',
  '⚙': '+',
  '▣': '#',
  '✓': 'x',
  '•': '*',
  '●': '*',
  '—': '-',
  '…': '...',
}

export function toAscii(text: string): string {
  return text.replace(/[→←✱◈◉⚙▣✓•●—…]/g, glyph => ASCII[glyph] ?? glyph)
}

export function spinnerWord(mode: SpinnerMode): string {
  return SPINNER_WORDS[mode] ?? 'Working'
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)

  return `${minutes}m ${seconds}s`
}

export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function oneLine(text: string, max = 120): string {
  const first = (text.split('\n').find(line => line.trim() !== '') ?? '').trim()

  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

export function relPath(path: string, cwd: string): string {
  if (path === cwd) {
    return '.'
  }

  return cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

export function homePath(path: string, home: string | undefined): string {
  return home !== undefined && home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

// The first `max` entries of a list, and how many were left out.
export function capList<T>(list: readonly T[], max: number): { shown: T[]; more: number } {
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
}

function firstString(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const value = Object.values(input).find(one => typeof one === 'string' && one.trim() !== '')

  return typeof value === 'string' ? oneLine(value, 80) : undefined
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function prettyServer(server: string): string {
  if (server.startsWith('claude_ai_')) {
    return `claude.ai ${server.slice('claude_ai_'.length).replace(/_/g, ' ')}`
  }
  if (!server.startsWith('plugin_')) {
    return server
  }
  // `plugin_<plugin>_<server>`: one name when the plugin and its server share it.
  const rest = server.slice('plugin_'.length)
  const half = rest.slice(0, (rest.length - 1) / 2)

  return rest === `${half}_${half}` ? half : rest
}

// The first lines of a text, its trailing blank lines dropped, and how many more there were.
export function textPreview(text: string, max = 10): { lines: string[]; more: number } {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed === '') {
    return { lines: [], more: 0 }
  }
  const lines = trimmed.split('\n')

  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) }
}

// The first lines of a shell command's output, and how many more there were.
export function shellPreview(output: unknown, max = 10): { lines: string[]; more: number } {
  if (typeof output !== 'object' || output === null) {
    return { lines: [], more: 0 }
  }
  const { stdout, stderr, backgroundTaskId } = output as { stdout?: unknown; stderr?: unknown; backgroundTaskId?: unknown }
  if (typeof backgroundTaskId === 'string') {
    return { lines: ['running in the background'], more: 0 }
  }
  const text = [stdout, stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n')

  return textPreview(text, max)
}

export function mcpServers(tools: ReadonlyArray<{ name: string; mcp: boolean }>): string[] {
  const servers: string[] = []
  for (const tool of tools) {
    const match = /^mcp__(.+?)__/.exec(tool.name)
    const server = match?.[1]
    if (tool.mcp && server !== undefined && !servers.includes(server)) {
      servers.push(server)
    }
  }

  return servers.map(prettyServer)
}

export function describeTool(tool: string, input: unknown, cwd: string): ToolRow {
  const path = (key: string) => relPath(field(input, key) ?? '', cwd)

  switch (tool) {
    case 'Read': {
      const offset = field(input, 'offset')
      const limit = field(input, 'limit')
      const range = [offset && `offset=${offset}`, limit && `limit=${limit}`].filter(Boolean)

      return { icon: '→', title: 'Read', detail: path('file_path') + (range.length ? ` [${range.join(', ')}]` : '') }
    }
    case 'Write':
      return { icon: '←', title: 'Write', detail: path('file_path') }
    case 'Edit':
      return { icon: '←', title: 'Edit', detail: path('file_path') }
    case 'NotebookEdit':
      return { icon: '←', title: 'Edit', detail: path('notebook_path') }
    case 'Bash':
      return { icon: '$', title: oneLine(field(input, 'command') ?? '') }
    case 'Glob':
    case 'Grep': {
      const where = field(input, 'path')

      return { icon: '✱', title: tool, detail: `"${field(input, 'pattern') ?? ''}"${where ? ` in ${relPath(where, cwd)}` : ''}` }
    }
    case 'WebFetch':
      return { icon: '%', title: 'WebFetch', detail: field(input, 'url') }
    case 'WebSearch':
      return { icon: '◈', title: 'Search', detail: `"${field(input, 'query') ?? ''}"` }
    case 'Agent':
    case 'Task':
      return {
        icon: '◉',
        title: `${capitalize(field(input, 'subagent_type') ?? 'general')} Task`,
        detail: field(input, 'description'),
      }
    case 'Skill':
      return { icon: '→', title: 'Skill', detail: field(input, 'skill') }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (mcp?.[1] !== undefined && mcp[2] !== undefined) {
        return { icon: '⚙', title: `${prettyServer(mcp[1])} ${mcp[2]}`, detail: firstString(input) }
      }

      return { icon: '⚙', title: tool, detail: firstString(input) }
    }
  }
}

export function todoMark(status: TodoStatus): string {
  return status === 'completed' ? '[✓]' : status === 'in_progress' ? '[•]' : '[ ]'
}

export function todosFromTodoWrite(input: unknown): Todo[] {
  const todos = typeof input === 'object' && input !== null ? (input as { todos?: unknown }).todos : undefined
  if (!Array.isArray(todos)) {
    return []
  }

  return todos.flatMap((one, index): Todo[] => {
    const content = field(one, 'content')
    const status = field(one, 'status')
    if (content === undefined) {
      return []
    }

    return [{ id: String(index), content, status: isStatus(status) ? status : 'pending' }]
  })
}

export function isStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

// Counts the added and removed lines of an Edit or Write result's hunks.
export function countPatch(result: unknown): { added: number; removed: number } {
  const hunks = typeof result === 'object' && result !== null ? (result as { structuredPatch?: unknown }).structuredPatch : undefined
  let added = 0
  let removed = 0
  if (Array.isArray(hunks)) {
    for (const hunk of hunks) {
      const lines = typeof hunk === 'object' && hunk !== null ? (hunk as { lines?: unknown }).lines : undefined
      for (const line of Array.isArray(lines) ? lines : []) {
        if (typeof line === 'string' && line.startsWith('+')) added += 1
        if (typeof line === 'string' && line.startsWith('-')) removed += 1
      }
    }
  }

  return { added, removed }
}

export function cleanTitle(text: string): string {
  return oneLine(text.replace(/^["'#\s]+|["'.\s]+$/g, ''), 60)
}

function planName(subscription: string): string {
  return PLANS[subscription] ?? `Claude ${capitalize(subscription)}`
}

// Reads Claude Code's own config file (`~/.claude.json`): the signed-in account's email and plan.
export function parseConfigAccount(json: string): Account | null {
  let config: unknown
  try {
    config = JSON.parse(json)
  } catch {
    return null
  }
  const oauth = typeof config === 'object' && config !== null ? (config as { oauthAccount?: unknown }).oauthAccount : undefined
  const email = field(oauth, 'emailAddress') ?? null
  const organization = field(oauth, 'organizationType')
  const plan = organization?.startsWith('claude_') ? planName(organization.slice('claude_'.length)) : null

  return email === null && plan === null ? null : { email, plan }
}

// Reads `claude auth status --json`: the account's email and its plan's name.
export function parseAccount(json: string): Account {
  let status: unknown
  try {
    status = JSON.parse(json)
  } catch {
    return { email: null, plan: null }
  }
  const email = field(status, 'email') ?? null
  const subscription = field(status, 'subscriptionType')
  const method = field(status, 'authMethod')
  const plan =
    subscription !== undefined ? planName(subscription) : method !== undefined && method !== 'claude.ai' ? 'API key' : null

  return { email, plan }
}

// Whether the account has a plan with 5-hour and weekly windows, as API keys and cloud providers do not.
export function hasPlanLimits(plan: string | null | undefined): boolean {
  return plan !== null && plan !== undefined && plan.startsWith('Claude ')
}

// The theme key a rate-limit window's percentage is drawn in; undefined draws it dim.
export function usageColor(percent: number): string | undefined {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : undefined
}

// Reads what `/effort` printed: the effort level it set or kept, and whether it turned ultracode on or off.
export function parseEffortOutput(text: string): { effort?: string; isUltracode?: boolean } {
  const found: { effort?: string; isUltracode?: boolean } = {}
  if (/\bUltracode on\b/.test(text)) {
    found.isUltracode = true
  } else if (/\bUltracode off\b/.test(text)) {
    found.isUltracode = false
  }
  const level = /(?:Set effort level to|Effort stays|Effort level set to|Effort set to|Current effort level:)\s+([a-z]+)/i.exec(text)
  if (level?.[1] !== undefined) {
    found.effort = level[1].toLowerCase()
  }

  return found
}

// The text a local slash command printed, from the conversation row that stores it.
export function commandStdout(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => field(block, 'text') ?? '')
    .map(text => /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)?.[1] ?? '')
    .join('\n')
}

// How many lines a file's text holds, as an editor counts them: a final newline ends a line, it starts none.
export function lineCount(text: string): number {
  if (text === '') {
    return 0
  }

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}
