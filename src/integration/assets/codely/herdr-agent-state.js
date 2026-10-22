// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks beside this file instead of editing it.
// HERDR_INTEGRATION_ID=codely
// HERDR_INTEGRATION_VERSION=2

// Codely hook that reports lifecycle state and session identity to Herdr.
// Registered from ~/.codely-cli/settings.json as
// `node "<this file>" <event>` for the managed Codely events (see the herdr
// codely integration). Outside a Herdr pane (HERDR_ENV != "1") every action is
// a no-op.
//
// Hook discipline:
//   - stdout must stay empty; Codely parses hook stdout as hook output
//     (decisions / injected context). Diagnostics go to stderr only.
//   - Never fail the agent: swallow every error and exit 0.
//   - Never spend the whole hook timeout. Codely runs this file through a
//     shell (pwsh/powershell/cmd) and kills the hook when the registered
//     timeout expires, so every wait below is bounded: a harness that never
//     closes stdin cannot stall a tool call, and the event name on argv keeps
//     the report intact when the payload never arrives.

'use strict';

const { spawnSync } = require('node:child_process');

const SOURCE = 'herdr:codely';
const AGENT = 'codely';
const SPAWN_TIMEOUT_MS = 3000;
const MAX_MESSAGE_LEN = 160;
// Stdin owns the payload, but the harness (or the shell it runs us through)
// may keep the pipe open; report from argv instead of waiting forever.
const STDIN_GRACE_MS = 1200;
// One budget for every report this process sends, so SessionStart cannot spend
// twice the single-report latency before exiting.
const REPORT_BUDGET_MS = 2000;
// Worst case is STDIN_GRACE_MS + REPORT_BUDGET_MS, which leaves headroom under
// the registered hook timeout; below this remaining budget a CLI spawn cannot
// finish meaningfully, so the report is dropped instead.
const MIN_REPORT_BUDGET_MS = 100;

// Codely event -> Herdr report kind. The registered hook entries live in the
// herdr installer (CODELY_MANAGED_EVENTS); keep the two lists in sync.
// SessionEnd is deliberately not registered: Herdr ignores release reports
// from official sources and handles process exit itself, and the clear/compact
// flows fire SessionStart again right after.
const EVENT_ACTIONS = {
  SessionStart: 'session',
  BeforeAgent: 'working',
  BeforeTool: 'working',
  Notification: 'blocked',
  PermissionRequest: 'blocked',
  AfterAgent: 'idle',
};

// SessionStart also fires after every compaction (source: "compact"); the
// session identity is still valid there, but the agent may be mid-turn, so
// only these sources imply the agent is idle and waiting for input.
const IDLE_SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear']);

let lastSeq = 0;
// Set once the payload (or the stdin grace period) is handled; reports consult
// it so a slow Herdr CLI can never push the hook past its own deadline.
let reportDeadline = 0;

// Strictly increasing per process and epoch-based across processes, so Herdr
// can discard out-of-order reports from the same source.
function nextSeq() {
  const now = Date.now();
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return String(lastSeq);
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_MESSAGE_LEN
    ? collapsed.slice(0, MAX_MESSAGE_LEN - 1) + '…'
    : collapsed;
}

function herdrBinPath(env) {
  const bin = env?.HERDR_BIN_PATH;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : 'herdr';
}

function report(herdr, args) {
  const budget = reportDeadline - Date.now();
  if (budget < MIN_REPORT_BUDGET_MS) return;
  try {
    spawnSync(herdr, args, {
      timeout: Math.min(SPAWN_TIMEOUT_MS, budget),
      stdio: 'ignore',
    });
  } catch (err) {
    process.stderr.write(`herdr-agent-state: failed to run ${herdr}: ${err}\n`);
  }
}

function run(payload, env, hintedEvent) {
  const paneId = typeof env?.HERDR_PANE_ID === 'string' ? env.HERDR_PANE_ID.trim() : '';
  if (!paneId) return;
  if (!env?.HERDR_BIN_PATH) return;

  // The payload is authoritative; the registered event name is the fallback for
  // a hook invocation whose stdin never produced a payload.
  const payloadEvent =
    typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : '';
  const event = EVENT_ACTIONS[payloadEvent] ? payloadEvent : hintedEvent;
  const action = event ? EVENT_ACTIONS[event] : undefined;
  if (!action) return;

  // Events triggered by a subagent carry agent_id; they describe a nested
  // agent, not the main loop, so ignore them.
  if (typeof payload?.agent_id === 'string' && payload.agent_id.trim()) return;

  const herdr = herdrBinPath(env);
  if (action === 'session') {
    const sessionId = cleanText(payload?.session_id);
    if (!sessionId) return;
    const args = [
      'pane',
      'report-agent-session',
      paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--seq',
      nextSeq(),
      '--agent-session-id',
      sessionId,
    ];
    const transcriptPath = cleanText(payload?.transcript_path);
    if (transcriptPath) args.push('--agent-session-path', transcriptPath);
    const startSource = cleanText(payload?.source);
    if (startSource) args.push('--session-start-source', startSource);
    report(herdr, args);

    if (IDLE_SESSION_START_SOURCES.has(startSource ?? '')) {
      report(herdr, [
        'pane',
        'report-agent',
        paneId,
        '--source',
        SOURCE,
        '--agent',
        AGENT,
        '--state',
        'idle',
        '--seq',
        nextSeq(),
      ]);
    }
    return;
  }

  const args = [
    'pane',
    'report-agent',
    paneId,
    '--source',
    SOURCE,
    '--agent',
    AGENT,
    '--state',
    action,
    '--seq',
    nextSeq(),
  ];
  if (action === 'blocked') {
    const detail =
      cleanText(payload?.tool_name) ||
      cleanText(payload?.notification_type) ||
      cleanText(payload?.message);
    if (detail) args.push('--message', `waiting for input: ${detail}`);
  }
  report(herdr, args);
}

function runHook() {
  if (process.env.HERDR_ENV !== '1') return;
  if (!process.env.HERDR_PANE_ID) return;

  const hintedEvent =
    typeof process.argv[2] === 'string' && process.argv[2].trim() ? process.argv[2].trim() : '';
  const input = [];
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;

    let payload = {};
    const text = input.join('').replace(/^\uFEFF/, '');
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        process.stderr.write(`herdr-agent-state: ignoring invalid hook payload: ${err}\n`);
      }
    }
    reportDeadline = Date.now() + REPORT_BUDGET_MS;
    try {
      run(payload, process.env, hintedEvent);
    } catch (err) {
      process.stderr.write(`herdr-agent-state: report failed: ${err}\n`);
    } finally {
      process.exit(0);
    }
  }

  const stdinGrace = setTimeout(finish, STDIN_GRACE_MS);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => input.push(chunk));
  process.stdin.on('error', () => {
    clearTimeout(stdinGrace);
    finish();
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinGrace);
    finish();
  });
  // Some harnesses destroy the pipe instead of ending it.
  process.stdin.on('close', () => {
    clearTimeout(stdinGrace);
    finish();
  });
}

if (require.main === module) {
  runHook();
}
