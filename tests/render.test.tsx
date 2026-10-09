import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  capList,
  countPatch,
  describeTool,
  formatDuration,
  hasPlanLimits,
  lineCount,
  mcpServers,
  parseAccount,
  commandStdout,
  parseConfigAccount,
  parseEffortOutput,
  readSettings,
  textPreview,
  toAscii,
  usageColor,
} from '../hooks/format'

const PLUGIN = 'opencode-style'

const TOOL_ROW = {
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
} as const

const PANE = {
  plugin: PLUGIN,
  surface: 'terminal',
  component: 'Pane',
  requestId: 'opencode-sidebar',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// Stands in for Claude Code's own drawing beneath the mod.
function engineDraws(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine draws {e.component}</Text>
  })
}

describe('spinner', () => {
  test('swaps the whimsical word for a plain one on the terminal', async ($, on) => {
    let word = ''
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      word = e.props.word
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.word}</Text>
    })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Spinner',
      props: { word: 'Flibbertigibbeting', message: null, suffix: '…', mode: 'thinking' },
    })

    expect(word).toBe('Thinking')
    await ui.unmount()
  })

  test('leaves the desktop row alone', async ($, on) => {
    let word = ''
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      word = e.props.word
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.word}</Text>
    })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Spinner',
      props: { word: 'Creating notes.md', message: null, suffix: '…', mode: 'tool-use' },
    })

    expect(word).toBe('Creating notes.md')
    await ui.unmount()
  })

  test('keeps the whimsical word when the setting is off', { options: { plainSpinner: false } }, async ($, on) => {
    let word = ''
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      word = e.props.word
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.word}</Text>
    })
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Spinner',
      props: { word: 'Flibbertigibbeting', message: null, suffix: '…', mode: 'thinking' },
    })

    expect(word).toBe('Flibbertigibbeting')
    await ui.unmount()
  })
})

describe('tool rows', () => {
  test('draws a tool call as one OpenCode-style row', async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...TOOL_ROW, tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/src/index.ts' } },
    })

    expect(await ui.find({ type: 'Text', text: /→ Read \/repo\/src\/index\.ts/ })).toBeDefined()
    await ui.unmount()
  })

  test('leaves a standalone command output and error to Claude Code, which ctrl+o expands', async ($, on) => {
    engineDraws(on)
    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        ...TOOL_ROW,
        tool_use_id: 's1',
        tool: 'Bash',
        input: { command: 'npm test' },
        output: { stdout: 'PASS a.test.ts', stderr: '', interrupted: false },
      },
    })
    expect(await row.find({ type: 'Text', text: /\$ npm test/ })).toBeDefined()
    expect(await row.find({ type: 'Text', text: 'PASS a.test.ts' })).toBeUndefined()
    await row.unmount()

    for (const isErrored of [false, true]) {
      const result = await $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'ToolResult',
        props: { tool_use_id: 's1', tool: 'Bash', output: {}, isErrored },
      })
      expect(await result.find({ type: 'Text', text: 'engine draws ToolResult' })).toBeDefined()
      await result.unmount()
    }
  })

  test('shows a grouped command output and error on its own row', async ($, on) => {
    engineDraws(on)
    const group = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolGroup',
      props: {
        calls: [
          { ...TOOL_ROW, tool_use_id: 'g1', tool: 'Bash', input: { command: 'ls' } },
          { ...TOOL_ROW, tool_use_id: 'g2', tool: 'Bash', input: { command: 'cat missing.txt' } },
        ],
        isActive: false,
        isExpanded: false,
      },
    })
    await group.unmount()

    const listing = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: {
        ...TOOL_ROW,
        tool_use_id: 'g1',
        tool: 'Bash',
        input: { command: 'ls' },
        output: { stdout: 'a.ts\nb.ts', stderr: '', interrupted: false },
      },
    })
    expect(await listing.find({ type: 'Text', text: 'b.ts' })).toBeDefined()
    await listing.unmount()

    const failure = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const failed = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...TOOL_ROW, isErrored: true, tool_use_id: 'g2', tool: 'Bash', input: { command: 'cat missing.txt' }, output: failure },
    })
    expect(await failed.find({ type: 'Text', text: 'line 10' })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: 'line 11' })).toBeUndefined()
    expect(await failed.find({ type: 'Text', text: /\+2 lines/ })).toBeDefined()
    await failed.unmount()

    const result = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'g1', tool: 'Bash', output: {}, isErrored: false },
    })
    expect(await result.find({ type: 'Text', text: 'engine draws ToolResult' })).toBeUndefined()
    await result.unmount()
  })

  test('hides the result block of a read but keeps an edit diff', async ($, on) => {
    engineDraws(on)
    const read = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'r1', tool: 'Read', output: {}, isErrored: false },
    })
    expect(await read.find({ type: 'Text', text: 'engine draws ToolResult' })).toBeUndefined()
    await read.unmount()

    const edit = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      props: { tool_use_id: 'e1', tool: 'Edit', output: {}, isErrored: false },
    })
    expect(await edit.find({ type: 'Text', text: 'engine draws ToolResult' })).toBeDefined()
    await edit.unmount()
  })

  test('draws ASCII icons when asked', { options: { asciiIcons: true } }, async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...TOOL_ROW, tool_use_id: 'a1', tool: 'Read', input: { file_path: 'a.ts' } },
    })

    expect(await ui.find({ type: 'Text', text: /-> Read a\.ts/ })).toBeDefined()
    await ui.unmount()
  })

  test('leaves tool rows to Claude Code when the setting is off', { options: { restyleToolRows: false } }, async ($, on) => {
    engineDraws(on)
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...TOOL_ROW, tool_use_id: 'o1', tool: 'Read', input: { file_path: 'a.ts' } },
    })

    expect(await ui.find({ type: 'Text', text: 'engine draws ToolUse' })).toBeDefined()
    await ui.unmount()
  })
})

