import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { LastTurn, Limit, Plan, Snapshot } from '../types'

// How long the prompt cache lives after the last response. The engine does not
// report it; this session runs on the 1-hour cache (5 minutes when in overage).
const CACHE_TTL_MS = 60 * 60_000
// Below this share of the TTL left, the cache reads as cooling.
const COOLING_SHARE = 0.25
const TICK_MS = 30_000

const HOUR_MS = 60 * 60_000
const WEEKLY = 'seven_day'
const FIVE_HOUR = 'five_hour'

// The account's plan windows, per-model ones included: what the app's usage
// card reads. The engine's own `rateLimits` carries the all-models windows only.
const PLAN_URL = 'https://api.anthropic.com/api/oauth/usage'
const PLAN_EVERY_MS = 5 * 60_000
// A turn's end asks again only this long after the last answer.
const PLAN_MIN_GAP_MS = 60_000

// Usage levels: where yellow and red start, in percent.
const WARN = 70
const DANGER = 90
// A window's bar, in cells.
const BAR_CELLS = 16

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const lastTurn = atom({ plugin: 'usage-band', key: 'lastTurn' } as const, null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const plan = atom({ plugin: 'usage-band', key: 'plan' } as const, null)

const toSnapshot = (
  usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>,
): Snapshot => ({
  contextPercent: usage.context.percent,
  limits: usage.rateLimits.map(
    (limit): Limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      resetsAt: limit.resetsAt,
    }),
  ),
  costUsd: usage.cost?.usd,
})

