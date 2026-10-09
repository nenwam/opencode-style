export type Agent = 'Build' | 'Plan'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type Todo = { id: string; content: string; status: TodoStatus }

export type FileChange = { path: string; added: number; removed: number }

export type Usage = {
  tokens: number | null
  percent: number | null
  window: number
  usd: number | null
  // Percent used of the plan's rate-limit windows; null until the API has reported one.
  fiveHour: number | null
  weekly: number | null
}

export type Account = { email: string | null; plan: string | null }

// The model answering, its effort level (null until known) and whether ultracode is on.
export type Setup = { model: string | null; effort: string | null; isUltracode: boolean }

// The sidebar's capped lists, and which of them the person has expanded in full.
export type ListSection = 'mcp' | 'todos' | 'files'

declare module 'claude-code' {
  interface PluginState {
    'opencode-style': {
      title: string | null
      agent: Agent
      todos: Todo[]
      files: FileChange[]
      usage: Usage | null
      account: Account | null
      setup: Setup
      mcp: string[]
      isSidebarDismissed: boolean
      expanded: Record<ListSection, boolean>
    }
  }
}
