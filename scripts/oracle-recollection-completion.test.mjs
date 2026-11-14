import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ts from 'typescript';
import * as lifecycle from '../extensions/oracle/shared/job-lifecycle-helpers.mjs';
import * as flow from '../extensions/oracle/worker/chatgpt-flow-helpers.mjs';
import { deriveAssistantCompletionSignature } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';
import { detectCompletionFailure } from '../extensions/oracle/worker/provider-page-signals.mjs';
import { buildConversationLeaseMetadata, buildRuntimeLeaseMetadata, jobBlocksAdmission } from '../extensions/oracle/shared/job-coordination-helpers.mjs';

// Like proof:capture, execute production functions with injected observations, never a browser.
const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('run-job.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const wanted = ['runRecollection', 'waitForChatCompletion'];
const functions = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text));
assert.equal(functions.length, wanted.length);
const timeoutText = 'Timed out waiting for ChatGPT response completion';
function failedJob() {
  return {
    id: 'recollect-test', status: 'failed', phase: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z', submittedAt: '2026-01-01T00:00:01.000Z',
    phaseAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:02.000Z',
    error: timeoutText, promptSendState: 'accepted', archivePath: 'context-recollect-test.tar.zst',
    conversationId: 'thread', chatUrl: 'https://chatgpt.com/c/thread',
    collectionBinding: { conversationId: 'thread', responseIndex: 0 }, recollectionNeeded: true,
    runtimeId: 'runtime-test', runtimeSessionName: 'oracle-prior', cleanupPending: false,
    selection: { provider: 'chatgpt' }, config: { worker: { completionTimeoutMs: 100, pollMs: 10 } },
  };
}

