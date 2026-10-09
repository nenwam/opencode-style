import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Account, Agent, FileChange, ListSection, Todo, TodoStatus, Usage } from '../types'
import {
  QUIET_RESULTS,
  capList,
  cleanTitle,
  countPatch,
  describeTool,
  formatCount,
  formatDuration,
  hasPlanLimits,
  homePath,
  isStatus,
  lineCount,
  mcpServers,
  oneLine,
  parseAccount,
  commandStdout,
  parseConfigAccount,
  parseEffortOutput,
  readSettings,
  relPath,
  shellPreview,
  spinnerWord,
  textPreview,
  toAscii,
  todoMark,
  todosFromTodoWrite,
  usageColor,
} from './format'

const PANE = 'opencode-sidebar'
const SIDEBAR = { id: PANE, title: 'Session', columns: 42 } as const
// How long tool calls are left to settle before the sidebar's figures are read again.
const USAGE_SETTLE_MS = 400

const title = atom({ plugin: 'opencode-style', key: 'title' } as const, null)
const agent = atom({ plugin: 'opencode-style', key: 'agent' } as const, 'Build')
const todos = atom({ plugin: 'opencode-style', key: 'todos' } as const, [])
const files = atom({ plugin: 'opencode-style', key: 'files' } as const, [])
const usage = atom({ plugin: 'opencode-style', key: 'usage' } as const, null)
const account = atom({ plugin: 'opencode-style', key: 'account' } as const, null)
const setup = atom({ plugin: 'opencode-style', key: 'setup' } as const, { model: null, effort: null, isUltracode: false })
const mcp = atom({ plugin: 'opencode-style', key: 'mcp' } as const, [])
const isSidebarDismissed = atom({ plugin: 'opencode-style', key: 'isSidebarDismissed' } as const, false)
const expanded = atom({ plugin: 'opencode-style', key: 'expanded' } as const, { mcp: false, todos: false, files: false })

// When the MCP list is read again after the session starts, as servers finish connecting.
const MCP_SETTLE_MS = [3_000, 10_000]

// How many rows each sidebar list shows before folding the rest into `+N more`.
const LIST_CAPS: Record<ListSection, number> = { mcp: 6, todos: 12, files: 8 }

let pendingUsage: Timer | undefined

// Claude Code's own theme keys, so the person's theme still decides the colours.
function agentColor(name: Agent): string {
  return name === 'Plan' ? 'planMode' : 'claude'
}

function addFileChange(list: FileChange[], path: string, added: number, removed: number): FileChange[] {
  const found = list.some(one => one.path === path)

  return found
    ? list.map(one => (one.path === path ? { ...one, added: one.added + added, removed: one.removed + removed } : one))
    : [...list, { path, added, removed }]
}

async function refreshUsage($: EngineInterface) {
  const { context, cost, rateLimits } = await $.session.usage()
  const now: Usage = {
    tokens: context.tokens ?? null,
    percent: context.percent ?? null,
    window: context.window,
    usd: cost?.usd ?? null,
    fiveHour: rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null,
    weekly: rateLimits.find(limit => limit.kind === 'seven_day')?.percentUsed ?? null,
  }
  await update($, usage, () => now)
}

// Reads the figures once a burst of tool calls has settled, so no call waits on the sidebar.
function scheduleUsage($: EngineInterface) {
  if (pendingUsage !== undefined) {
    return
  }
  pendingUsage = $.clock.after(USAGE_SETTLE_MS, () => {
    pendingUsage = undefined
    void refreshUsage($).catch(() => undefined)
  })
}

// The signed-in account: Claude Code's config file first, `claude auth status` where that says nothing.
async function refreshAccount($: EngineInterface) {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
  let found: Account | null = null
  if (dir !== undefined && dir !== '') {
    found = await $.fs.read(`${dir}/.claude.json`).then(parseConfigAccount, () => null)
  }
  if (found === null) {
    const status = await $.process
      .run(['claude', 'auth', 'status', '--json'], { timeoutMs: 15_000 })
      .catch(() => undefined)
    if (status?.exitCode === 0) {
      found = parseAccount(status.stdout)
    }
  }
  if (found !== null) {
    const known = found
    await update($, account, () => known)
  }
}

