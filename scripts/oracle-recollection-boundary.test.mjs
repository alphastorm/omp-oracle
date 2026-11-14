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
  'withHeartbeatWhile', 'persistRecollectionIdentity', 'activateReportExport', 'OracleWorkerError'];
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
  const timers = new Map(), scheduled = [];
  const process = new EventEmitter();
  process.pid = 123;
  process.uptime = () => (options.preEntryMs ?? 0) / 1000;
  process.argv = ['node', 'worker', 'boundary', '--recollect'];
  const exits = [];
  process.exit = code => { exits.push({ code, at: now }); if (code !== 0) throw new Error('worker deadline exit'); };
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
    scheduled.push({ at: now + ms, interval });
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
  const downloadListeners = new Map();
  const observations = options.observations ?? [page('FROZEN PARTIAL')];
  const reloads = options.reloads ?? [page('FULL COMMITTED REPLY')];
  const readTurn = async (_job, binding) => {
    if (options.captureError) throw new Error('Bound capture missing');
    if (reloaded) snapshot = reloads.shift() ?? snapshot;
    if (binding.messageId && binding.messageId !== snapshot.messageId) throw new Error('Wrong message identity');
    if (!binding.messageId && snapshot.shifted) throw new Error('Saved index moved');
    const text = snapshot.text;
    return { observation: { onConversation: snapshot.onConversation !== false, stopPresent: snapshot.generating },
      binding: { ...binding, ...(snapshot.messageId ? { messageId: snapshot.messageId } : {}) },
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
    withLock: async (...args) => { if (args[1] === 'recollect') await advance(options.lockMs ?? 0); return args.at(-1)(); },
    jobBlocksAdmission: () => false,
    assertAgentBrowserVersionSupported: async () => {},
    tryAcquireRuntimeLeaseForJob: async () => { commands.push('runtime-lease'); return true; },
    tryAcquireConversationLeaseForJob: async () => { commands.push('conversation-lease'); return true; }, readProcessStartedAt: () => 'identity',
    usesSharedBrowser: () => true, launchBrowser: async () => { await advance(options.startupMs ?? 0); },
    cleanupRuntime: async () => { await advance(options.cleanupMs ?? 0); options.onCleanup?.(); return []; },
    assertManagedBrowserUnchanged: async () => {}, log: async () => {},
    isGrokJob: value => value.selection.provider === 'grok', noteOwnConversation: async () => {},
    observeTurns: async () => {
      snapshot = observations.shift() ?? snapshot;
      return { onConversation: true, stopPresent: snapshot.generating, messages: [{ text: snapshot.text }] };
    },
    snapshotText: async () => reloaded && options.snapshotStop ? '- button "Stop generating" [ref=e1]' : snapshot.generating ? 'Stop model response' : '',
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
    deepResearchPageSession: 'page',
    deepResearchCdp: {
      on: (event, fn) => { downloadListeners.set(event, fn); return () => downloadListeners.delete(event); },
      send: async (method, params, _session, timeout) => {
        const activating = params?.expression?.includes('activateDownloadControl');
        const wanted = activating ? options.nativeActivationMs ?? 90000 : 1;
        await advance(Math.min(wanted, timeout));
        if (wanted >= timeout) throw new Error('Native export deadline reached');
        if (activating) {
          const body = Buffer.from(options.nativeMarkdown ?? '# Different native report');
          downloadListeners.get('Page.downloadWillBegin')({ method: 'Page.downloadWillBegin', sessionId: 'page',
            params: { guid: 'g', frameId: 'frame', url: 'data:text/plain;base64,' + body.toString('base64'), suggestedFilename: 'report.md' } });
          downloadListeners.get('Page.downloadProgress')({ method: 'Page.downloadProgress', sessionId: 'page',
            params: { guid: 'g', state: 'completed', totalBytes: body.length } });
        }
        return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame' } } } : { result: { value: true } };
      },
      evaluate: async (_session, expression) => {
      if (expression === 'report-text') return ++reportReads === 1 ? options.reportText ?? 'Research completed in 1m\n# Full report'
        : options.collectionReportText ?? options.reportText ?? 'Research completed in 1m\n';
      const report = options.reportText ? parseDeepResearchWidgetText(options.reportText).report : '';
      if (expression.includes('widgetState')) return { markdown: options.widgetMarkdown ?? options.captureMarkdown ?? report, references: [] };
      return { rawHtml: `<main>${report}</main>`, rawText: options.captureText ?? report, markdown: options.captureMarkdown ?? report,
        codeBlocks: [], sources: [], candidates: options.researchCandidates ?? [] };
    } },
    heartbeatGate: options.heartbeatGate, deadlineWriteGate: options.deadlineWriteGate,
    AgentBrowserTimeoutError: class extends Error {},
  };
  const factory = new Function(...Object.keys(deps), `
    let currentJob=initialJob, shuttingDown=false, managedBrowserChangedError;
    async function readJob() { return currentJob; }
    async function mutateJob(fn) {
      const priorError = currentJob.recollectionError;
      currentJob=fn(currentJob); history.push(structuredClone(currentJob));
      if (currentJob.recollectionError !== priorError && currentJob.recollectionError?.includes('reached its')) await deadlineWriteGate;
      return currentJob;
    }
    async function heartbeat() { currentJob={...currentJob, heartbeatAt:new Date().toISOString()}; recordHeartbeat(currentJob); await heartbeatGate; }
    ${nodes.map(node => node.getText(tree)).join('\n')}
    return { run: async () => { await runRecollection(); return currentJob; }, current: () => currentJob,
      reconcile: () => reconcileStreamedTurn(currentJob, 0, 'ORDINARY LOWER BOUND'),
      persistIdentity: binding => persistRecollectionIdentity(binding),
      whileHeartbeating: task => withHeartbeatWhile(task),
      ordinary: () => waitForChatCompletion(currentJob, 0), collect: async (fallbackText) => {
      await collectBoundResult(currentJob, currentJob.collectionBinding, fallbackText); return currentJob;
    } };
  `);
  return { ...factory(...Object.values(deps)), job, history, commands, exits, scheduled, advance, signal: () => process.emit('SIGTERM'), now: () => now,
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

test('reload generation observed with the capture resets stability and cannot earn a receipt', async t => {
  const run = fixture(t, { reloads: [page('STILL PARTIAL', true), page('STILL PARTIAL', true)] });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.equal(run.text(), undefined);
});

test('an intervening active reload observation breaks consecutive stability', async t => {
  const run = fixture(t, { reloads: [page('A'), page('A', true), page('A'), page('B'), page('C')] });
  assert.equal((await run.run()).status, 'failed');
});

test('reload keeps the existing snapshot Stop fallback', async t => {
  const run = fixture(t, { snapshotStop: true });
  assert.equal((await run.run()).status, 'failed');
  assert.equal(run.text(), undefined);
});

test('a foreign atomic capture observation cannot pass reload verification', async t => {
  const run = fixture(t, { reloads: [{ ...page('FOREIGN'), onConversation: false }] });
  assert.equal((await run.run()).status, 'failed');
});

test('repeated empty reload captures cannot earn a receipt', async t => {
  for (const blank of ['', ' \n ']) {
    const run = fixture(t, { reloads: [page(blank), page(blank)] });
    const result = await run.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  }
});

test('research accepts DOM Markdown whose co-captured visible body is the verified report', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\nFull report\nAll findings.',
    captureText: 'Full report\nAll findings.', captureMarkdown: '# Full report\n\nAll **findings**.' });
  const result = await run.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert.equal(run.text(), '# Full report\n\nAll **findings**.');
});