function harness(job, observations) {
  let now = Date.parse('2026-01-02T00:00:00.000Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const process = new EventEmitter();
  process.argv = ['node', 'worker', job.id, '--recollect'];
  process.pid = 123;
  process.exit = () => {};
  const history = [], collected = [], bindings = [], clicks = [];
  let observation;
  const deps = {
    ...lifecycle, ...flow, deriveAssistantCompletionSignature, detectCompletionFailure,
    Date: Clock, process, basename, join, jobId: job.id, ORACLE_STATE_DIR: 'state', jobDir: 'job', AGENT_BROWSER_BIN: 'unused',
    STALE_STOP_CONTROL_MS: 120000, MISSING_TURN_RELOAD_MS: 300000, MISSING_TURN_RELOAD_MAX: 1,
    initialJob: structuredClone(job), history, collected, bindings, clicks,
    randomUUID: () => 'fresh-session', readProcessStartedAt: () => 'identity',
    withLock: async (...args) => args.at(-1)(),
    jobBlocksAdmission: (value) => jobBlocksAdmission(value, () => false),
    assertAgentBrowserVersionSupported: async () => {}, tryAcquireRuntimeLeaseForJob: async () => true,
    tryAcquireConversationLeaseForJob: async () => true, releaseLease: async () => {},
    ensurePrivateDir: async () => {}, usesSharedBrowser: () => true, launchBrowser: async () => {},
    agentBrowser: async (_job, command) => { assert.equal(command, 'open', 'recollection must never send'); },
    assertManagedBrowserUnchanged: async () => {}, cleanupRuntime: async () => [], log: async () => {},
    redactTransportSecrets: (text) => text, existsSync: () => false,
    isGrokJob: (value) => value.selection.provider === 'grok', heartbeat: async () => {}, noteOwnConversation: async () => {},
    observeTurns: async () => {
      observation = observations.shift() ?? observation;
      if (typeof observation === 'function') observation = observation(process);
      if (observation instanceof Error) throw observation;
      return observation;
    },
    snapshotText: async () => observation?.retry ? 'button "Retry"' : observation?.stopPresent ? 'Stop model response' : '',
    GROK_LABELS: { stop: 'Stop model response' },
    assistantMessages: async () => {
      observation = observations.shift() ?? observation;
      return observation.messages;
    },
    throwIfProviderTransientError: () => {}, readPageSignals: async () => ({ text: '' }),
    collectArtifactCandidates: async () => [],
    findEntry: () => ({ ref: 'retry' }), clickRef: async () => { clicks.push('retry'); },
    sleep: async (ms) => { now += ms; },
    OracleWorkerError: class extends Error {}, AgentBrowserTimeoutError: class extends Error {},
    capture: async (_job, binding) => {
      bindings.push({ ...binding });
      const messages = observation?.messages ?? [{ text: 'partial', messageId: 'bound' }];
      const message = binding.messageId ? messages.find((item) => item.messageId === binding.messageId) : messages[binding.responseIndex];
      if (!message) throw new Error('Bound turn absent');
      return { captured: { rawText: message.text, rawHtml: message.text }, binding: { ...binding, messageId: message.messageId } };
    },
  };
  const factory = new Function(...Object.keys(deps), `
    let currentJob = initialJob, shuttingDown = false, managedBrowserChangedError;
    async function readJob() { return currentJob; }
    async function mutateJob(fn) { currentJob = fn(currentJob); history.push(structuredClone(currentJob)); return currentJob; }
    const captureBoundTurn = capture, acquireBoundTurn = capture;
    async function reconcileStreamedTurn(_job, _index, text) { return text; }
    async function collectBoundResult(job, binding) {
      const turn = await capture(job, binding);
      collected.push(turn.captured.rawText);
      await mutateJob(job => ({ ...job, responsePath: 'response.md', collectionStatus: 'complete', collectionRequiredMissing: [], generationStatus: 'completed' }));
    }
    ${functions.map(node => node.getText(tree)).join('\n')}
    return { run: async () => { await runRecollection(); return currentJob; }, current: () => currentJob };
  `);
  return { ...factory(...Object.values(deps)), history, collected, bindings, clicks, process };
}
const page = (text, stopPresent, later = []) => ({ onConversation: true, stopPresent, messages: [{ text, messageId: 'bound' }, ...later] });

test('a timed-out recollection keeps its failed state until collecting the full stable reply', async () => {
  const job = failedJob();
  const run = harness(job, [page('partial', true), page('full reply', false), page('full reply', false)]);
  const result = await run.run();
  assert.equal(result.status, 'complete');
  assert.match(result.recollectionCompletionVerifiedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(run.collected, ['full reply']);
  for (const state of run.history.filter(job => job.status !== 'complete')) {
    assert.equal(state.status, 'failed');
    assert.equal(state.error, job.error);
    assert.equal(state.completedAt, job.completedAt);
  }
  assert.equal(run.history.filter(job => job.recollectionCompletionVerifiedAt).every(job => job.status === 'complete'), true);
  assert.deepEqual(run.clicks, []);
});

test('a still-generating reply times out unchanged and admits another recollection', async () => {
  const job = failedJob();
  const run = harness(job, [page('partial', true)]);
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, job.error);
  assert.equal(result.completedAt, job.completedAt);
  assert.match(result.recollectionError, /still being generated/);
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.deepEqual(run.collected, []);
  assert(lifecycle.timedOutRecollectionBinding(result, undefined, basename));
  const again = harness(result, [page('finished later', false), page('finished later', false)]);
  assert.equal((await again.run()).status, 'complete');
});

test('browser loss during the wait keeps the timeout and never reports complete', async () => {
  const run = harness(failedJob(), [new Error('browser gone'), new Error('browser gone'), new Error('browser gone')]);
  const result = await run.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, timeoutText);
  assert.match(result.recollectionError, /browser gone/);
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert(!run.history.some(job => job.status === 'complete'));
  assert.deepEqual(run.collected, []);
  assert(lifecycle.timedOutRecollectionBinding(result, undefined, basename));
});

test('later turns cannot substitute their text for the bound turn during completion', async () => {
  const later = [{ text: 'later finished answer', messageId: 'later' }];
  const run = harness(failedJob(), [page('partial', true, later), page('bound full answer', false, later), page('bound full answer', false, later)]);
  const result = await run.run();
  assert.equal(result.status, 'complete');
  assert(result.recollectionCompletionVerifiedAt);
  assert.deepEqual(run.collected, ['bound full answer']);
  assert(run.bindings.every(binding => binding.responseIndex === 0));
});

test('recollection never clicks Retry, even when the provider offers it', async () => {
  const failed = { ...page('There was an error generating a response', false), retry: true };
  const run = harness(failedJob(), [failed]);
  await run.run();
  assert.deepEqual(run.clicks, []);
  assert.deepEqual(run.collected, []);
});