describe('transcript', () => {
  test('draws the prompt behind a quote bar', async $ => {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'UserMessage',
      props: { text: 'fix the login bug', origin: { kind: 'composer' }, isExpanded: false },
    })

    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { borderStyle: 'quote' } })
    expect(await ui.find({ type: 'Text', text: 'fix the login bug' })).toBeDefined()
    await ui.unmount()
  })

  test('draws the turn footer in place of the baked line', async ($, on) => {
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'TurnDuration',
      props: { word: 'Baked', durationMs: 3200 },
    })

    expect(await ui.find({ type: 'Text', text: /▣ Built · claude-opus-5-5 · 3\.2s/ })).toBeDefined()
    await ui.unmount()
  })

  test('leaves every other surface to Claude Code', async ($, on) => {
    engineDraws(on)
    const sites = [
      { component: 'UserMessage', props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } },
      { component: 'AssistantMessage', props: { text: 'hello', isFirstOfReply: true } },
      { component: 'ToolUse', props: { ...TOOL_ROW, tool_use_id: 'd1', tool: 'Read', input: { file_path: 'a.ts' } } },
    ] as const
    for (const site of sites) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...site })
      expect(await ui.find({ type: 'Text', text: `engine draws ${site.component}` })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('sidebar', () => {
  test('leaves the account section out until something is known', async $ => {
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: 'Account' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    await ui.unmount()
  })

  test('lists the files Claude edits, with lines added and removed', async ($, on) => {
    on('tool.call', { tool: 'Edit' }, () => ({ result: { structuredPatch: [{ lines: ['+a', '+b', '-c'] }] } }))
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'c', new_string: 'a\nb' })
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: 'Modified Files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/repo/a.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
    await ui.unmount()
  })

  test('caps the todo list, and a press on +N more shows the rest', async ($, on) => {
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
    const items = Array.from({ length: 14 }, (_, i) => ({
      content: `step ${i + 1}`,
      status: i === 0 ? ('in_progress' as const) : ('pending' as const),
      activeForm: `doing step ${i + 1}`,
    }))
    await $.tool.call({ tool: 'TodoWrite', todos: items })
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /\[•\] step 1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /step 12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /step 13$/ })).toBeUndefined()
    expect((await ui.find({ key: 'todos-toggle' }))?.text).toBe('+2 more')

    await ui.press({ key: 'todos-toggle' })
    expect(await ui.find({ type: 'Text', text: /step 14$/ })).toBeDefined()
    expect((await ui.find({ key: 'todos-toggle' }))?.text).toBe('Show less')

    await ui.press({ key: 'todos-toggle' })
    expect(await ui.find({ type: 'Text', text: /step 14$/ })).toBeUndefined()
    expect((await ui.find({ key: 'todos-toggle' }))?.text).toBe('+2 more')
    await ui.unmount()
  })
})