async function refreshModel($: EngineInterface) {
  const model = await $.session.model()
  await update($, setup, now => ({ ...now, model }))
}

async function refreshMcp($: EngineInterface) {
  const servers = mcpServers(await $.tool.list())
  await update($, mcp, () => servers)
}

// Names the session from its first prompt, as OpenCode does.
async function nameSession($: EngineInterface, prompt: string) {
  const reply = await $.model.complete({
    model: 'haiku',
    maxTokens: 40,
    prompt:
      'Write a title of at most six words for a coding session that starts with the request below. ' +
      'Reply with the title alone, no quotes.\n\n<request>\n' +
      prompt.slice(0, 2000) +
      '\n</request>',
  })
  if (reply.isAnswered && reply.text.trim() !== '') {
    await update($, title, () => cleanTitle(reply.text))
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const glyph = (text: string) => (settings.asciiIcons ? toAscii(text) : text)
  let cwd = ''
  let home: string | undefined
  let version = ''
  let hasTriedAutoOpen = false
  // What each finished turn and prompt was drawn with, so later redraws keep it.
  const footers = new Map<string, { agent: Agent; model: string }>()
  const bars = new Map<string, Agent>()
  // Calls drawn inside a group: those rows carry their own output, which no result block repeats.
  const grouped = new Set<string>()

  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    home = await $.env.get('HOME')
    const built = await $.session.version()
    version = built.base ?? built.version
    await $.command.register({
      name: 'sidebar',
      description: 'Show or hide the OpenCode-style session sidebar',
    })
    await Promise.all([refreshUsage($), refreshMcp($), refreshModel($)])
    $.clock.after(0, () => {
      void refreshAccount($).catch(() => undefined)
    })
    // MCP servers are still connecting as the session starts; look again once they have had a moment.
    for (const ms of MCP_SETTLE_MS) {
      $.clock.after(ms, () => {
        void refreshMcp($).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      footers.clear()
      bars.clear()
      grouped.clear()
      await update($, title, () => null)
      await update($, todos, () => [])
      await update($, files, () => [])
    }

    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mode: Agent = e.permission_mode === 'plan' ? 'Plan' : 'Build'
    await update($, agent, () => mode)

    return next(e)
  })

  // Each finished turn reports the effort it actually ran at, after any downgrade for the model.
  on('classic.Stop', async ($, e, next) => {
    const effort = e.effort?.level
    if (e.agent_id === undefined && effort !== undefined) {
      await update($, setup, now => ({ ...now, effort }))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isFirst = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/') && (await read($, title)) === null
    if (isFirst) {
      const text = e.text
      await update($, title, () => cleanTitle(text))
      if (settings.sessionTitles) {
        $.clock.after(0, () => {
          void nameSession($, text).catch(() => undefined)
        })
      }
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      scheduleUsage($)
      $.clock.after(0, () => {
        void Promise.all([refreshMcp($), refreshModel($)]).catch(() => undefined)
      })
    }

    return next(e)
  })

  // `/effort` turns ultracode on and off and changes the effort level. Its printed text reaches a
  // plugin only as the conversation row that stores it, so that row is read as it is stored.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const found = e.agentId === undefined ? parseEffortOutput(commandStdout(e.message.content)) : {}
    if (found.effort !== undefined || found.isUltracode !== undefined) {
      await update($, setup, now => ({
        ...now,
        effort: found.effort ?? now.effort,
        isUltracode: found.isUltracode ?? now.isUltracode,
      }))
    }

    return next(e)
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const ran = await next(e)
    await refreshModel($)

    return ran
  }).catch(($, e, next) => next(e))

  // Follows each call to keep the sidebar's todos and modified files current.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    if (e.tool === 'Edit' || e.tool === 'Write') {
      let { added, removed } = countPatch(ran.result)
      if (e.tool === 'Write' && added === 0 && removed === 0) {
        added = lineCount(e.content)
      }
      const path = relPath(e.file_path, cwd)
      await update($, files, list => addFileChange(list, path, added, removed))
    } else if (e.tool === 'NotebookEdit') {
      const path = relPath(e.notebook_path, cwd)
      await update($, files, list => addFileChange(list, path, 0, 0))
    } else if (e.tool === 'TodoWrite' && e.agentId === undefined) {
      const list = todosFromTodoWrite(e)
      await update($, todos, () => list)
    } else if (e.tool === 'TaskCreate') {
      const created = ran.result as { task?: { id?: string } } | undefined
      const todo: Todo = { id: created?.task?.id ?? e.subject, content: e.subject, status: 'pending' }
      await update($, todos, list => [...list, todo])
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject } = e
      await update($, todos, list =>
        status === 'deleted'
          ? list.filter(one => one.id !== taskId)
          : list.map(one =>
              one.id === taskId
                ? { ...one, content: subject ?? one.content, status: isStatus(status) ? status : one.status }
                : one,
            ),
      )
    } else if (e.tool === 'EnterPlanMode') {
      await update($, agent, () => 'Plan')
    } else if (e.tool === 'ExitPlanMode') {
      await update($, agent, () => 'Build')
    }

    if (e.agentId === undefined) {
      scheduleUsage($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sidebar' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await update($, isSidebarDismissed, () => true)
      await $.ui.close({ id: PANE })

      return { text: 'Sidebar hidden.' }
    }
    await update($, isSidebarDismissed, () => false)
    await $.ui.open(SIDEBAR)

    return { text: 'Sidebar shown.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isSidebarDismissed, () => true)
    }

    return next(e)
  })

  // The first time the fullscreen layout is seen, dock the sidebar like OpenCode's.
  if (settings.autoOpenSidebar) {
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
      if (!hasTriedAutoOpen && e.surface === 'terminal' && e.viewport?.isFullscreen === true) {
        hasTriedAutoOpen = true
        if (!(await read($, isSidebarDismissed))) {
          void $.ui.open(SIDEBAR)
        }
      }

      return next(e)
    })
  }

  // Plain words in place of the whimsical ones; the engine keeps the time and tokens.
  if (settings.plainSpinner) {
    on('ui.render', { component: 'Spinner' }, ($, e, next) =>
      e.surface === 'terminal' ? next({ ...e, props: { ...e.props, word: spinnerWord(e.props.mode) } }) : next(e),
    )
  }

  // `▣ Built · model · 3.2s` in place of `Baked for 3s`.
  if (settings.turnFooter) {
    on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
      if (e.surface !== 'terminal') {
        return next(e)
      }
      const id = e.requestId ?? String(e.props.durationMs)
      let label = footers.get(id)
      if (label === undefined) {
        label = { agent: await read($, agent), model: await $.session.model() }
        footers.set(id, label)
      }
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box paddingLeft={3}>
          <Text>
            <Text color={agentColor(label.agent)}>{glyph('▣ ')}</Text>
            <Text>{label.agent === 'Plan' ? 'Planned' : 'Built'}</Text>
            <Text dimColor>
              {' · '}
              {label.model}
              {' · '}
              {formatDuration(e.props.durationMs)}
            </Text>
          </Text>
        </Box>
      )
    })
  }

  if (settings.restyleMessages) {
    // The person's prompt in a panel behind a bar in the mode's colour.
    on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
      if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') {
        return next(e)
      }
      let bar = bars.get(e.requestId)
      if (bar === undefined) {
        bar = await read($, agent)
        bars.set(e.requestId, bar)
      }
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" borderStyle="quote" borderColor={agentColor(bar)}>
          <Box flexDirection="column" backgroundColor="userMessageBackground" paddingX={1} paddingY={1}>
            <Text>{e.props.text}</Text>
          </Box>
        </Box>
      )
    })

    // Replies without the bullet, indented under the prompt.
    on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
      if (e.surface !== 'terminal') {
        return next(e)
      }
      const { Box, Markdown } = $.ui.resolve(e)

      return (
        <Box paddingLeft={3} flexDirection="column">
          <Markdown text={e.props.text} dimColor={e.props.isSummary === true} />
        </Box>
      )
    })
  }

  if (settings.restyleToolRows || settings.expandToolGroups) {
    // Notes which calls are drawn inside a group and, when asked, lists each one on its own row.
    on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
      if (e.surface !== 'terminal') {
        return next(e)
      }
      for (const call of e.props.calls) {
        if (call.tool_use_id !== undefined) {
          grouped.add(call.tool_use_id)
        }
      }

      return settings.expandToolGroups ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
    })
  }

  if (settings.restyleToolRows) {
    on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
      if (e.surface !== 'terminal') {
        return next(e)
      }
      const { Box, Text } = $.ui.resolve(e)
      const { tool, input, isRunning, isErrored, isInterrupted, output, tool_use_id } = e.props

      if (tool === 'TodoWrite') {
        return (
          <Box paddingLeft={3} flexDirection="column">
            <Text dimColor># Todos</Text>
            {todosFromTodoWrite(input).map(todo => (
              <Text
                color={todo.status === 'in_progress' ? 'claude' : undefined}
                dimColor={todo.status === 'completed'}
                wrap="truncate-end"
              >
                {glyph(todoMark(todo.status))} {todo.content}
              </Text>
            ))}
          </Box>
        )
      }

      if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
        const fields = (typeof input === 'object' && input !== null ? input : {}) as {
          subject?: string
          taskId?: string
          status?: string
        }
        let content = fields.subject
        if (content === undefined && fields.taskId !== undefined) {
          content = (await read($, todos)).find(one => one.id === fields.taskId)?.content ?? `#${fields.taskId}`
        }
        const status: TodoStatus = isStatus(fields.status) ? fields.status : 'pending'
        const isDeleted = fields.status === 'deleted'

        return (
          <Box paddingLeft={3}>
            <Text
              color={status === 'in_progress' ? 'claude' : undefined}
              dimColor={status !== 'in_progress'}
              strikethrough={isDeleted}
              wrap="truncate-end"
            >
              {isDeleted ? '[-]' : glyph(todoMark(status))} {content ?? ''}
            </Text>
          </Box>
        )
      }

      const row = describeTool(tool, input, cwd)
      // A grouped row has no result block beneath it, so it shows its own output or error;
      // a standalone row leaves both to Claude Code's result block, which ctrl+o expands.
      const isGrouped = grouped.has(tool_use_id)
      const preview = !isGrouped
        ? { lines: [], more: 0 }
        : isErrored
          ? textPreview(typeof output === 'string' ? output : '')
          : tool === 'Bash'
            ? shellPreview(output)
            : { lines: [], more: 0 }

      return (
        <Box paddingLeft={3} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={isErrored ? 'error' : isRunning ? 'claude' : undefined} dimColor={!isErrored && !isRunning}>
              {glyph(row.icon)}{' '}
            </Text>
            <Text color={isErrored ? 'error' : undefined} dimColor={!isErrored}>
              {row.title}
              {row.detail ? ` ${row.detail}` : ''}
            </Text>
            {isInterrupted && <Text color="warning"> · interrupted</Text>}
          </Text>
          {preview.lines.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {preview.lines.map(line => (
                <Text color={isErrored ? 'error' : undefined} dimColor={!isErrored} wrap="truncate-end">
                  {line === '' ? ' ' : line}
                </Text>
              ))}
              {preview.more > 0 && (
                <Text dimColor>
                  {glyph('…')} +{preview.more} lines
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    })

    // Hides the result blocks the row already covers: quiet tools, and a grouped call's output or error.
    on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
      if (e.surface !== 'terminal') {
        return next(e)
      }
      const { tool, isErrored, tool_use_id } = e.props
      const isCovered =
        (QUIET_RESULTS.has(tool) && !isErrored) || (grouped.has(tool_use_id) && (isErrored || tool === 'Bash'))
      if (!isCovered) {
        return next(e)
      }
      const { Box } = $.ui.resolve(e)

      return <Box />
    })
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [name, list, changed, used, servers, who, running, opened] = await Promise.all([
      read($, title),
      read($, todos),
      read($, files),
      read($, usage),
      read($, mcp),
      read($, account),
      read($, setup),
      read($, expanded),
    ])
    // Labels and values line up in a column across the Account and Model sections.
    const label = (text: string) => <Text dimColor>{text.padEnd(10)}</Text>
    const isDocked = e.props.placement === 'dock'
    const email = settings.showEmail ? (who?.email ?? null) : null
    const plan = who?.plan ?? null
    const fiveHour = used?.fiveHour ?? null
    const weekly = used?.weekly ?? null
    // API keys and cloud providers have no 5-hour or weekly windows; their rows are left out.
    const hasLimits = hasPlanLimits(plan) || fiveHour !== null || weekly !== null
    const limits = [
      { label: '5-hour', percent: fiveHour },
      { label: 'Weekly', percent: weekly },
    ]
    const shownServers = capList(servers, opened.mcp ? servers.length : LIST_CAPS.mcp)
    const shownTodos = capList(list, opened.todos ? list.length : LIST_CAPS.todos)
    const shownFiles = capList(changed, opened.files ? changed.length : LIST_CAPS.files)
    // `+N more` expands a list in full, a click or Enter away; `Show less` folds it back.
    const toggle = (section: ListSection, count: number) =>
      count > LIST_CAPS[section] && (
        <Button
          key={`${section}-toggle`}
          plain
          dimColor
          label={opened[section] ? 'Show less' : `+${count - LIST_CAPS[section]} more`}
          onPress={() => update($, expanded, now => ({ ...now, [section]: !now[section] }))}
        />
      )

    return (
      <Box flexDirection="column" paddingX={1} {...(isDocked ? { minHeight: e.props.scroll.bodyRows } : {})}>
        <Text bold>{name ?? 'New session'}</Text>

        {(email !== null || plan !== null || hasLimits) && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Account</Text>
            {email !== null && (
              <Text dimColor wrap="truncate-end">
                {email}
              </Text>
            )}
            {plan !== null && <Text dimColor>{plan}</Text>}
            {hasLimits &&
              limits.map(limit => (
                <Text>
                  {label(limit.label)}
                  {limit.percent === null ? (
                    <Text dimColor>{glyph('—')}</Text>
                  ) : (
                    <Text color={usageColor(limit.percent)} dimColor={usageColor(limit.percent) === undefined}>
                      {Math.round(limit.percent)}% used
                    </Text>
                  )}
                </Text>
              ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Model</Text>
          <Text dimColor wrap="truncate-end">
            {running.model ?? glyph('—')}
          </Text>
          <Text>
            {label('Effort')}
            <Text dimColor>{running.effort ?? glyph('—')}</Text>
          </Text>
          <Text>
            {label('Ultracode')}
            {running.isUltracode ? <Text color="claude">on</Text> : <Text dimColor>off</Text>}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Context</Text>
          <Text dimColor>{formatCount(used?.tokens ?? 0)} tokens</Text>
          <Text dimColor>{Math.round(used?.percent ?? 0)}% used</Text>
          {used?.usd !== null && used?.usd !== undefined && <Text dimColor>${used.usd.toFixed(2)} spent</Text>}
        </Box>

        {servers.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>MCP</Text>
            {shownServers.shown.map(server => (
              <Text wrap="truncate-end">
                <Text color="success">{glyph('• ')}</Text>
                <Text dimColor>{server}</Text>
              </Text>
            ))}
            {toggle('mcp', servers.length)}
          </Box>
        )}

        {list.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Todo</Text>
            {shownTodos.shown.map(todo => (
              <Text
                color={todo.status === 'in_progress' ? 'claude' : undefined}
                dimColor={todo.status === 'completed'}
                wrap="truncate-end"
              >
                {glyph(todoMark(todo.status))} {todo.content}
              </Text>
            ))}
            {toggle('todos', list.length)}
          </Box>
        )}

        {changed.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Modified Files</Text>
            {shownFiles.shown.map(file => (
              // The counts keep their width at the right edge; only the path gives way, from its start.
              <Box gap={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-start">
                    {file.path}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text>
                    {file.added > 0 && <Text color="success">+{file.added}</Text>}
                    {file.added > 0 && file.removed > 0 && ' '}
                    {file.removed > 0 && <Text color="error">-{file.removed}</Text>}
                  </Text>
                </Box>
              </Box>
            ))}
            {toggle('files', changed.length)}
          </Box>
        )}

        <Box flexGrow={1} />

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate-start">
            {homePath(cwd, home)}
          </Text>
          <Text>
            <Text color="success">{glyph('● ')}</Text>
            <Text bold>Claude Code</Text>
            <Text dimColor> {version}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
