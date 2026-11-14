import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import ts from 'typescript';
import * as lifecycle from '../extensions/oracle/shared/job-lifecycle-helpers.mjs';
import * as budgets from '../extensions/oracle/shared/recollection-budget.mjs';
import * as flow from '../extensions/oracle/worker/chatgpt-flow-helpers.mjs';
import * as capture from '../extensions/oracle/worker/response-capture.mjs';
import { deriveAssistantCompletionSignature, parseDeepResearchWidgetText } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';
import { detectCompletionFailure } from '../extensions/oracle/worker/provider-page-signals.mjs';

const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['runRecollection', 'waitForChatCompletion', 'reconcileStreamedTurn', 'waitForDeepResearchReport',
  'collectBoundResult', 'flushArtifactsState', 'preserveCaptureFile', 'secureWriteText', 'ensurePrivateDir',
  'withHeartbeatWhile', 'persistRecollectionIdentity', 'OracleWorkerError'];
const nodes = tree.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.includes(node.name?.text));
assert.equal(nodes.length, names.length);

const originalError = 'Timed out waiting for ChatGPT response completion';
const page = (text, generating = false) => ({ text, generating, messageId: 'bound' });
function fixture(t, options = {}) {
  const jobDir = mkdtempSync(join(tmpdir(), 'oracle-recollect-boundary-'));
  t.after(() => rmSync(jobDir, { recursive: true, force: true }));
  let now = Date.parse('2026-01-02T00:00:00Z');
  let snapshot = page('FROZEN PARTIAL');
  let reloaded = false, reportReads = 0, heartbeatCalls = 0;
  const timers = new Map();
  const process = new EventEmitter();
  process.pid = 123;
  process.argv = ['node', 'worker', 'boundary', '--recollect'];
  const exits = [];
  process.exit = code => { exits.push({ code, at: now }); throw new Error('worker deadline exit'); };
  const advance = async ms => {
    const end = now + ms;
    for (const [timer, item] of timers) {
      while (item.at <= end && timers.has(timer)) {
        now = item.at;
        if (item.interval) item.at += item.interval;
        else timers.delete(timer);
        await item.fn();
      }
    }
    now = end;
  };
  const timer = (fn, ms, interval) => {
    const handle = { unref() {} };
    timers.set(handle, { fn, at: now + ms, interval });
    return handle;
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const job = {
    id: 'boundary', status: 'failed', phase: 'failed', error: originalError,
    createdAt: '2026-01-01T00:00:00Z', phaseAt: '2026-01-01T00:00:01Z',
    submittedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
    promptSendState: 'accepted', archivePath: 'context-boundary.tar.zst', conversationId: 'thread',
    chatUrl: 'https://chatgpt.com/c/thread', runtimeSessionName: 'old', runtimeId: 'runtime',
    collectionBinding: { conversationId: 'thread', responseIndex: 0 },
    responsePath: join(jobDir, 'response.md'), selection: { provider: 'chatgpt' },
    config: { worker: { completionTimeoutMs: 100, pollMs: 10 }, artifacts: { capture: true } },
    ...options.job,
  };
  const history = [], commands = [];
  const observations = options.observations ?? [page('FROZEN PARTIAL')];
  const reloads = options.reloads ?? [page('FULL COMMITTED REPLY')];
  const readTurn = async (_job, binding) => {
    if (options.captureError) throw new Error('Bound capture missing');
    if (reloaded) snapshot = reloads.shift() ?? snapshot;
    if (binding.messageId && binding.messageId !== snapshot.messageId) throw new Error('Wrong message identity');
    if (!binding.messageId && snapshot.shifted) throw new Error('Saved index moved');
    const text = snapshot.text;
    return { binding: { ...binding, ...(snapshot.messageId ? { messageId: snapshot.messageId } : {}) },
      captured: { rawText: text, rawHtml: `<p>${text}</p>`, markdown: text, messageId: snapshot.messageId,
        codeBlocks: [], sources: [], candidates: options.candidates ?? [] } };
  };
  const deps = {
    ...lifecycle, ...flow, ...capture, ...budgets, deriveAssistantCompletionSignature, parseDeepResearchWidgetText, detectCompletionFailure,
    recollectionOperationTimeoutMs: (deadline, requested) => budgets.recollectionOperationTimeoutMs(deadline, requested, now),
    createHash, randomUUID, existsSync, readFile, writeFile, rename, chmod, mkdir, basename, dirname, join,
    process, Date: Clock, initialJob: job, history, jobDir, jobId: job.id, ORACLE_STATE_DIR: 'state', AGENT_BROWSER_BIN: 'unused',
    RELOAD_RECONCILE_TIMEOUT_MS: 50, RELOAD_RECONCILE_POLL_MS: 10, STALE_STOP_CONTROL_MS: 120000,
    MISSING_TURN_RELOAD_MS: 300000, MISSING_TURN_RELOAD_MAX: 1, DEEP_RESEARCH_FRAME_WAIT_MS: 60000,
    DEEP_RESEARCH_REPORT_EXPRESSION: 'report-text', ARTIFACT_DOWNLOAD_HEARTBEAT_MS: 10000, ARTIFACT_DOWNLOAD_TIMEOUT_MS: 90000,
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: handle => timers.delete(handle),
    setTimeout: (fn, ms) => timer(fn, ms, 0), clearTimeout: handle => timers.delete(handle),
    sleep: advance, recordHeartbeat: state => { heartbeatCalls++; options.onHeartbeat?.(state, now); },
    withLock: async (...args) => args.at(-1)(), jobBlocksAdmission: () => false,
    assertAgentBrowserVersionSupported: async () => {},
    tryAcquireRuntimeLeaseForJob: async () => { commands.push('runtime-lease'); return true; },
    tryAcquireConversationLeaseForJob: async () => { commands.push('conversation-lease'); return true; }, readProcessStartedAt: () => 'identity',
    usesSharedBrowser: () => true, launchBrowser: async () => { await advance(options.startupMs ?? 0); },
    cleanupRuntime: async () => { await advance(options.cleanupMs ?? 0); return []; },
    assertManagedBrowserUnchanged: async () => {}, log: async () => {},
    isGrokJob: value => value.selection.provider === 'grok', noteOwnConversation: async () => {},
    observeTurns: async () => {
      snapshot = observations.shift() ?? snapshot;
      return { onConversation: true, stopPresent: snapshot.generating, messages: [{ text: snapshot.text }] };
    },
    snapshotText: async () => snapshot.generating ? 'Stop model response' : '',
    GROK_LABELS: { stop: 'Stop model response' },
    assistantMessages: async () => { snapshot = observations.shift() ?? snapshot; return [{ text: snapshot.text }]; },
    throwIfProviderTransientError: () => {}, readPageSignals: async () => ({ text: '' }),
    captureBoundTurn: readTurn, acquireBoundTurn: readTurn, collectArtifactCandidates: async () => [],
    agentBrowser: async (_job, command, ...args) => {
      commands.push(command);
      if (command === 'open') {
        if (options.directReload || commands.filter(value => value === 'open').length > 1) {
          if (options.reloadError) throw new Error('Reload failed');
          reloaded = true;
        }
      } else if (command === 'download') {
        await advance(args.at(-1)?.timeoutMs ?? 90000);
        throw new Error('Download timed out');
      } else throw new Error('No sends permitted');
    },
    evalPage: async (_job, _script, limits) => { await advance(limits?.timeoutMs ?? 105000); throw new Error('Capture timed out'); },
    toAsyncJsonScript: text => text, rm: async () => {},
    armDeepResearchFrameCapture: async () => {}, boundResearchFrame: async () => ({ sessionId: 'report' }),
    deepResearchCdp: { evaluate: async (_session, expression) => {
      if (expression === 'report-text') return options.reportText ?? (++reportReads === 1
        ? 'Research completed in 1m\n# Full report' : 'Research completed in 1m\n');
      const report = options.reportText ? parseDeepResearchWidgetText(options.reportText).report : '';
      return { rawHtml: `<main>${report}</main>`, rawText: report, markdown: report, codeBlocks: [], sources: [], candidates: [] };
    } },
    AgentBrowserTimeoutError: class extends Error {},
  };
  const factory = new Function(...Object.keys(deps), `
    let currentJob=initialJob, shuttingDown=false, managedBrowserChangedError;
    async function readJob() { return currentJob; }
    async function mutateJob(fn) { currentJob=fn(currentJob); history.push(structuredClone(currentJob)); return currentJob; }
    async function heartbeat() { currentJob={...currentJob, heartbeatAt:new Date().toISOString()}; recordHeartbeat(currentJob); }
    ${nodes.map(node => node.getText(tree)).join('\n')}
    return { run: async () => { await runRecollection(); return currentJob; }, current: () => currentJob,
      reconcile: () => reconcileStreamedTurn(currentJob, 0, 'ORDINARY LOWER BOUND'),
      ordinary: () => waitForChatCompletion(currentJob, 0), collect: async (fallbackText) => {
      await collectBoundResult(currentJob, currentJob.collectionBinding, fallbackText); return currentJob;
    } };
  `);
  return { ...factory(...Object.values(deps)), job, history, commands, exits, now: () => now,
    heartbeats: () => heartbeatCalls, text: () => existsSync(job.responsePath) ? readFileSync(job.responsePath, 'utf8') : undefined };
}

test('recollection refuses a failed reload, without partial text or receipt', async t => {
  const run = fixture(t, { reloadError: true });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, originalError);
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.equal(run.text(), undefined);
});