test('already complete artifact recollection does not write a completion receipt', async () => {
  const job = { ...failedJob(), status: 'complete', phase: 'complete', error: undefined,
    collectionBinding: { conversationId: 'thread', responseIndex: 0, messageId: 'bound' } };
  const run = harness(job, []);
  const result = await run.run();
  assert.equal(result.status, 'complete');
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.equal(result.completedAt, job.completedAt);
});

test('SIGTERM during completion leaves the original failure and a retryable interruption', async () => {
  const job = failedJob();
  const run = harness(job, [process => { process.emit('SIGTERM'); return page('partial', true); }]);
  await run.run();
  await new Promise(resolve => setImmediate(resolve));
  const result = run.current();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, job.error);
  assert.equal(result.completedAt, job.completedAt);
  assert.match(result.recollectionError, /SIGTERM/);
  assert.equal(result.recollectionCompletionVerifiedAt, undefined);
  assert.deepEqual(run.collected, []);
  assert(lifecycle.timedOutRecollectionBinding(result, undefined, basename));
});

test('an abrupt crash leaves a durable interruption hint before any browser work', async () => {
  const job = failedJob();
  const run = harness(job, [page('partial', true)]);
  await run.run();
  const admitted = run.history[0]; // The on-disk state if killed immediately after admission.
  assert.equal(admitted.status, 'failed');
  assert.equal(admitted.error, job.error);
  assert.equal(admitted.completedAt, job.completedAt);
  assert.match(admitted.recollectionError, /interrupted/);
  assert.equal(admitted.recollectionCompletionVerifiedAt, undefined);
  assert(lifecycle.timedOutRecollectionBinding(admitted, undefined, basename));
});

test('message identity keeps verification on the bound reply when its index shifts', async () => {
  const shifted = { onConversation: true, stopPresent: false, messages: [
    { text: 'unrelated answer', messageId: 'other' }, { text: 'bound final', messageId: 'bound' },
  ] };
  const run = harness(failedJob(), [page('partial', true), shifted, shifted]);
  assert.equal((await run.run()).status, 'complete');
  assert.deepEqual(run.collected, ['bound final']);
  assert(run.bindings.slice(1).every(binding => binding.messageId === 'bound'));
});

test('a completion receipt survives later artifact recollection without being rewritten', async () => {
  const run = harness(failedJob(), [page('full', false), page('full', false)]);
  const result = await run.run();
  assert(result.recollectionCompletionVerifiedAt);
  const again = await harness(result, []).run();
  assert.equal(again.recollectionCompletionVerifiedAt, result.recollectionCompletionVerifiedAt);
});

test('a reply without message identity keeps its archive anchor while the text grows', async () => {
  const anonymous = (text, stopPresent) => ({ onConversation: true, stopPresent, messages: [{ text }] });
  const run = harness(failedJob(), [anonymous('partial', true), anonymous('full anonymous reply', false), anonymous('full anonymous reply', false)]);
  assert.equal((await run.run()).status, 'complete');
  assert.deepEqual(run.collected, ['full anonymous reply']);
  assert(run.bindings.every(binding => binding.anchorFileName === failedJob().archivePath && !binding.turnSha256));
});

test('Grok timeout recollection uses its generation signal and preserves its timeout text', async () => {
  const job = { ...failedJob(), selection: { provider: 'grok' }, error: 'Timed out waiting for Grok response completion' };
  const streaming = harness(job, [page('partial', true)]);
  const failed = await streaming.run();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, job.error);
  assert.equal(failed.recollectionCompletionVerifiedAt, undefined);
  assert.deepEqual(streaming.collected, []);
  const finished = harness(failed, [page('Grok full reply', false)]);
  const result = await finished.run();
  assert.equal(result.status, 'complete', result.recollectionError);
  assert(result.recollectionCompletionVerifiedAt);
  assert.deepEqual(finished.collected, ['Grok full reply']);
});

