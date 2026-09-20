import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectNativeDownload, collectionOutcome, redactTransportSecrets, validateArtifactBytes } from './response-capture.mjs';
import { formatOracleJobSummary } from '../shared/job-observability-helpers.mjs';
import { chatGptStreamingVisible, providerSendAccepted } from './chatgpt-flow-helpers.mjs';

test('accepted continuation recognizes Stop answering controls but not quoted prose', () => {
  const before = { url: 'https://chatgpt.com/c/existing', assistantCount: 3, stopStreaming: false };
  for (const label of ['Stop answering', 'Stop streaming', 'Stop generating']) {
    const snapshot = '- textbox "Chat with ChatGPT" [ref=e1]\n- button "' + label + '" [ref=e2]';
    assert(providerSendAccepted(before, { ...before, stopStreaming: chatGptStreamingVisible(snapshot) }));
  }
  assert.equal(chatGptStreamingVisible('- textbox "Stop answering" [ref=e1]\n- button "Send prompt" [ref=e2]\nStop streaming'), false);
  assert.equal(chatGptStreamingVisible('- button "Stop answering" [ref=e1] [disabled]'), false);
});

test('read summaries expose generation and collection independently while legacy records stay readable', () => {
  const base = { id: 'synthetic', status: 'complete', phase: 'complete', createdAt: '2026-01-01T00:00:00Z', projectId: 'p', sessionId: 's' };
  assert(!formatOracleJobSummary(base).includes('collection-status:'));
  const summary = formatOracleJobSummary({ ...base, generationStatus: 'completed', collectionStatus: 'partial', responseCapturePath: '/tmp/response.capture.json',
    collectionBinding: { conversationId: 'c', responseIndex: 1, messageId: 'm-exact' },
    collectionRequiredMissing: ['source-links'], collectionOptionalMissing: ['artifact:optional'] });
  assert.match(summary, /generation-status: completed/);
  assert.match(summary, /collection-status: partial/);
  assert.match(summary, /collection-binding: turn 1 message m-exact/);
  assert.match(summary, /collection-required-missing: source-links/);
  assert.match(summary, /collection-optional-missing: artifact:optional/);
  assert.match(formatOracleJobSummary({ ...base, collectionBinding: { conversationId: 'c', responseIndex: 0 } }), /collection-binding: turn 0 \(index only; recollection needs the observed messageId\)/);
});

test('actual recollection CLI refuses unbound legacy jobs before any browser or submit operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-legacy-collection-'));
  try {
    const jobs = join(root, 'jobs');
    const directory = join(jobs, 'oracle-legacy');
    mkdirSync(directory, { recursive: true });
    const saved = JSON.stringify({ id: 'legacy', status: 'complete', conversationId: 'synthetic', chatUrl: 'https://chatgpt.com/c/synthetic' });
    writeFileSync(join(directory, 'job.json'), saved);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./run-job.mjs', import.meta.url)), 'legacy', '--recollect'], {
      env: { ...process.env, PI_ORACLE_JOBS_DIR: jobs, PI_ORACLE_STATE_DIR: join(root, 'state'), AGENT_BROWSER_PATH: '/nonexistent-no-browser-permitted' },
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    }), (error) => error.status === 1 && /Legacy recollection requires an explicit responseIndex and messageId/.test(error.stderr));
    assert.equal(readFileSync(join(directory, 'job.json'), 'utf8'), saved);
    assert.deepEqual(readdirSync(directory), ['job.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('download payloads must be real complete bytes matching their document format', () => {
  for (const [bytes, fileName] of [
    [Buffer.alloc(0), 'result.txt'],
    [Buffer.from('<!doctype html><html>Sign in</html>'), 'report.pdf'],
    [Buffer.from(JSON.stringify({ download_url: 'https://example.invalid/?signature=secret' })), 'report.md'],
    [Buffer.from('%PDF-1.7\ntruncated'), 'report.pdf'],
    [Buffer.from('Not a PDF'), 'report.pdf'],
    [Buffer.from([0x50,0x4b,3,4,0,0]), 'report.docx'],
  ]) assert.throws(() => validateArtifactBytes(bytes, { fileName }));
  assert.throws(() => validateArtifactBytes(Buffer.from('partial'), { fileName: 'result.txt', expectedSize: 100 }));
  const bytes = Buffer.from('# Report\n\n[Source](https://example.invalid/a?case=synthetic#proof)\n');
  const good = validateArtifactBytes(bytes, { fileName: 'report.md', expectedSize: bytes.length });
  assert.equal(good.detectedType, 'text/plain');
  assert.equal(good.size, bytes.length);
  assert.match(good.sha256, /^[a-f0-9]{64}$/);
});