test('research never saves a different or shorter DOM/widget body under the receipt', async t => {
  for (const captureText of ['Partial report\nMissing the rest.', 'Full report']) {
    const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
      reportText: 'Research completed in 1m\nFull report\nAll findings.',
      captureText, captureMarkdown: '# ' + captureText, widgetMarkdown: '# A different widget report' });
    const result = await run.run();
    assert.equal(result.status, 'complete', result.recollectionError);
    assert.equal(run.text(), 'Full report\nAll findings.');
    assert(result.recollectionCompletionVerifiedAt);
    assert(result.collectionOptionalMissing.some(value => value.startsWith('artifact:research:')));
  }
});

test('empty rich research Markdown is not substituted for the verified non-empty body', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\nFull report', captureText: 'Full report', captureMarkdown: '', widgetMarkdown: '' });
  const result = await run.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert.equal(run.text(), 'Full report');
  assert(result.collectionOptionalMissing.some(value => value.startsWith('artifact:research:')));
});

test('a different non-empty completion report at collection is refused', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\nVerified report', collectionReportText: 'Research completed in 1m\nDifferent report' });
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
});

test('identity persistence refuses both saved-index and saved-message replacements', async t => {
  for (const replacement of [{ responseIndex: 1, messageId: 'bound' }, { responseIndex: 0, messageId: 'other' }]) {
    const run = fixture(t, { job: { collectionBinding: { conversationId: 'thread', responseIndex: 0, messageId: 'bound' } } });
    await assert.rejects(run.persistIdentity({ conversationId: 'thread', ...replacement }), /cannot replace/);
    assert.deepEqual(run.history, []);
  }
});