// The endpoint's `limits` list holds one entry per window the plan has:
// `{ kind, group, percent, resets_at, scope }`, a per-model window naming its
// model under `scope.model.display_name` (`weekly_all`, then `weekly_scoped`
// for Fable). Each becomes a kind this module names: `seven_day`,
// `seven_day_fable`, `five_hour`.
const toLimits = (body: unknown): Limit[] => {
  const list = (body as { limits?: unknown } | null)?.limits

  if (!Array.isArray(list)) {
    return []
  }

  const limits = list.flatMap((entry): Limit[] => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }

    const { kind, group, percent, resets_at: resetsAt, scope } = entry as {
      kind?: unknown
      group?: unknown
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown } | null } | null
    }

    if (typeof percent !== 'number') {
      return []
    }

    const label = `${String(group ?? '')} ${String(kind ?? '')}`
    const base = label.includes('week')
      ? WEEKLY
      : label.includes('five') || label.includes('session')
        ? FIVE_HOUR
        : String(kind ?? 'limit')
    const model = scope?.model?.display_name
    const suffix =
      typeof model === 'string' && model !== ''
        ? `_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
        : ''

    return [
      {
        kind: `${base}${suffix}`,
        percentUsed: Math.round(percent),
        resetsAt: typeof resetsAt === 'string' ? resetsAt : undefined,
      },
    ]
  })
  const rank = (kind: string): number => {
    if (kind.startsWith(FIVE_HOUR)) {
      return kind === FIVE_HOUR ? 0 : 1
    }

    return kind === WEEKLY ? 2 : 3
  }

  return limits.sort((a, b) => rank(a.kind) - rank(b.kind))
}

const FILLER = new Set([
  'seven', 'day', 'days', 'weekly', 'week', 'model', 'models', 'limit',
  'limits', 'usage', 'per', 'rate', 'window', 'windows', 'claude',
])

const capitalize = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1)

// `seven_day` is the all-models week; `seven_day_fable` a model's own.
const limitName = (kind: string): string => {
  if (kind === FIVE_HOUR) {
    return '5-hour'
  }

  if (kind === WEEKLY) {
    return 'Weekly'
  }

  // What is left once the words that only say "a weekly limit" are gone is
  // the model's name: `seven_day_fable`, `model_limits_fable_weekly`.
  const words = kind.split('_').filter(word => !FILLER.has(word) && word !== '')

  return words.length === 0 ? 'Weekly' : words.map(capitalize).join(' ')
}

// How long the window runs, to place the marker of time elapsed in it.
const windowMs = (kind: string): number | undefined => {
  if (kind.includes(FIVE_HOUR)) {
    return 5 * HOUR_MS
  }

  return kind.includes(WEEKLY) || kind.includes('week')
    ? 7 * 24 * HOUR_MS
    : undefined
}

const span = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }

  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const moment = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })

const levelColor = (percent: number): string => {
  if (percent >= DANGER) {
    return '#ef4444'
  }

  return percent >= WARN ? '#eab308' : '#22c55e'
}

// The bar as three runs around the marker of time elapsed: the filled cells,
// the empty ones, and where in them the marker stands (absent, no marker).
const bar = (percent: number, elapsedShare: number | undefined) => {
  const filled = Math.min(
    BAR_CELLS,
    Math.max(0, Math.round((percent / 100) * BAR_CELLS)),
  )
  const marker =
    elapsedShare === undefined
      ? undefined
      : Math.min(
          BAR_CELLS - 1,
          Math.max(0, Math.floor(elapsedShare * BAR_CELLS)),
        )
  const cells = Array.from({ length: BAR_CELLS }, (_, index) => ({
    isFilled: index < filled,
    isMarker: index === marker,
  }))

  return {
    filledBefore: cells.filter((c, i) => c.isFilled && !c.isMarker && (marker === undefined || i < marker)).length,
    emptyBefore: cells.filter((c, i) => !c.isFilled && !c.isMarker && marker !== undefined && i < marker).length,
    hasMarker: marker !== undefined,
    filledAfter: cells.filter((c, i) => c.isFilled && marker !== undefined && i > marker).length,
    emptyAfter: cells.filter((c, i) => !c.isFilled && !c.isMarker && (marker === undefined || i > marker)).length,
  }
}

let askedAt = 0

// Reads the plan windows with the session's own credential, which the host
// holds and sets on the request: this module never sees it.
async function refreshPlan($: EngineInterface, minGapMs: number) {
  const at = await $.clock.now()

  if (at - askedAt < minGapMs) {
    return
  }

  askedAt = at
  let limits: Limit[] = []
  let error: string | undefined

  try {
    const auth = await $.session.authorize()

    if (auth === null) {
      error = 'no Claude login in this session'
    } else {
      const reply = await $.http.fetch(PLAN_URL, {
        auth: auth.handle,
        headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      })

      if (reply.ok) {
        limits = toLimits(JSON.parse(reply.text))
        error = limits.length === 0 ? 'no windows in the answer' : undefined
      } else {
        error = `HTTP ${reply.status}`
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  // A failed read keeps the windows last read, and says so.
  await update($, plan, old => ({
    at,
    limits: error === undefined ? limits : (old?.limits ?? []),
    error,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const seed = toSnapshot(await $.session.usage())
    const startedAt = await $.clock.now()
    await update($, snapshot, () => seed)
    await update($, now, () => startedAt)
    $.clock.every(TICK_MS, () => {
      void $.clock.now().then(at => update($, now, () => at))
    })
    $.clock.every(PLAN_EVERY_MS, () => {
      void refreshPlan($, PLAN_MIN_GAP_MS)
    })
    void refreshPlan($, 0)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const reading = toSnapshot(e)
    await update($, snapshot, () => reading)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const at = await $.clock.now()
    const used = e.usage
    const input = used
      ? used.input_tokens +
        used.cache_read_input_tokens +
        used.cache_creation_input_tokens
      : 0
    const turn: LastTurn = {
      at,
      cacheReadPercent:
        used && input > 0
          ? Math.round((used.cache_read_input_tokens / input) * 100)
          : undefined,
    }
    await update($, lastTurn, () => turn)
    await update($, now, () => at)
    void refreshPlan($, PLAN_MIN_GAP_MS)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const usage = await read($, snapshot)
    const turn = await read($, lastTurn)
    const clock = await read($, now)
    const account = await read($, plan)

    const source: Limit[] =
      account !== null && account.limits.length > 0
        ? account.limits
        : (usage?.limits ?? [])
    const limits = source.map(limit => {
      const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
      const length = windowMs(limit.kind)
      const elapsed =
        length === undefined || Number.isNaN(resetsAt) || clock === 0
          ? undefined
          : 1 - (resetsAt - clock) / length

      return {
        percent: limit.percentUsed,
        color: levelColor(limit.percentUsed),
        cells: bar(limit.percentUsed, elapsed),
        name: limitName(limit.kind),
        resetsAt,
      }
    })
    const resetText = (resetsAt: number): string => {
      const left = resetsAt - clock

      return `resets ${moment(resetsAt)}${clock > 0 && left > 0 ? ` (in ${span(left)})` : ''}`
    }
    const resets = limits.map(one => one.resetsAt).filter(at => !Number.isNaN(at))
    const first = resets[0]
    // Windows that reset together say so once, at the end of the line.
    const sharedReset =
      first !== undefined &&
      resets.length === limits.length &&
      resets.every(at => Math.abs(at - first) < 60_000)
        ? first
        : undefined

    let cacheText = 'Cache unknown until next turn'
    let cacheColor: string | undefined

    if (e.props.isWorking) {
      cacheText = 'Cache in use'
      cacheColor = 'green'
    } else if (turn !== null) {
      const left = CACHE_TTL_MS - (clock - turn.at)
      const served =
        turn.cacheReadPercent === undefined
          ? ''
          : `, ${turn.cacheReadPercent}% read last turn`

      if (left <= 0) {
        cacheText = `Cache cold (expired ${span(-left)} ago)`
        cacheColor = 'red'
      } else if (left < CACHE_TTL_MS * COOLING_SHARE) {
        cacheText = `Cache cooling, ${span(left)} left${served}`
        cacheColor = 'yellow'
      } else {
        cacheText = `Cache warm, ${span(left)} left${served}`
        cacheColor = 'green'
      }
    }

    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text>
          <Text
            dimColor={usage?.contextPercent === undefined}
            color={
              (usage?.contextPercent ?? 0) >= WARN
                ? levelColor(usage?.contextPercent ?? 0)
                : undefined
            }
          >
            Context{' '}
            {usage?.contextPercent === undefined
              ? '–'
              : `${usage.contextPercent}%`}
          </Text>
          <Text color={cacheColor}>
            {'  ·  '}
            {cacheText}
          </Text>
        </Text>
          {sharedReset !== undefined && (
            <Text dimColor>{resetText(sharedReset)}</Text>
          )}
        </Box>
        {limits.length > 0 && (
          <Text>
            {limits.map((limit, index) => (
              <Text>
                {index > 0 && <Text dimColor>{'   ·   '}</Text>}
                <Text bold>{limit.name} </Text>
                <Text color={limit.color}>
                  {'━'.repeat(limit.cells.filledBefore)}
                </Text>
                <Text dimColor>{'━'.repeat(limit.cells.emptyBefore)}</Text>
                {limit.cells.hasMarker && <Text bold>┃</Text>}
                <Text color={limit.color}>
                  {'━'.repeat(limit.cells.filledAfter)}
                </Text>
                <Text dimColor>{'━'.repeat(limit.cells.emptyAfter)}</Text>
                <Text bold color={limit.color}>
                  {' '}
                  {limit.percent}%
                </Text>
                {sharedReset === undefined && !Number.isNaN(limit.resetsAt) && (
                  <Text dimColor> {resetText(limit.resetsAt)}</Text>
                )}
              </Text>
            ))}
          </Text>
        )}
        {account?.error !== undefined && (
          <Text dimColor>Per-model usage not read: {account.error}</Text>
        )}
      </Box>
    )
  })
}