test('successful empty inspection is not failed or unperformed inspection', () => {
  const base = { hasResponse: true, fidelity: 'exact_code', artifacts: [] };
  assert.deepEqual(collectionOutcome({ ...base, inspection: 'inspected' }), {
    collectionStatus: 'complete', collectionRequiredMissing: [], collectionOptionalMissing: [],
  });
  const failed = collectionOutcome({ ...base, inspection: 'failed' });
  assert.equal(failed.collectionStatus, 'partial');
  assert.deepEqual(failed.collectionRequiredMissing, []);
  assert.deepEqual(failed.collectionOptionalMissing, ['artifact_inspection:failed']);
  assert.equal(collectionOutcome({ ...base, inspection: 'not_performed' }).collectionStatus, 'partial');
  assert.equal(collectionOutcome({ ...base, inspection: 'inspected', artifacts: [{ displayName: 'old.txt' }] }).collectionStatus, 'complete');
});

test('required missing content differs from optional files and zero generation is not success', () => {
  const result = collectionOutcome({ hasResponse: true, fidelity: 'derived_markdown', inspection: 'inspected', artifacts: [
    { candidateId: 'optional', state: 'failed', required: false },
    { candidateId: 'required', state: 'failed', required: true },
    { candidateId: 'good', state: 'validated', required: true },
  ] });
  assert.equal(result.collectionStatus, 'partial');
  assert.deepEqual(result.collectionRequiredMissing, ['artifact:required']);
  assert.deepEqual(result.collectionOptionalMissing, ['artifact:optional']);
  assert.equal(collectionOutcome({ hasResponse: false, fidelity: 'text_only', inspection: 'failed' }).collectionStatus, 'failed');
});

test('stable source query and fragment survive while signed transport URLs do not', () => {
  const stable = 'https://example.invalid/source?case=synthetic&v=1#evidence';
  assert.equal(redactTransportSecrets(stable), stable);
  const redacted = redactTransportSecrets('Failed https://example.invalid/download?X-Amz-Signature=SECRET&X-Amz-Credential=PRIVATE and ' + stable);
  assert(!redacted.includes('SECRET'));
  assert(!redacted.includes('PRIVATE'));
  assert(redacted.includes(stable));
  assert.equal(redactTransportSecrets('https://example.invalid/download?a=1&amp;X-Amz-Signature=HTML_SECRET'), '[transport-url-redacted]');
});

// Fake relay: page session P owns main frame MAIN; frame session F owns the report frame tree.
function fakeRelay(downloads) {
  const listeners = new Map();
  const emit = (method, sessionId, params) => { for (const listener of listeners.get(method) || []) listener({ method, sessionId, params }); };
  const cdp = {
    calls: [],
    on(method, listener) { const set = listeners.get(method) || new Set(); set.add(listener); listeners.set(method, set); return () => set.delete(listener); },
    async evaluate(sessionId, expression) { cdp.calls.push([sessionId, expression.slice(0, 40)]); return undefined; },
    async send(method, params, sessionId) {
      cdp.calls.push([sessionId, method]);
      if (method === 'Page.getFrameTree') return sessionId === 'P'
        ? { frameTree: { frame: { id: 'MAIN' }, childFrames: [{ frame: { id: 'ADS' } }, { frame: { id: 'REPORT' } }] } }
        : { frameTree: { frame: { id: 'REPORT' }, childFrames: [{ frame: { id: 'REPORT_DOC' } }] } };
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      return {};
    },
  };
  return { cdp, activate: async () => { for (const [sessionId, begin, done] of downloads) { emit('Page.downloadWillBegin', sessionId, begin); if (done) emit('Page.downloadProgress', sessionId, done); } return { activated: true }; } };
}