test('the entry deadline bounds the first lock before the job is known', async t => {
  const run = fixture(t, { lockMs: budgets.RECOLLECTION_STARTUP_BUDGET_MS + 1000 });
  const entered = run.now();
  await assert.rejects(run.run(), /worker deadline exit/);
  assert.equal(run.exits[0].at, entered + budgets.RECOLLECTION_STARTUP_BUDGET_MS);
  assert.deepEqual(run.history, [], 'a pre-admission deadline must not mutate the unknown job');
});

test('time already spent starting the worker cannot shift its lifetime envelope', async t => {
  const run = fixture(t, { preEntryMs: 90000, lockMs: budgets.RECOLLECTION_STARTUP_BUDGET_MS });
  const processStarted = run.now() - 90000;
  await assert.rejects(run.run(), /worker deadline exit/);
  assert.equal(run.exits[0].at, processStarted + budgets.RECOLLECTION_STARTUP_BUDGET_MS);
});

test('complete-job recollection clears the entry deadline and keeps its old allowance', async t => {
  const run = fixture(t, { startupMs: budgets.RECOLLECTION_STARTUP_BUDGET_MS + 1000,
    job: { status: 'complete', phase: 'complete', error: undefined,
      collectionBinding: { conversationId: 'thread', responseIndex: 0, messageId: 'bound' } } });
  const result = await run.run();
  assert(run.scheduled.some(item => !item.interval), 'the entry deadline was armed before reading the job');
  assert.deepEqual(run.exits, []);
  assert.equal(result.status, 'complete');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
});

test('heartbeat wrapping drains an in-flight mutation before settling', async t => {
  let release;
  const heartbeatGate = new Promise(resolve => { release = resolve; });
  const run = fixture(t, { startupMs: 10000, heartbeatGate });
  let settled = false;
  const pending = run.whileHeartbeating(() => run.advance(10000)).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { release(); await pending; }
});