test('recollection refuses a reload that never stabilizes', async t => {
  const run = fixture(t, { reloads: Array.from({ length: 20 }, (_, index) => page(`changing ${index}`)) });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.equal(run.text(), undefined);
});

test('the saved reply is the exact stable reload capture, not a later page read', async t => {
  const run = fixture(t, { reloads: [page('VERIFIED FULL'), page('VERIFIED FULL'), page('LATER CHANGED')] });
  const result = await run.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert.equal(run.text(), 'VERIFIED FULL');
});

test('artifact exhaustion preserves the verified reply and completes with artifact errors within budget', async t => {
  const run = fixture(t, { candidates: Array.from({ length: 8 }, (_, index) => ({
    candidateId: `file-${index}`, label: 'file.txt', selector: '#download', nativeMarkdown: false,
  })) });
  const started = run.now();
  const result = await run.run();
  assert.equal(result.phase, 'complete_with_artifact_errors');
  assert(result.recollectionCompletionVerifiedAt);
  assert.equal(run.text(), 'FULL COMMITTED REPLY');
  assert(run.now() - started < 10 * 60 * 1000, 'post-wait work must fit the shared ten-minute budget');
});

test('startup, waiting and collection heartbeats keep terminal cleanup from retiring the live worker', async t => {
  const jobsSource = readFileSync(new URL('../extensions/oracle/lib/jobs.ts', import.meta.url), 'utf8');
  const jobsTree = ts.createSourceFile('jobs.ts', jobsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = jobsTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getTerminalCleanupStaleReason');
  assert(node);
  const stale = new Function('isTerminalOracleJob', 'parseTimestamp', 'readProcessStartedAt',
    `const ORACLE_STALE_HEARTBEAT_MS=180000, ORACLE_MISSING_WORKER_GRACE_MS=30000;
    ${ts.transpile(node.getText(jobsTree).replace(/^export /, ''))}; return getTerminalCleanupStaleReason;`)(
    job => lifecycle.TERMINAL_ORACLE_JOB_STATUSES.includes(job.status), value => value ? Date.parse(value) : undefined, () => 'identity');
  const run = fixture(t, { startupMs: 270000, job: { lastCleanupAt: '2026-01-01T00:00:00Z' },
    candidates: [{ candidateId: 'slow', label: 'slow.txt', selector: '#download' }],
    onHeartbeat: (state, now) => { assert.equal(state.lastCleanupAt, undefined); assert.equal(stale(state, now), undefined); } });
  await run.run();
  assert(run.heartbeats() >= 27, 'three slow navigation commands must not age the terminal worker stale');
});

test('ordinary reload failure still keeps its streamed lower bound', async t => {
  const run = fixture(t, { reloadError: true, directReload: true });
  assert.equal(await run.reconcile(), 'ORDINARY LOWER BOUND');
  assert.deepEqual(run.history, []);
});

test('Grok timeout recollection is refused before any job or lease mutation', async t => {
  for (const collectionBinding of [undefined, { responseIndex: 0 }]) {
    const run = fixture(t, { job: { selection: { provider: 'grok' }, collectionBinding,
      error: 'Timed out waiting for Grok response completion' } });
    await assert.rejects(run.run(), /Grok.*not supported.*nothing.*resent/i);
    assert.deepEqual(run.history, []);
    assert.deepEqual(run.commands, []);
    assert.equal(run.text(), undefined);
  }
});

test('ordinary Grok timeout and streamed-text collection remain unchanged', async t => {
  const ordinary = fixture(t, { job: { selection: { provider: 'grok' }, collectionBinding: undefined },
    observations: [page('still streaming', true)] });
  await assert.rejects(ordinary.ordinary(), /^Error: Timed out waiting for Grok response completion$/);
  assert.deepEqual(ordinary.history, [], 'ordinary Grok still saves no timeout binding');
  const collection = fixture(t, { job: { selection: { provider: 'grok' } }, captureError: true });
  const result = await collection.collect('ORDINARY GROK STREAMED TEXT');
  assert.equal(collection.text(), 'ORDINARY GROK STREAMED TEXT');
  assert.equal(result.generationStatus, 'completed');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
});

test('worker stage deadlines precede the synchronous read backstop', () => {
  for (const tool of [undefined, 'deep_research']) {
    for (const completionTimeoutMs of [100, 90 * 60 * 1000]) {
      const job = { selection: { tool }, config: { worker: { completionTimeoutMs } } };
      const latestWorkerExit = budgets.RECOLLECTION_STARTUP_BUDGET_MS + budgets.recollectionWaitMs(job)
        + Math.max(budgets.RECOLLECTION_POST_WAIT_BUDGET_MS, budgets.RECOLLECTION_FINALIZE_RESERVE_MS);
      assert.equal(budgets.recollectionReadTimeoutMs(job) - latestWorkerExit, budgets.RECOLLECTION_READ_MARGIN_MS);
      assert(budgets.RECOLLECTION_READ_MARGIN_MS > 0);
    }
  }
  assert.equal(budgets.recollectionReadTimeoutMs({ selection: {}, config: { worker: { completionTimeoutMs: 90 * 60 * 1000 } } }), 106 * 60 * 1000);
});

test('worker watchdog bounds hung startup and cleanup, not only artifact commands', async t => {
  const startup = fixture(t, { startupMs: budgets.RECOLLECTION_STARTUP_BUDGET_MS + 1 });
  const started = startup.now();
  const failed = await startup.run();
  assert.deepEqual(startup.exits, [{ code: 1, at: started + budgets.RECOLLECTION_STARTUP_BUDGET_MS }]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, originalError);
  assert.equal(failed.recollectionCompletionVerifiedAt, undefined);
  const cleanup = fixture(t, { cleanupMs: budgets.RECOLLECTION_POST_WAIT_BUDGET_MS * 2 });
  const admitted = cleanup.now();
  await assert.rejects(cleanup.run(), /worker deadline exit/);
  assert.equal(cleanup.exits.length, 1);
  assert(cleanup.exits[0].at <= admitted + cleanup.job.config.worker.completionTimeoutMs + budgets.RECOLLECTION_POST_WAIT_BUDGET_MS);
  assert.equal(cleanup.current().status, 'complete');
  assert(cleanup.current().recollectionCompletionVerifiedAt, 'the verified response survives a stuck teardown');
  assert.equal(cleanup.current().cleanupPending, true, 'the reconciler retains cleanup ownership');
});

test('message identity learned before expiry survives index drift on a later recollection', async t => {
  const first = fixture(t, { observations: [page('partial', true)] });
  const failed = await first.run();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.collectionBinding.messageId, 'bound');
  assert.equal(failed.collectionBinding.responseIndex, 0);
  const next = fixture(t, { job: { collectionBinding: failed.collectionBinding },
    observations: [{ ...page('full'), shifted: true }] });
  const result = await next.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert(result.recollectionCompletionVerifiedAt);
  assert(next.history.every(value => value.collectionBinding.responseIndex === 0));
});

test('a stale missing-capture gap clears on the next actual collection', async t => {
  const failed = fixture(t, { captureError: true });
  const first = await failed.run();
  assert(first.collectionRequiredMissing.includes('bound_response_capture'));
  const recovered = fixture(t, { job: { collectionRequiredMissing: first.collectionRequiredMissing } });
  const result = await recovered.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert(result.recollectionCompletionVerifiedAt);
  assert(!result.collectionRequiredMissing.includes('bound_response_capture'));
});

test('research cannot retain the receipt when its completion marker outlives the report', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } } });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, originalError);
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
});

test('actual research collection earns the receipt only with the same completed non-empty report', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\n# Full report\nAll findings.' });
  const result = await run.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert(result.recollectionCompletionVerifiedAt);
  assert.match(run.text(), /All findings/);
});