test('native download collection binds to the tab main frame or bound report tree and reads only UI-exposed bytes', async () => {
  const report = '# Report\n\n[Source](https://example.invalid/a?case=synthetic#proof)\n';
  const data = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(report);
  const ok = fakeRelay([['F', { frameId: 'REPORT_DOC', guid: 'g1', url: data, suggestedFilename: 'report.md' }, { guid: 'g1', totalBytes: Buffer.byteLength(report), receivedBytes: Buffer.byteLength(report), state: 'completed' }]]);
  const collected = await collectNativeDownload({ cdp: ok.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: ok.activate, timeoutMs: 2_000 });
  assert.equal(Buffer.from(collected.bytesBase64, 'base64').toString(), report);
  assert.deepEqual([collected.fileName, collected.expectedSize, collected.native.source, collected.native.frameId], ['report.md', Buffer.byteLength(report), 'data', 'REPORT_DOC']);
  assert.deepEqual(ok.cdp.calls.filter(([, name]) => name === 'Page.enable').map(([session]) => session), ['P', 'F'], 'events are armed on both sessions before activation');
  assert.equal(ok.cdp.calls.filter(([, name]) => name.startsWith('(function disarm')).length, 2, 'registries are restored');

  const foreign = fakeRelay([['P', { frameId: 'ADS', guid: 'g2', url: data, suggestedFilename: 'x.md' }, { guid: 'g2', totalBytes: 1, receivedBytes: 1, state: 'completed' }]]);
  await assert.rejects(collectNativeDownload({ cdp: foreign.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: foreign.activate, timeoutMs: 500 }), /outside the bound frame tree/);

  const canceled = fakeRelay([['P', { frameId: 'MAIN', guid: 'g3', url: data, suggestedFilename: 'x.md' }, { guid: 'g3', totalBytes: 0, receivedBytes: 0, state: 'canceled' }]]);
  await assert.rejects(collectNativeDownload({ cdp: canceled.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: canceled.activate, timeoutMs: 500 }), /canceled/);

  const transport = fakeRelay([['P', { frameId: 'MAIN', guid: 'g4', url: 'https://files.example.invalid/export?X-Amz-Signature=SECRET', suggestedFilename: 'x.md' }, { guid: 'g4', totalBytes: 5, receivedBytes: 5, state: 'completed' }]]);
  await assert.rejects(collectNativeDownload({ cdp: transport.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: transport.activate, timeoutMs: 500 }), /transport URL/);
  assert(!transport.cdp.calls.some(([, name]) => name.startsWith('(async function readRegistered')), 'no fetch or registry read for transport URLs');

  const silent = fakeRelay([]);
  await assert.rejects(collectNativeDownload({ cdp: silent.cdp, pageSessionId: 'P', frameSessionId: 'F', activate: silent.activate, timeoutMs: 300 }), /did not start a browser download/);
});

test('native download collection ignores downloads observed before activation and caps data URLs', async () => {
  const report = '# Report\n';
  const data = (text) => 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
  const listeners = new Map();
  const emit = (method, sessionId, params) => { for (const listener of listeners.get(method) || []) listener({ method, sessionId, params }); };
  const cdp = {
    on(method, listener) { const set = listeners.get(method) || new Set(); set.add(listener); listeners.set(method, set); return () => set.delete(listener); },
    async evaluate() { return undefined; },
    async send(method, params, sessionId) {
      if (method === 'Page.enable' && sessionId === 'P') {
        // A download that begins while arming is not caused by the export control.
        emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'early', url: data('# Early\n'), suggestedFilename: 'early.md' });
        emit('Page.downloadProgress', 'P', { guid: 'early', totalBytes: 8, receivedBytes: 8, state: 'completed' });
      }
      if (method === 'Page.getFrameTree') return sessionId === 'P' ? { frameTree: { frame: { id: 'MAIN' } } } : { frameTree: { frame: { id: 'REPORT' } } };
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      return {};
    },
  };
  const activate = async () => {
    emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'export', url: data(report), suggestedFilename: 'report.md' });
    emit('Page.downloadProgress', 'P', { guid: 'export', totalBytes: Buffer.byteLength(report), receivedBytes: Buffer.byteLength(report), state: 'completed' });
    return { activated: true };
  };
  const collected = await collectNativeDownload({ cdp, pageSessionId: 'P', frameSessionId: 'F', activate, timeoutMs: 2_000 });
  assert.equal(collected.native.guid, 'export');
  assert.equal(Buffer.from(collected.bytesBase64, 'base64').toString(), report);

  const oversized = 'data:text/markdown;base64,' + Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64');
  const bigActivate = async () => {
    emit('Page.downloadWillBegin', 'P', { frameId: 'MAIN', guid: 'big', url: oversized, suggestedFilename: 'big.md' });
    emit('Page.downloadProgress', 'P', { guid: 'big', totalBytes: 25 * 1024 * 1024 + 1, receivedBytes: 25 * 1024 * 1024 + 1, state: 'completed' });
    return { activated: true };
  };
  await assert.rejects(collectNativeDownload({ cdp, pageSessionId: 'P', frameSessionId: 'F', activate: bigActivate, timeoutMs: 2_000 }), /exceeds capture limit/);
});