test('foreground completion drains an already-started deadline-record mutation', async t => {
  let release, cleaned;
  const deadlineWriteGate = new Promise(resolve => { release = resolve; });
  const cleanupReached = new Promise(resolve => { cleaned = resolve; });
  const run = fixture(t, { startupMs: budgets.RECOLLECTION_STARTUP_BUDGET_MS - 500, deadlineWriteGate, onCleanup: cleaned });
  let settled = false;
  const pending = run.run().then(() => { settled = true; });
  try {
    await cleanupReached;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally { release(); await pending; }
});

test('research report waiting and watchdog arithmetic share one constant', () => {
  assert(/const DEEP_RESEARCH_FRAME_WAIT_MS = RECOLLECTION_RESEARCH_WAIT_MS;/.test(source), 'worker must use the shared research wait constant');
});

test('native export exhaustion keeps the verified research response and does not reach hard exit', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\nFull report\nAll findings.',
    researchCandidates: Array.from({ length: 7 }, (_, index) => ({
      candidateId: `export-${index}`, label: 'report.md', selector: '#export', nativeMarkdown: true,
    })) });
  t.mock.method(Date, 'now', run.now);
  const started = run.now();
  const result = await run.run();
  assert.equal(result.phase, 'complete_with_artifact_errors', result.recollectionError);
  assert(result.recollectionCompletionVerifiedAt);
  assert.equal(run.text(), 'Full report\nAll findings.');
  assert.deepEqual(run.exits, []);
  assert(run.now() - started <= budgets.RECOLLECTION_POST_WAIT_BUDGET_MS - budgets.RECOLLECTION_FINALIZE_RESERVE_MS);
});

test('unbound native research Markdown remains an optional unconfirmed artifact, never the response', async t => {
  const run = fixture(t, { job: { selection: { provider: 'chatgpt', tool: 'deep_research' } },
    reportText: 'Research completed in 1m\nFull report\nAll findings.', nativeActivationMs: 1,
    researchCandidates: [{ candidateId: 'native', label: 'report.md', selector: '#export', nativeMarkdown: true }] });
  t.mock.method(Date, 'now', run.now);
  const result = await run.run();
  assert.equal(run.text(), 'Full report\nAll findings.');
  const manifest = JSON.parse(readFileSync(join(dirname(run.job.responsePath), 'artifacts.json'), 'utf8'));
  const native = manifest.find(item => item.nativeMarkdown);
  assert(native, JSON.stringify(manifest));
  assert.equal(native.state, 'failed');
  assert.equal(native.unconfirmed, true);
  assert(result.collectionOptionalMissing.includes('artifact:frame:native'));
});

test('signal cleanup cannot exit before an in-flight foreground heartbeat settles', async t => {
  let release, heartbeatStarted;
  const heartbeatGate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { heartbeatStarted = resolve; });
  const run = fixture(t, { startupMs: 10000, heartbeatGate, onHeartbeat: heartbeatStarted });
  const pending = run.run();
  try {
    await started;
    run.signal();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(run.exits, [], 'a graceful signal exit must not abandon a pending mutation');
  } finally { release(); await pending; await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(run.current().status, 'failed');
  assert.equal(run.current().recollectionCompletionVerifiedAt, undefined);
});

test('stage arming cannot extend the lifetime ceiling or restart expired/interrupted work', () => {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'armDeadline') declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert(declaration);
  const makeArm = (stageDeadline, shuttingDown = false) => {
    const deadlines = [];
    const arm = new Function('Date', 'setTimeout', 'clearTimeout', 'stageDeadline', 'shuttingDown', `
      let deadlineTimer, deadlineRecordTimer, lifetimeDeadline=100, admitted=false;
      const deadlineWrites=new Set();
      const armDeadline=${declaration.initializer.getText(tree)};
      return armDeadline;`)({ now: () => 10 }, (_fn, ms) => { deadlines.push(10 + ms); return { unref() {} }; }, () => {}, stageDeadline, shuttingDown);
    return { arm, deadlines };
  };
  const live = makeArm();
  assert.equal(live.arm(1000, 'test'), 100);
  assert(Math.max(...live.deadlines) <= 100);
  assert.throws(() => makeArm(9).arm(1000, 'test'), /deadline|interrupted/);
  assert.throws(() => makeArm(undefined, true).arm(1000, 'test'), /deadline|interrupted/);
});