describe('format', () => {
  test('describes tools the way OpenCode does', () => {
    expect(describeTool('Bash', { command: 'ls -la\necho hi' }, '/r')).toEqual({ icon: '$', title: 'ls -la' })
    expect(describeTool('Edit', { file_path: '/r/a.ts' }, '/r')).toEqual({ icon: '←', title: 'Edit', detail: 'a.ts' })
    expect(describeTool('mcp__claude_ai_Vercel__list_projects', { teamId: 'x' }, '/r')).toEqual({
      icon: '⚙',
      title: 'claude.ai Vercel list_projects',
      detail: 'x',
    })
  })

  test('formats durations, patches, previews and servers', () => {
    expect(formatDuration(3200)).toBe('3.2s')
    expect(formatDuration(64_000)).toBe('1m 4s')
    expect(countPatch({ structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }] })).toEqual({ added: 2, removed: 1 })
    expect(textPreview('a\nb\nc\n\n', 2)).toEqual({ lines: ['a', 'b'], more: 1 })
    expect(capList([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], more: 0 })
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('')).toBe(0)
    expect(toAscii('▣ → ✱ [✓] …')).toBe('# -> * [x] ...')
    expect(
      mcpServers([
        { name: 'mcp__claude_ai_Vercel__a', mcp: true },
        { name: 'mcp__claude_ai_Vercel__b', mcp: true },
        { name: 'Read', mcp: false },
      ]),
    ).toEqual(['claude.ai Vercel'])
    expect(mcpServers([{ name: 'mcp__plugin_posthog_posthog__query', mcp: true }])).toEqual(['posthog'])
  })

  test('reads its settings, keeping the defaults for anything unset', () => {
    expect(readSettings({})).toMatchObject({ showEmail: false, plainSpinner: true, asciiIcons: false })
    expect(readSettings({ showEmail: true, plainSpinner: 'yes' })).toMatchObject({ showEmail: true, plainSpinner: true })
  })
})

describe('account', () => {
  test('reads the email and plan from Claude Code config', () => {
    expect(parseConfigAccount('{"oauthAccount":{"emailAddress":"a@b.co","organizationType":"claude_max"}}')).toEqual({
      email: 'a@b.co',
      plan: 'Claude Max',
    })
    expect(parseConfigAccount('{"projects":{}}')).toBeNull()
    expect(parseConfigAccount('not json')).toBeNull()
  })

  test('reads the email and plan from auth status', () => {
    expect(parseAccount('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co","subscriptionType":"max"}')).toEqual({
      email: 'a@b.co',
      plan: 'Claude Max',
    })
    expect(parseAccount('{"loggedIn":true,"authMethod":"api-key"}')).toEqual({ email: null, plan: 'API key' })
    expect(parseAccount('not json')).toEqual({ email: null, plan: null })
  })

  test('shows usage windows only for plans that have them', () => {
    expect(hasPlanLimits('Claude Pro')).toBe(true)
    expect(hasPlanLimits('API key')).toBe(false)
    expect(hasPlanLimits(null)).toBe(false)
  })

  test('warns as a window fills', () => {
    expect(usageColor(40)).toBeUndefined()
    expect(usageColor(80)).toBe('warning')
    expect(usageColor(94)).toBe('error')
  })
})

describe('model section', () => {
  test('reads what /effort printed', () => {
    expect(parseEffortOutput('Ultracode on (this session only): runs workflows. Effort stays high.')).toEqual({
      effort: 'high',
      isUltracode: true,
    })
    expect(parseEffortOutput('Ultracode off. Effort stays medium.')).toEqual({ effort: 'medium', isUltracode: false })
    expect(parseEffortOutput('Set effort level to xhigh (this session only)')).toEqual({ effort: 'xhigh' })
    expect(parseEffortOutput('Something else')).toEqual({})
  })

  test('starts with effort unknown and ultracode off', async $ => {
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: 'Model' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Effort\s+—$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Ultracode\s+off$/ })).toBeDefined()
    await ui.unmount()
  })

  test('reads /effort output from the row that stores it', () => {
    const row = [
      {
        type: 'text',
        text: '<local-command-stdout>Ultracode on (this session only): dynamic workflows on every task. Effort stays medium.</local-command-stdout>',
      },
    ]
    expect(parseEffortOutput(commandStdout(row))).toEqual({ effort: 'medium', isUltracode: true })
    expect(commandStdout([{ type: 'text', text: '<command-name>/effort</command-name>' }])).toBe('')
    expect(commandStdout('not blocks')).toBe('')
  })

  test('takes the effort a finished turn ran at', async ($, on) => {
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, effort: { level: 'xhigh' } })
    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: /^Effort\s+xhigh$/ })).toBeDefined()
    await ui.unmount()
  })
})