test('runtime and conversation leases do not expire during a long recollection', async () => {
  const names = ['tryAcquireRuntimeLeaseForJob', 'tryAcquireConversationLeaseForJob'];
  const selected = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  const owner = { ...failedJob(), cleanupPending: true, workerPid: 123, workerStartedAt: 'identity' };
  const lease = { jobId: owner.id, runtimeId: owner.runtimeId, conversationId: owner.conversationId, createdAt: '2000-01-01T00:00:00.000Z' };
  const released = [];
  const deps = {
    ORACLE_STATE_DIR: 'state', listLeaseMetadata: () => [lease], readLeaseMetadata: async () => lease,
    readAnyJob: () => owner, jobBlocksAdmission: value => jobBlocksAdmission(value, () => true),
    releaseLease: async (...args) => released.push(args), createLease: async () => {},
    buildRuntimeLeaseMetadata, buildConversationLeaseMetadata,
  };
  const leases = new Function(...Object.keys(deps), `${selected.map(node => node.getText(tree)).join('\n')}
    return { runtime: tryAcquireRuntimeLeaseForJob, conversation: tryAcquireConversationLeaseForJob };`)(...Object.values(deps));
  const other = { ...failedJob(), id: 'other', runtimeId: 'other-runtime', config: { browser: { maxConcurrentJobs: 1 } } };
  assert.equal(await leases.runtime(other, '2099-01-01T00:00:00.000Z'), false);
  assert.equal(await leases.conversation(other, '2099-01-01T00:00:00.000Z'), false);
  assert.deepEqual(released, []);
  await assert.rejects(harness(owner, []).run(), /live worker or pending cleanup/);
});

test('successful recollection preserves the already-sent failure notification', async () => {
  const notifiedAt = '2026-01-01T00:00:03.000Z';
  const run = harness({ ...failedJob(), notifiedAt, wakeupAttemptCount: 1 }, [page('full', false), page('full', false)]);
  const completed = await run.run();
  assert.equal(completed.status, 'complete');
  assert.equal(completed.notifiedAt, notifiedAt);
  assert.equal(completed.wakeupAttemptCount, 1);
  const jobsSource = readFileSync(new URL('../extensions/oracle/lib/jobs.ts', import.meta.url), 'utf8');
  const jobsTree = ts.createSourceFile('jobs.ts', jobsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const claim = jobsTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'tryClaimNotification');
  assert(claim);
  const tryClaim = new Function('withJobLock', 'readJob', 'isTerminalOracleJobStatus',
    `${ts.transpile(claim.getText(jobsTree).replace(/^export /, ''))}; return tryClaimNotification;`)(
    async (...args) => args.at(-1)(), () => completed, status => lifecycle.TERMINAL_ORACLE_JOB_STATUSES.includes(status));
  assert.equal(await tryClaim(completed.id, 'poller'), undefined, 'The poller cannot claim a second notification');
});

test('full-timeout heartbeats protect terminal recollection; active reconciliation cannot rewrite it', async () => {
  const jobsSource = readFileSync(new URL('../extensions/oracle/lib/jobs.ts', import.meta.url), 'utf8');
  const jobsTree = ts.createSourceFile('jobs.ts', jobsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ['getStaleOracleJobReason', 'getTerminalCleanupStaleReason'];
  const selected = jobsTree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length);
  const js = ts.transpile(selected.map(node => node.getText(jobsTree).replace(/^export /, '')).join('\n'));
  const { stale, terminalStale } = new Function('isActiveOracleJob', 'isTerminalOracleJob', 'parseTimestamp', 'readProcessStartedAt',
    `const ORACLE_STALE_HEARTBEAT_MS=180000, ORACLE_MISSING_WORKER_GRACE_MS=30000;
    ${js}; return { stale: getStaleOracleJobReason, terminalStale: getTerminalCleanupStaleReason };`)(
    job => lifecycle.ACTIVE_ORACLE_JOB_STATUSES.includes(job.status),
    job => lifecycle.TERMINAL_ORACLE_JOB_STATUSES.includes(job.status),
    value => value ? Date.parse(value) : undefined, () => 'identity');
  const run = harness({ ...failedJob(), lastCleanupAt: '2026-01-01T00:00:00.000Z' }, [page('partial', true)]);
  await run.run();
  const admitted = run.history[0];
  assert.equal(admitted.lastCleanupAt, undefined);
  const start = Date.parse(admitted.heartbeatAt);
  for (let elapsed = 0; elapsed <= 90 * 60 * 1000; elapsed += 10000) {
    const live = { ...admitted, heartbeatAt: new Date(start + elapsed).toISOString() };
    assert.equal(stale(live, start + elapsed), undefined);
    assert.equal(terminalStale(live, start + elapsed), undefined);
    assert.equal(jobBlocksAdmission(live, () => true), true);
  }
  assert.match(terminalStale(admitted, start + 180001), /stale/);
});
