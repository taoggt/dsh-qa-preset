/**
 * dsh-qa-preset — host-side enforcement for the `qa` Agent preset.
 *
 * A preset composition only changes the plugins mounted for that preset. Tools
 * registered by HOST-global rows (computer-use, agent-team, working_directory,
 * load_workspace_dependencies, …) are still inherited by every session, so the
 * read-only preset alone cannot keep them out of the model request. This plugin
 * closes that gap for agents whose effective preset is `qa`:
 *
 *  - an agent-scoped restriction hides every non-allowlisted inherited tool from
 *    the model request (the restriction is registered through `agent.ctx`, so it
 *    never touches another session), and
 *  - a monotonic agent-scoped guard rejects any execution that still reaches the
 *    tool pipeline (own-layer tools cannot be restricted, and a tool registered
 *    after hydration may briefly outrun the restriction).
 *
 * All other agents are left completely untouched: no guard, no restriction, no
 * prompt change. The preset persona already carries the policy, so this plugin
 * adds no prompt section, command, projection or banner.
 *
 * Plain Cordis function plugin with no module loading statements: the bundle is
 * linked from the workspace profile, where `@deepseek-ai/*` does not resolve.
 */

export const name = 'dsh-qa-preset/enforce'

/**
 * Hard service dependencies. `agentPresets` implies `sessionProjections`: the
 * registry requires that service and registers the durable `agentPreset`
 * projection this plugin reads.
 */
export const inject = ['tools', 'agentPresets']

/** Effective preset id this plugin enforces (the declaration in cordis.patch.yml). */
const QA_PRESET_ID = 'qa'

/** Registry-owned Session projection holding the durably selected preset id. */
const AGENT_PRESET_PROJECTION = 'agentPreset'

/** Reserved PTC presentation transport; `tools.restrict` refuses to name it. */
const RUN_CODE_TOOL = 'run_code'

/**
 * The complete model-facing read-only surface of a qa-preset session. Anything
 * else visible to the agent is hidden from the request and denied if executed.
 */
const ALLOWED_TOOLS = Object.freeze([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'skill',
  'ask_user_question',
])

/** Model-facing denial produced by the monotonic guard. */
function denialText(toolName) {
  return `仅问答模式预设已启用：禁止执行「${toolName}」。该会话只能读取和分析文件；如需修改，请新建使用其他模式的会话。`
}

/** Render an arbitrary thrown value without trusting its string coercion. */
function describeError(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unrenderable error'
  }
}

/** Name projection of one `tools.schemas()` result. */
function schemaNames(schemas) {
  if (!Array.isArray(schemas)) throw new Error('tools.schemas() did not return an array')
  const names = []
  for (const schema of schemas) {
    if (schema !== undefined && schema !== null && typeof schema.name === 'string' && schema.name !== '') {
      names.push(schema.name)
    }
  }
  return names
}

/**
 * Names the registry rejected as "unknown global tools". In this mode those are
 * the agent's own-layer registrations: visible to the model, but not expressible
 * by `tools.restrict` (which only filters inherited layers).
 */
