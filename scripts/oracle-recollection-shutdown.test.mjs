import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let handler;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'onSignal') handler = node.initializer.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert(handler);

test('execFile timeout closes a real synthetic child through the production shutdown handler', async t => {
  // Scale only the injected reserve, not the handler. No browser, profile or provider is involved.
  const directory = mkdtempSync(join(tmpdir(), 'oracle-shutdown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipt = join(directory, 'exit.json');
  const script = `
    let cleaning=false, signalledAt;
    process.on('exit',code=>require('node:fs').writeFileSync(${JSON.stringify(receipt)},
      JSON.stringify({code,cleaning,signalledAt,exitedAt:Date.now()})));
    let shuttingDown=false, stageDeadline, deadlineTimer, deadlineRecordTimer;
    let heartbeatStops=new Set(); const deadlineWrites=new Set(), heartbeatWrites=new Set();
    const RECOLLECTION_FINALIZE_RESERVE_MS=30, timedOut=false, currentJob={status:'complete'};
    const foreground=new Promise(()=>{});
    const log=async()=>{}, mutateJob=async()=>{}, finalizeRecollection=async()=>{};
    const cleanupRuntime=async()=>new Promise(()=>{});
    const cleanupRecollection=async()=>{ cleaning=true; await cleanupRuntime(); };
    const onSignal=${handler};
    process.on('SIGTERM',()=>{signalledAt=Date.now();onSignal('SIGTERM');});
    process.stdout.write('ready\\n');
    setInterval(()=>{},1000);
  `;
  let child, safety;
  try {
    const result = await new Promise(resolve => {
      child = execFile(process.execPath, ['-e', script], { timeout: 500 }, (error, stdout) => resolve({ error, stdout }));
      safety = setTimeout(() => child.kill('SIGKILL'), 3000);
    });
    assert.match(result.stdout, /ready/);
    // execFile destroys stdout/stderr when timing out; use an exit receipt, not a pipe write.
    const exit = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(exit.cleaning, true);
    assert.equal(exit.code, 1);
    assert(exit.exitedAt - exit.signalledAt >= 20, 'the injected shutdown timer must actually elapse');
    assert.equal(result.error?.code, 1, 'the worker hard deadline, not the safety kill, must close the child');
    assert.equal(result.error?.signal, null);
    assert.equal(result.error?.killed, true, 'execFile must have sent its timeout signal');
  } finally { clearTimeout(safety); if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
