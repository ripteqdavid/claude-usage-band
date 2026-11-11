export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
}

/** The last finished main-thread turn: when it ended and how much of its input the cache served. */
export type LastTurn = { at: number; cacheReadPercent?: number }

/**
 * The account's plan windows as the usage endpoint last answered, per-model
 * ones included; `error` says why the last request gave none.
 */
export type Plan = { at: number; limits: Limit[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      lastTurn: LastTurn | null
      now: number
      plan: Plan | null
    }
  }
}
