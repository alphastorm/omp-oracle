#!/usr/bin/env node
// Synthetic-only real Chromium proof. No account, relay, model call, or external network needed.
// CHROME_BIN=/path/to/chromium node scripts/oracle-capture-proof.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { RelayCdpClient } from '../extensions/oracle/shared/relay-cdp-client.mjs';
import { activateDownloadControl, captureExpression, captureDownload, collectNativeDownload, collectionOutcome, redactTransportSecrets, validateArtifactBytes } from '../extensions/oracle/worker/response-capture.mjs';

const root = await mkdtemp(join(tmpdir(), 'oracle-capture-proof-'));
const chrome = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome, 'Supply CHROME_BIN; this proof never attaches to an existing browser');
const processHandle = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${root}/chrome`, 'about:blank'], { stdio: 'ignore' });
let cdp;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 100; i += 1) {
    try { port = Number((await readFile(join(root, 'chrome', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await sleep(100); }
  }
  assert(port, 'Owned Chromium did not become ready');
  cdp = await RelayCdpClient.connect(`http://127.0.0.1:${port}`);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await cdp.armFrameCapture(targetId);
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const exact = '# Transport canary\n\n**Keep paragraphs separate.**\n\n[Source](https://example.invalid/a?case=synthetic&v=1#evidence)\n\n| Item | Value |\n| --- | --- |\n| Amount | $1,250.50 |\n\n**not** recognized revenue.\n';
  const html = `<h6>ChatGPT said:</h6><div><article data-message-author-role="assistant" data-message-id="old"><p>OLD_TURN</p><a download="old.txt">Download old.txt</a></article></div>
<h6>ChatGPT said:</h6><div><article data-message-author-role="assistant" data-message-id="new"><pre><code class="language-markdown"></code></pre><button aria-label="Download">Download</button></article></div><div contenteditable="true">DO_NOT_SEND</div>`;
  await evaluate(`document.body.innerHTML=${JSON.stringify(html)};document.querySelector('code').textContent=${JSON.stringify(exact)};window.downloadClicks=0;window.oldClicks=0;document.querySelector('[data-message-id=old] a').onclick=()=>window.oldClicks++;document.querySelector('button').onclick=()=>{window.downloadClicks++;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['artifact payload\\n'],{type:'text/plain'}));a.download='result.txt';a.click();};`);
  await evaluate(`for (const pre of [...document.querySelectorAll('pre')]) { const outer=document.createElement('pre');pre.replaceWith(outer);outer.append(pre); }`);
  const captured = await evaluate(captureExpression({ responseIndex: 1, messageId: 'new' }));
  assert.equal(captured.codeBlocks.length, 1, 'Nested presentation pre elements must not duplicate code');
  assert.equal(captured.codeBlocks[0].text, exact);
  assert(captured.sources.some((source) => source.url === 'https://example.invalid/a?case=synthetic&v=1#evidence'));
  assert(!captured.rawHtml.includes('OLD_TURN'));
  assert.equal(captured.candidates.length, 1);
  assert.equal(captured.candidates[0].label, 'Download');
  const shifted = await evaluate(captureExpression({ responseIndex: 0, messageId: 'new' }));
  assert.equal(shifted.codeBlocks[0].text, exact, 'Exact message identity must survive a shifted positional index');
  await assert.rejects(evaluate(captureExpression({ responseIndex: 1, messageId: 'missing' })), /message ID/);
  await assert.rejects(evaluate(captureExpression({ responseIndex: 99 })), /root is absent/);

  // Exercise production persistence/collection functions, not a reimplementation. Browser reads
  // and clicks use the real isolated page; only the saved conversation URL is synthetic.
  const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('run-job.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['captureBoundTurn', 'collectBoundResult', 'flushArtifactsState', 'preserveCaptureFile', 'secureWriteText', 'ensurePrivateDir', 'toJsonScript', 'toAsyncJsonScript', 'runRecollection', 'sleep']);
  const declarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(declarations.length, names.size);
  const jobDir = join(root, 'job');
  await mkdir(jobDir);
  const job = { id: 'synthetic', responsePath: join(jobDir, 'response.md'), conversationId: 'synthetic', selection: { provider: 'chatgpt' }, config: { artifacts: { capture: true } } };
  const dependencyNames = ['createHash','existsSync','readFile','writeFile','rename','chmod','mkdir','join','basename','captureExpression','captureDownload','collectionOutcome','redactTransportSecrets','validateArtifactBytes','jobDir','evalPage','currentUrl','conversationIdFromUrl'];
  // The browser adapter retains dead session identities and enforces the Unix socket limit.
  // Collection itself still executes production functions against real Chromium above.
  const factory = new Function(...dependencyNames, `let currentJob;
    const retiredSessions=new Set();
    const jobId='synthetic', ORACLE_STATE_DIR='synthetic';
    async function mutateJob(fn) { currentJob=fn(currentJob); return currentJob; }
    async function readJob() { return currentJob; }
    async function withLock(...args) { return args.at(-1)(); }
    function jobBlocksAdmission() { return false; }
    async function tryAcquireRuntimeLeaseForJob() { return true; }
    async function tryAcquireConversationLeaseForJob() { return true; }
    function readProcessStartedAt() { return 'synthetic'; }
    function randomUUID() { return crypto.randomUUID(); }
    async function log() {}
    async function heartbeat() {}
    const admissions = [];
    async function launchBrowser(job) {
      admissions.push({ cleanupPending: job.cleanupPending, lastCleanupAt: job.lastCleanupAt, heartbeatAt: job.heartbeatAt, workerPid: job.workerPid });
      if(retiredSessions.has(job.runtimeSessionName)) throw Error('tab_gone: bound tab is gone');
      if(Buffer.byteLength('/tmp/agent-browser-501/'+job.runtimeSessionName+'.sock')>103) throw Error('Socket path too long');
    }
    async function agentBrowser(_job, command) { if(command!=='open') throw Error('No send permitted'); }
    async function cleanupRuntime(job) { retiredSessions.add(job.runtimeSessionName); return []; }
    ${declarations.map((node) => node.getText(tree)).join('\n')}
    return {
      admissions,
      collect:async(job,binding)=>{currentJob=job;await collectBoundResult(job,binding);return currentJob;},
      recollect:async(job)=>{currentJob=job;retiredSessions.add(job.runtimeSessionName);await runRecollection();return currentJob;}
    };`);
  const worker = factory(createHash,existsSync,readFile,writeFile,rename,chmod,mkdir,join,basename,captureExpression,captureDownload,collectionOutcome,redactTransportSecrets,validateArtifactBytes,jobDir,async (_job, expression) => {
    let result = await evaluate(expression);
    while (typeof result === 'string') { try { result = JSON.parse(result); } catch { break; } }
    return result;
  },async () => 'https://chatgpt.com/c/synthetic',() => 'synthetic');
  const binding = { conversationId: 'synthetic', responseIndex: 1, messageId: 'new' };
  const first = await worker.collect(job, binding);
  assert.equal(first.generationStatus, 'completed');
  assert.equal(first.collectionStatus, 'complete', JSON.stringify(first));
  assert.equal(await readFile(first.responsePath, 'utf8'), exact);
  const manifest = JSON.parse(await readFile(join(jobDir, 'artifacts.json'), 'utf8'));
  assert.equal(manifest[0].state, 'validated');
  assert.equal(await readFile(manifest[0].copiedPath, 'utf8'), 'artifact payload\n');
  const before = await readdir(join(jobDir, 'artifacts'));
  const second = await worker.collect(first, first.collectionBinding);
  assert.equal(second.collectionStatus, 'complete');
  assert.deepEqual(await readdir(join(jobDir, 'artifacts')), before);
  assert.equal(await evaluate('window.downloadClicks'), 1, 'Valid artifact should not be downloaded again');
  assert.equal(await evaluate('window.oldClicks'), 0);
  assert.equal(await evaluate('document.querySelector("[contenteditable]").textContent'), 'DO_NOT_SEND');
  // A failed recollection retains earlier usable bytes and declares missing bound content.
  const staleCleanupAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const completed = { ...second, status: 'complete', runtimeSessionName: 'oracle-a0b3cbba-e718-43cc-aec2-1dbde5831d5e', cleanupPending: false, lastCleanupAt: staleCleanupAt,
    chatUrl: 'https://chatgpt.com/c/synthetic', config: { ...second.config, browser: { chatGptRelayEndpoint: 'http://127.0.0.1:9224' } } };
  const reopened = await worker.recollect(completed);
  assert.equal(reopened.collectionStatus, 'complete', reopened.recollectionError);
  assert.equal(reopened.status, 'complete');
  assert.equal(reopened.runtimeSessionName, completed.runtimeSessionName, 'Original runtime provenance must be restored');
  assert.equal(reopened.cleanupPending, false);
  assert(reopened.lastCleanupAt > staleCleanupAt, 'Cleanup after recollection records a fresh timestamp');
  // While the recollecting worker is live, terminal-cleanup reconcilers judge it by lastCleanupAt
  // before heartbeatAt: the predecessor timestamp must be retired and a fresh heartbeat written.
  const admission = worker.admissions.at(-1);
  assert.equal(admission.cleanupPending, true);
  assert.equal(admission.lastCleanupAt, undefined, 'A stale predecessor cleanup timestamp would mark the live worker stale');
  assert(Date.now() - Date.parse(admission.heartbeatAt) < 10_000, 'Admission starts a fresh heartbeat');
  assert.equal(await readFile(reopened.responsePath, 'utf8'), exact);
  const partial = await worker.collect(second, { ...binding, messageId: 'wrong' });
  assert.equal(partial.collectionStatus, 'partial');
  assert(partial.collectionRequiredMissing.includes('bound_response_capture'));
  assert.equal(partial.collectionBinding.messageId, 'new', 'A failed recollection must not change the durable turn binding');
  assert.equal(await readFile(partial.responsePath, 'utf8'), exact);
  assert.equal(await readFile(manifest[0].copiedPath, 'utf8'), 'artifact payload\n');

  // The driver's `close` returns while its session daemon is still listed; a same-name command in
  // that window is served by the dying daemon (orphan tab, then "Connection refused"). The worker's
  // browser teardown must return only once the driver no longer lists the session, and must not
  // spawn a daemon just to close a session that is not listed.
  const teardownNames = new Set(['closeBrowser', 'agentBrowserSessionListed', 'waitForAgentBrowserSessionTeardown', 'sleep']);
  const teardownDeclarations = tree.statements.filter((node) => ts.isFunctionDeclaration(node) && teardownNames.has(node.name?.text));
  assert.equal(teardownDeclarations.length, teardownNames.size);
  const teardown = new Function(`const AGENT_BROWSER_BIN='driver', AGENT_BROWSER_CLOSE_TIMEOUT_MS=2000; let cleaningUpBrowser=false, browserStarted=true, deepResearchCdp, currentJob;
    const calls=[]; let listedUntil=0;
    function browserBaseArgs(job){ return ['--session', job.runtimeSessionName]; }
    async function terminateBrowserProcess(){}
    async function spawnCommand(_bin, args){ calls.push({ at: Date.now(), args });
      if (args[0]==='session') return { code:0, stdout: Date.now() < listedUntil ? 'Active sessions:\\n  '+currentSession+'\\n' : 'Active sessions:\\n' };
      if (args.at(-1)==='close') { listedUntil = Date.now()+300; return { code:0, stdout:'✓ Browser closed' }; }
      throw new Error('unexpected driver call '+args.join(' ')); }
    let currentSession='oracle-live';
    ${teardownDeclarations.map((node) => node.getText(tree)).join('\n')}
    return { calls, run: async (job, listed) => { currentSession=job.runtimeSessionName; listedUntil = listed ? Date.now()+60_000 : 0; browserStarted=true; await closeBrowser(job); } };`)();
  const relayJob = { runtimeSessionName: 'oracle-live', config: { browser: { chatGptRelayEndpoint: 'http://127.0.0.1:9224' } } };
  const closeStartedAt = Date.now();
  await teardown.run(relayJob, true);
  const closeCall = teardown.calls.find((call) => call.args.at(-1) === 'close');
  assert(closeCall, 'a listed session is closed through the driver');
  assert(Date.now() - closeCall.at >= 300, 'teardown returns only after the driver stops listing the session');
  assert(teardown.calls.filter((call) => call.args[0] === 'session').length >= 2, 'teardown polls the driver session inventory');
  teardown.calls.length = 0;
  await teardown.run({ ...relayJob, runtimeSessionName: 'oracle-unlisted' }, false);
  assert(!teardown.calls.some((call) => call.args.at(-1) === 'close'), 'an unlisted session is never closed: the driver would spawn a daemon and a stray tab for it');

  await evaluate(`document.body.innerHTML='<article data-message-author-role="assistant" data-message-id="rich"><h1>Report</h1><p><a href="https://example.invalid/primary?x=1#evidence">Primary</a></p><ul><li>First</li><li>Second</li></ul><table><tr><th>Metric</th><th>Value</th></tr><tr><td>ARR</td><td>forecast</td></tr></table><a download href="https://example.invalid/file?X-Amz-Signature=DO_NOT_PERSIST">Download</a></article>'`);
  await evaluate(`const literal=document.createElement('code');literal.textContent='https://example.invalid/literal?case=inline#source';document.querySelector('article').append(literal);`);
  const rich = await evaluate(captureExpression({ responseIndex: 0, messageId: 'rich' }));
  assert(rich.sources.some((source) => source.url === 'https://example.invalid/literal?case=inline#source'));
  assert.match(rich.markdown, /# Report/);
  assert.match(rich.markdown, /\[Primary\]\(https:\/\/example.invalid\/primary\?x=1#evidence\)/);
  assert.match(rich.markdown, /- First/);
  assert.match(rich.markdown, /\| ARR \| forecast \|/);
  assert(!rich.rawHtml.includes('DO_NOT_PERSIST'));
  assert.equal(rich.sources.find((item) => item.label === 'Download').kind, 'artifact');

  // A sandboxed cross-origin report frame delegates its export to the host page (Chrome forbids
  // downloads from sandboxed frames). The pre-armed native download collector must recover the
  // exact bytes Chrome saved, bound to the tab's main frame, while the frame realm sees nothing.
  const exportedReport = '# Research report\n\n[Primary](https://example.invalid/primary?x=1#evidence)\n';
  const fixture = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/host.html') {
      response.end(`<!doctype html><h6>ChatGPT said:</h6><div><article data-message-author-role="assistant" data-message-id="research"><p>Launching research</p><iframe sandbox="allow-scripts" src="http://localhost:${fixture.address().port}/report.html"></iframe></article></div><script>
window.exportsPerformed = 0;
window.addEventListener('message', (event) => { if (event.data?.type !== 'export') return; window.exportsPerformed += 1;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([${JSON.stringify(exportedReport)}], { type: 'text/markdown' })); a.download = 'deep-research-report.md';
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href); });</script>`);
      return;
    }
    response.end(`<!doctype html><main data-report-id="synthetic-report"><h1>Research report</h1><p><a href="https://example.invalid/primary?x=1#evidence">Primary</a></p><button aria-label="Export">Export</button></main><script>
document.querySelector('button').onclick = () => setTimeout(() => { const option = document.createElement('div'); option.setAttribute('role', 'menuitem'); option.textContent = 'Export to Markdown';
  document.body.append(option); option.onclick = () => { option.remove(); parent.postMessage({ type: 'export', format: 'markdown' }, '*'); }; }, 250);</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, '::', resolve));
  try {
    // Harness-only: this owned headless Chromium may be told where to save, so the native file is comparable.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(root, 'downloads') }, session);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixture.address().port}/host.html` }, session);
    let frame;
    for (let i = 0; i < 50 && !frame; i += 1) {
      await sleep(100);
      for (const candidate of cdp.frameSessions()) {
        if (String(await cdp.evaluate(candidate.sessionId, 'location.href')).includes('/report.html')) frame = candidate;
      }
    }
    assert(frame, 'The report frame must surface as an out-of-process child session');
    const frameEvaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, frame.sessionId, 30_000);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    const report = await frameEvaluate(captureExpression({ report: true }, true));
    assert.equal(report.candidates[0].label, 'Export');
    const downloaded = await collectNativeDownload({
      cdp, pageSessionId: session, frameSessionId: frame.sessionId,
      activate: () => frameEvaluate(`(async () => { const document = frames[0]?.document || globalThis.document; return await (${activateDownloadControl.toString()})(${JSON.stringify(report.candidates[0].selector)}, true); })()`),
    });
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, session);
    assert.equal(downloaded.native.frameId, frameTree.frame.id, 'The host page performed the export for the sandboxed report frame');
    assert.notEqual(downloaded.native.frameId, frame.targetId);
    assert.equal(downloaded.native.activation.menuOption, 'Export to Markdown');
    assert.equal(downloaded.native.source, 'blob');
    assert.equal(downloaded.fileName, 'deep-research-report.md');
    const native = Buffer.from(downloaded.bytesBase64, 'base64');
    assert.equal(validateArtifactBytes(native, { fileName: 'report.md', expectedSize: downloaded.expectedSize }).detectedType, 'text/plain');
    const saved = await readdir(join(root, 'downloads'));
    assert.deepEqual(saved, ['deep-research-report.md']);
    assert(native.equals(await readFile(join(root, 'downloads', saved[0]))), 'Collected bytes must be the bytes Chrome actually saved');
    assert.equal(await evaluate('window.exportsPerformed'), 1, 'Exactly one activation per collection');
    assert.equal(await evaluate('typeof URL.createObjectURL === "function" && !window.__oracleDownloadRegistry'), true, 'Registry hooks are restored');
  } finally {
    fixture.close();
  }
  console.log(JSON.stringify({ status: 'passed', syntheticOnly: true, exactCode: true, richDom: true, genericDownload: true, frameExport: true, hostDelegatedNativeExport: true, idempotentCollection: true, partialPreserved: true, oldTurnClicks: 0, sends: 0 }));
} finally {
  cdp?.close();
  processHandle.kill('SIGTERM');
  await new Promise((resolve) => { if (processHandle.exitCode !== null) resolve(); else processHandle.once('exit', resolve); });
  await rm(root, { recursive: true, force: true });
}
