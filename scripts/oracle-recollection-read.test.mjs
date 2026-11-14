import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { timedOutRecollectionBinding } from '../extensions/oracle/shared/job-lifecycle-helpers.mjs';
import { recollectionReadTimeoutMs } from '../extensions/oracle/shared/recollection-budget.mjs';

const source = readFileSync(new URL('../extensions/oracle/lib/tools.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('tools.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let object;
function visit(node) {
  if (ts.isObjectLiteralExpression(node) && node.properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText(tree) === 'name'
    && ts.isStringLiteral(property.initializer) && property.initializer.text === 'oracle_read')) object = node;
  ts.forEachChild(node, visit);
}
visit(tree);
assert(object);
const builder = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildOracleToolErrorResult');
assert(builder);
function reader(workerFailure, outcome, initiallyComplete = false) {
  const job = { id: 'job', status: initiallyComplete ? 'complete' : 'failed', error: 'Timed out waiting for ChatGPT response completion',
    promptSendState: 'accepted', archivePath: 'context.tar.zst', collectionBinding: { responseIndex: 0, messageId: 'bound' },
    projectId: 'project', sessionId: 'session', config: { worker: { completionTimeoutMs: 1000 } }, selection: {} };
  let reads = 0, calls = 0;
  const deps = {
    ORACLE_READ_PARAMS: {}, readJobForProject: () => { reads++; return structuredClone(job); }, getProjectId: () => 'project',
    timedOutRecollectionBinding, basename, recollectionReadTimeoutMs, resolveNodeExecutable: () => 'node',
    workerPath: 'never-executed', execFileAsync: async () => { calls++; Object.assign(job, outcome); throw workerFailure; },
    asRecord: value => value, buildOracleToolErrorDetails: (_name, error) => ({ message: error.message }),
    getSessionFile: () => 'session', isTerminalOracleJob: () => true, markWakeupSettled: async () => job,
    getWakeupSessionKey: () => 'project::session', readJob: () => job, readFile: async () => 'Durable response',
    getQueuePosition: () => undefined, getJobDir: () => 'job', ORACLE_STALE_HEARTBEAT_MS: 180000,
    buildOracleQueueSnapshot: () => undefined, redactJobDetails: value => value, formatOracleJobSummary: value => JSON.stringify(value),
  };
  const code = ts.transpile(`${builder.getText(tree)}\n const readTool = ${object.getText(tree)};`);
  const tool = new Function(...Object.keys(deps), code + '\nreturn readTool;')(...Object.values(deps));
  return { job, reads: () => reads, calls: () => calls,
    run: () => tool.execute('call', { jobId: job.id, action: 'recollect' }, undefined, undefined, { cwd: 'project' }) };
}

test('unsuccessful recollection exits still return the authoritative persisted outcome', async () => {
  for (const initiallyComplete of [false, true]) for (const failure of [
    Object.assign(new Error('Worker exit 1'), { code: 1 }),
    Object.assign(new Error('Worker killed by signal'), { signal: 'SIGTERM' }),
    Object.assign(new Error('Read backstop expired'), { killed: true, signal: 'SIGTERM' }),
  ]) for (const status of ['failed', 'complete']) {
    const outcome = { status, recollectionError: status === 'failed' ? 'Recollection reached its deadline; nothing was resent.' : undefined,
      recollectionCompletionVerifiedAt: status === 'complete' ? '2026-01-02T00:00:00Z' : undefined };
    const run = reader(failure, outcome, initiallyComplete);
    const result = await run.run();
    assert.equal(run.reads(), 2);
    assert.equal(result.details.job.status, status);
    assert.equal(result.details.job.recollectionError, outcome.recollectionError);
    assert.equal(result.details.job.recollectionCompletionVerifiedAt, outcome.recollectionCompletionVerifiedAt);
    assert.equal(result.details.error.message, failure.message);
    assert.match(result.content[0].text, new RegExp(status));
  }
});

test('pre-admission refusal stays clear and does not spawn a worker', async () => {
  const run = reader(new Error('not reached'), {});
  run.job.error = 'Timed out waiting for Grok response completion';
  const result = await run.run();
  assert.match(result.details.error.message, /Grok.*not supported/);
  assert.equal(run.calls(), 0);
  assert.equal(run.reads(), 1);
});

test('the action schema explicitly limits timed-out recovery to ChatGPT', () => {
  const schema = tree.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => value.name.getText(tree) === 'ORACLE_READ_PARAMS'));
  assert.match(schema.getText(tree), /ChatGPT job/);
  assert.match(schema.getText(tree), /Grok.*unsupported/);
});