function unknownRestrictNames(error) {
  const message = describeError(error)
  const match = /unknown global tools? ((?:"[^"]*"(?:, )?)+)/.exec(message)
  if (match === null) return new Set()
  const names = new Set()
  for (const quoted of match[1].matchAll(/"([^"]*)"/g)) names.add(quoted[1])
  return names
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const allowed = new Set(ALLOWED_TOOLS)

  /** sessionId -> per-agent enforcement entry. */
  const agents = new Map()
  /** Keys already reported, so a per-step failure logs once instead of spamming. */
  const warned = new Set()
  /** Registry-owned projection service (present whenever `agentPresets` is). */
  const sessionProjections = ctx.get('sessionProjections')

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn(message)
  }

  // -- preset resolution ----------------------------------------------------

  /**
   * Resolve the preset the live agent effectively runs.
   *
   * The durable selection is preferred over the creation header. The registry
   * itself reconstructs from the `agentPreset` Session projection (never from the
   * header alone): a session can be created under the default preset and then be
   * re-selected while still blank, which leaves the header stale while the log
   * records the real preset. `composedPreset(ctx)` is the fallback for a session
   * whose projection carries no selection yet; it reads the composition the
   * agent is actually bound to.
   */
  function presetIdOf(agent) {
    const projections = sessionProjections === undefined ? ctx.get('sessionProjections') : sessionProjections
    if (projections !== undefined && projections !== null) {
      try {
        const state = projections.stateOf(agent.session, AGENT_PRESET_PROJECTION)
        if (typeof state === 'string' && state !== '') return state
      } catch (error) {
        warnOnce('projection', `dsh-qa-preset/enforce: cannot read the agentPreset projection: ${describeError(error)}`)
      }
    }
    try {
      const id = ctx.agentPresets.composedPreset(agent.ctx)
      if (typeof id === 'string' && id !== '') return id
    } catch (error) {
      warnOnce('composed', `dsh-qa-preset/enforce: cannot read the composed preset: ${describeError(error)}`)
    }
    return undefined
  }

  /** Live agent for one session id, when the runtime exposes the agent service. */
  function lookupAgent(sessionId) {
    if (sessionId === undefined || sessionId === null) return undefined
    let runtime
    try {
      runtime = ctx.get('agents')
    } catch (error) {
      return undefined
    }
    if (runtime === undefined || runtime === null || typeof runtime.get !== 'function') return undefined
    try {
      return runtime.get(sessionId)
    } catch (error) {
      return undefined
    }
  }

  // -- per-agent enforcement ------------------------------------------------

  /**
   * Install or refresh enforcement for one agent. Idempotent; called from
   * `agent/created`, `agent-preset/selected`, every `agent/pre-step`, and the
   * adoption pass for agents that already exist when this plugin loads.
   *
   * A qa agent gets one guard and one dynamic restriction. Any other preset
   * disposes whatever we installed earlier (a blank session may change preset
   * before its first turn) and is otherwise untouched.
   */
  function ensureAgent(agent) {
    if (agent === undefined || agent === null) return undefined
    let session
    let sessionId
    try {
      session = agent.session
      sessionId = session === undefined || session === null ? undefined : session.id
    } catch (error) {
      warnOnce('session', `dsh-qa-preset/enforce: cannot read an agent session: ${describeError(error)}`)
      return undefined
    }
    if (sessionId === undefined || sessionId === null) return undefined

    const existing = agents.get(sessionId)
    let presetId
    try {
      presetId = presetIdOf(agent)
    } catch (error) {
      warnOnce('preset', `dsh-qa-preset/enforce: cannot resolve the agent preset: ${describeError(error)}`)
      return existing
    }
    if (presetId !== QA_PRESET_ID) {
      // Not a qa-preset session: lift our registrations, install nothing.
      if (existing !== undefined) disposeEntry(existing)
      return undefined
    }
    if (existing !== undefined && existing.agent === agent) {
      try {
        reconcile(existing)
      } catch (error) {
        warnOnce(`reconcile:${String(sessionId)}`, `dsh-qa-preset/enforce: reconcile failed for session ${String(sessionId)}: ${describeError(error)}`)
      }
      return existing
    }
    // A different agent object for the same durable session (resume/fork): the
    // old scoped registrations belong to the disposed agent, so drop them first.
    if (existing !== undefined) disposeEntry(existing)

    const entry = {
      agent,
      session,
      /** Tool names observed for this agent (root + agent view), monotonic. */
      catalogNames: new Set(),
      /** Visible names `tools.restrict` reports as unknown (agent own layer). */
      unrestrictableNames: new Set(),
      guardDispose: undefined,
      restrictionDispose: undefined,
      restrictionKey: undefined,
    }
    try {
      // Guard first: it is the monotonic backstop, so a failed or stale
      // restriction can never open an execution path.
      entry.guardDispose = agent.ctx.tools.guard((execution) => guardExecution(execution))
    } catch (error) {
      warnOnce(`guard:${String(sessionId)}`, `dsh-qa-preset/enforce: could not install the tool guard for session ${String(sessionId)}: ${describeError(error)}`)
      disposeEntry(entry)
      return undefined
    }
    agents.set(sessionId, entry)
    try {
      reconcile(entry)
    } catch (error) {
      warnOnce(`reconcile:${String(sessionId)}`, `dsh-qa-preset/enforce: reconcile failed for session ${String(sessionId)}: ${describeError(error)}`)
    }
    return entry
  }

  /**
   * Monotonic tool guard: every execution that is not one of the eight read-only
   * tools is denied while the agent is bound to the qa preset. It is registered
   * only for qa agents, so it never affects another session. It is retained even
   * if the restriction fails, and covers own-layer tools and PTC sub-dispatches.
   */
  function guardExecution(execution) {
    try {
      if (execution === undefined || execution === null) return undefined
      const toolName = execution.name
      if (typeof toolName !== 'string' || toolName === '') return undefined
      if (allowed.has(toolName)) return undefined
      return denialText(toolName)
    } catch (error) {
      // Never wedge a turn on an unexpected evaluation failure.
      warnOnce('guard-eval', `dsh-qa-preset/enforce: tool guard failed to evaluate: ${describeError(error)}`)
      return undefined
    }
  }

  /**
   * Recompute the scoped restriction from the tool catalog the agent can
   * actually see. Every visible tool except the allowlist and the reserved
   * `run_code` transport is denied; own-layer names are dropped after the
   * registry's unknown-name error and remain covered by the guard.
   *
   * The candidate set is the agent-visible `ctx.tools.schemas(agent)` (global +
   * preset/ancestor + own layers) merged with the root view. Restrictions filter
   * inherited tools only, so once our restriction is installed the agent view
   * shrinks to the allowlist (plus the always-visible own layer); the per-entry
   * catalog accumulates what has been observed so the mask does not oscillate.
   * The root view is merged too, so a host-global tool registered after agent
   * hydration is still picked up even while our restriction hides it.
   */
  function reconcile(entry) {
    try {
      refreshCatalog(entry)
    } catch (error) {
      warnOnce('catalog', `dsh-qa-preset/enforce: cannot read the tool catalog: ${describeError(error)}`)
      return
    }
    const deny = restrictableDeny(entry)
    if (deny.length === 0) {
      clearRestriction(entry)
      return
    }
    if (entry.restrictionDispose !== undefined && entry.restrictionKey === deny.join('\n')) return
    const applied = applyRestriction(entry, deny)
    if (applied === undefined) return // Keep the previous restriction; the guard still denies executions.
    // Register the replacement before dropping the old one: the intersection of
    // two deny masks is momentarily stricter, never looser.
    clearRestriction(entry)
    entry.restrictionDispose = applied.dispose
    entry.restrictionKey = applied.key
  }

  /** Record every tool name the root view and the agent view currently expose. */
  function refreshCatalog(entry) {
    for (const name of schemaNames(ctx.tools.schemas(entry.agent))) entry.catalogNames.add(name)
    for (const name of schemaNames(ctx.tools.schemas())) entry.catalogNames.add(name)
  }

  /**
   * Sorted deny candidates: every tool seen for this agent, minus the allowlist,
   * the reserved `run_code` transport, and names the registry cannot restrict.
   */
  function restrictableDeny(entry) {
    const deny = []
    for (const toolName of entry.catalogNames) {
      if (toolName === RUN_CODE_TOOL) continue
      if (allowed.has(toolName)) continue
      if (entry.unrestrictableNames.has(toolName)) continue
      deny.push(toolName)
    }
    deny.sort()
    return deny
  }

  /**
   * Apply one deny mask, retrying once without names the registry reports as
   * unknown (own-layer tools). Returns the disposer plus the cache key of the
   * names actually applied, or undefined when nothing restrictable remains.
   */
  function applyRestriction(entry, candidates) {
    let names = candidates
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const dispose = entry.agent.ctx.tools.restrict({ deny: names })
        return { dispose, key: names.join('\n') }
      } catch (error) {
        lastError = error
        const unrestrictable = unknownRestrictNames(error)
        if (unrestrictable.size === 0) break
        for (const name of unrestrictable) entry.unrestrictableNames.add(name)
        names = candidates.filter((name) => !entry.unrestrictableNames.has(name))
        if (names.length === 0) {
          warnOnce(`restrict-empty:${String(entry.session.id)}`, `dsh-qa-preset/enforce: no restrictable tools remain for session ${String(entry.session.id)}; the guard still denies their execution`)
          return undefined
        }
      }
    }
    warnOnce(`restrict:${String(entry.session.id)}`, `dsh-qa-preset/enforce: could not restrict tools for session ${String(entry.session.id)}: ${describeError(lastError)}`)
    return undefined
  }

  function clearRestriction(entry) {
    const dispose = entry.restrictionDispose
    entry.restrictionDispose = undefined
    entry.restrictionKey = undefined
    if (dispose === undefined) return
    try {
      dispose()
    } catch (error) {
      ctx.logger.warn(`dsh-qa-preset/enforce: restriction cleanup failed: ${describeError(error)}`)
    }
  }

  /** Unwind every registration owned by one agent and forget the entry. */
  function disposeEntry(entry) {
    if (entry === undefined || entry === null) return
    const sessionId = entry.session === undefined || entry.session === null ? undefined : entry.session.id
    if (sessionId !== undefined && agents.get(sessionId) === entry) agents.delete(sessionId)
    clearRestriction(entry)
    const guardDispose = entry.guardDispose
    entry.guardDispose = undefined
    if (typeof guardDispose === 'function') {
      try {
        guardDispose()
      } catch (error) {
        ctx.logger.warn(`dsh-qa-preset/enforce: tool guard cleanup failed: ${describeError(error)}`)
      }
    }
  }

  // -- registrations --------------------------------------------------------

  // Root-fiber cleanup: plugin unload disposes every per-agent registration even
  // if the agent fibers outlive this plugin (agent disposal also cleans its own).
  ctx.effect(() => () => {
    for (const entry of [...agents.values()]) disposeEntry(entry)
    agents.clear()
  }, 'dsh-qa-preset/enforce: per-agent enforcement')

  // Install as early as the agent is announced; pre-step remains the safety net.
  ctx.on('agent/created', (payload) => {
    const agent = payload === undefined || payload === null ? undefined : payload.agent
    try {
      ensureAgent(agent)
    } catch (error) {
      warnOnce('created', `dsh-qa-preset/enforce: agent/created enforcement failed: ${describeError(error)}`)
    }
  })

  // A still-blank session may change preset (also leaves the header stale): the
  // durable selection event is what tells us to enforce or to stand down.
  ctx.on('agent-preset/selected', (sessionId) => {
    try {
      const agent = lookupAgent(sessionId)
      if (agent !== undefined) ensureAgent(agent)
    } catch (error) {
      warnOnce('selected', `dsh-qa-preset/enforce: preset selection enforcement failed: ${describeError(error)}`)
    }
  })

  // Enforcement is refreshed before each step's request/tool-schema assembly, so
  // a session restored from the log is protected from its very first turn.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      ensureAgent(agent)
    } catch (error) {
      warnOnce('pre-step', `dsh-qa-preset/enforce: pre-step enforcement failed: ${describeError(error)}`)
    }
    return next()
  })

  // Drop the per-agent bookkeeping when its agent goes away. Scoped registrations
  // unwound with the agent fiber already; the explicit disposers are harmless.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload === undefined || payload === null ? undefined : payload.agent
    if (agent === undefined || agent === null) return
    let sessionId
    try {
      sessionId = agent.session === undefined || agent.session === null ? undefined : agent.session.id
    } catch (error) {
      return
    }
    if (sessionId === undefined || sessionId === null) return
    const entry = agents.get(sessionId)
    if (entry === undefined || entry.agent !== agent) return
    disposeEntry(entry)
  })

  // Adopt agents that already exist when this plugin loads (e.g. a live session
  // in a host that composed this row after the agent was announced).
  try {
    const runtime = ctx.get('agents')
    if (runtime !== undefined && runtime !== null && typeof runtime.list === 'function') {
      for (const agent of runtime.list()) {
        try {
          ensureAgent(agent)
        } catch (error) {
          warnOnce('adopt', `dsh-qa-preset/enforce: could not adopt an existing agent: ${describeError(error)}`)
        }
      }
    }
  } catch (error) {
    warnOnce('adopt', `dsh-qa-preset/enforce: could not enumerate existing agents: ${describeError(error)}`)
  }
}
