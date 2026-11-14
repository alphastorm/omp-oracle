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
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lifecycle from '../extensions/oracle/shared/job-lifecycle-helpers.mjs';
import { withLock } from '../extensions/oracle/worker/state-locks.mjs';
import { AgentBrowserTimeoutError, AGENT_BROWSER_TIMEOUTS, batchInvocation } from '../extensions/oracle/worker/agent-browser-helpers.mjs';
import { composerTextDigest, composerTextDigestExpression } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';
import { detectCompletionFailure, throwIfProviderTransientError } from '../extensions/oracle/worker/provider-page-signals.mjs';
import { RelayCdpClient } from '../extensions/oracle/shared/relay-cdp-client.mjs';
import { usesSharedBrowser } from '../extensions/oracle/shared/managed-browser-helpers.mjs';
import { appendOracleJobLifecycleEvent, applyOracleJobCleanupWarnings, timedOutRecollectionBinding } from '../extensions/oracle/shared/job-lifecycle-helpers.mjs';
import { activateDownloadControl, captureExpression, captureDownload, collectNativeDownload, collectionOutcome, composeResearchResponse, durationLabelSeconds, observeConversationExpression, readResearchReportState, redactTransportSecrets, turnContentSha256, validateArtifactBytes } from '../extensions/oracle/worker/response-capture.mjs';
import { CHATGPT_COMPOSER_EDITOR_SELECTOR, CHATGPT_STOP_CONTROL_SELECTOR, classifyDeepResearchTurn, deriveAssistantCompletionSignature, isChatGptComposerEntry, waitForStationaryControl } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';
import { chatGptGenerationActive, conversationIdFromUrl, isConversationPathUrl, nextMissingTurnReloadState, nextMissingTurnState, nextStaleStopState } from '../extensions/oracle/worker/chatgpt-flow-helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'oracle-capture-proof-'));
console.log(`Owned synthetic browser directory: ${root}`);
const chrome = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome, 'Supply CHROME_BIN; this proof never attaches to an existing browser');
const processHandle = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${root}/chrome`, 'about:blank'], { stdio: 'ignore' });
let cdp;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Synthetic pages served locally: conversations live under /c/<id> like ChatGPT's, so the worker's
// in-page conversation guard reads a real location. Tests replace a page by path.
const pages = new Map();
const fixture = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/payload.txt' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
  response.end(pages.get(new URL(request.url, 'http://fixture').pathname) ?? '<!doctype html><body></body>');
});
await new Promise((resolve) => fixture.listen(0, '::', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
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
  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, session);
    for (let i = 0; i < 200; i += 1) {
      try { if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)) return; } catch { /* navigation in flight */ }
      await sleep(20);
    }
    throw new Error(`Navigation did not finish: ${url}`);
  };
  await navigate(`${origin}/c/synthetic`);
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
  // A positional root spanning two message identities is not one turn, even on first capture.
  await evaluate(`document.querySelector('[data-message-id=new]').insertAdjacentHTML('beforeend', '<div data-message-id="other">stray</div>')`);
  await assert.rejects(evaluate(captureExpression({ responseIndex: 1 })), /spans several message IDs/);
  await evaluate(`document.querySelector('[data-message-id=other]').remove()`);
  // The redesigned shell carries the message id as data-chatgpt-selection-message-id on the turn
  // root; exact identity must still bind across a shifted positional index.
  const renameIds = (from, to) => evaluate(`for (const el of document.querySelectorAll('[${from}]')) { el.setAttribute('${to}', el.getAttribute('${from}')); el.removeAttribute('${from}'); }`);
  await renameIds('data-message-id', 'data-chatgpt-selection-message-id');
  assert.equal((await evaluate(captureExpression({ responseIndex: 0, messageId: 'new' }))).codeBlocks[0].text, exact, 'Redesigned message identity must survive a shifted positional index');
  await assert.rejects(evaluate(captureExpression({ responseIndex: 1, messageId: 'missing' })), /message ID/);
  await renameIds('data-chatgpt-selection-message-id', 'data-message-id');
  // The redesigned shell renders the Deep research widget in a sibling block of the reply, inside
  // the prompt's exchange (data-turn-key). The reply's frames are that exchange's, never another's.
  await evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div id="exchange-proof">
<div data-turn-key="u1"><div><h4>You said:</h4><div data-chatgpt-search-message-ids="u1">first prompt</div></div>
<div><div data-chatgpt-search-message-ids="tool1"><iframe title="Deep research" src="about:blank#first"></iframe></div></div>
<div><div><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="dr1">Deep Research has started.</div></div></div></div>
<div data-turn-key="u2"><div><h4>You said:</h4><div>second prompt</div></div>
<div><div><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="plain2">Plain answer.</div></div></div></div></div>`)})`);
  const researchTurn = await evaluate(captureExpression({ responseIndex: 2, messageId: 'dr1' }));
  assert.deepEqual(researchTurn.frames.map((frame) => frame.src), ['about:blank#first'], 'The reply binds the widget frame of its own exchange');
  assert.deepEqual((await evaluate(captureExpression({ responseIndex: 3, messageId: 'plain2' }))).frames, [], 'A later exchange never borrows an earlier widget frame');
  await evaluate(`document.getElementById('exchange-proof').remove()`);

  // Exercise production persistence/collection functions, not a reimplementation. Browser reads
  // and clicks use the real isolated page; only the saved conversation URL is synthetic.
  const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('run-job.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const extract = (wanted) => {
    const found = tree.statements.filter((node) => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && wanted.includes(node.name?.text));
    assert.equal(found.length, wanted.length, `extracted ${wanted.join(', ')}`);
    return found.map((node) => node.getText(tree)).join('\n');
  };
  const evalPage = async (_job, expression) => {
    let result = await evaluate(expression);
    while (typeof result === 'string') { try { result = JSON.parse(result); } catch { break; } }
    return result;
  };
  // The worker opens only its own conversation URL; fixture URLs load in the owned page, and any
  // other URL (a saved chatgpt.com address) is recorded without leaving the synthetic origin.
  const opens = [];
  const openUrl = async (url) => { opens.push(url); if (url.startsWith(origin)) await navigate(url); };
  // `sleep` is imported by the worker from the shared time helpers, so it is injected, not extracted;
  // bounded capture retries need no wall-clock delay against a static synthetic page.
  const workerSource = extract(['captureBoundTurn', 'acquireBoundTurn', 'returnToOwnConversation', 'noteOwnConversation', 'collectBoundResult', 'flushArtifactsState', 'preserveCaptureFile', 'secureWriteText', 'ensurePrivateDir', 'toJsonScript', 'toAsyncJsonScript', 'runRecollection', 'OracleWorkerError']);
  const dependencyNames = ['createHash','existsSync','readFile','writeFile','rename','chmod','mkdir','join','basename','captureExpression','captureDownload','collectionOutcome','composeResearchResponse','durationLabelSeconds','readResearchReportState','redactTransportSecrets','turnContentSha256','validateArtifactBytes','appendOracleJobLifecycleEvent','applyOracleJobCleanupWarnings','jobDir','evalPage','openUrl','conversationIdFromUrl','sleep','usesSharedBrowser','timedOutRecollectionBinding','AgentBrowserTimeoutError'];
  // The browser adapter retains dead session identities and enforces the Unix socket limit.
  // Collection itself still executes production functions against real Chromium above.
  const factory = new Function(...dependencyNames, `let currentJob; let shuttingDown=false; let conversationLeftEpisode=false;
    const retiredSessions=new Set();
    const jobId='synthetic', ORACLE_STATE_DIR='synthetic';
    function isGrokJob() { return false; }
    let managedBrowserChangedError;
    async function assertManagedBrowserUnchanged() {}
    // The proof models a supported driver; the version gate has its own regression test.
    const AGENT_BROWSER_BIN='synthetic';
    async function assertAgentBrowserVersionSupported() { return '0.41.2'; }
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
    async function withHeartbeatWhile(task) { return task(); }
    const admissions = [];
    let nextCleanupWarnings = [];
    async function launchBrowser(job) {
      admissions.push({ cleanupPending: job.cleanupPending, lastCleanupAt: job.lastCleanupAt, heartbeatAt: job.heartbeatAt, workerPid: job.workerPid, priorWorker: job.recollectionPriorWorker });
      if(retiredSessions.has(job.runtimeSessionName)) throw Error('tab_gone: bound tab is gone');
      if(Buffer.byteLength('/tmp/agent-browser-501/'+job.runtimeSessionName+'.sock')>103) throw Error('Socket path too long');
    }
    async function agentBrowser(_job, command, url) { if(command!=='open') throw Error('No send permitted'); await openUrl(url); }
    async function cleanupRuntime(job) { retiredSessions.add(job.runtimeSessionName); const warnings = nextCleanupWarnings; nextCleanupWarnings = []; return warnings; }
    ${workerSource}
    return {
      admissions,
      collect:async(job,binding,fallbackText)=>{currentJob=job;await collectBoundResult(job,binding,fallbackText);return currentJob;},
      recollect:async(job, warnings=[])=>{currentJob=job;retiredSessions.add(job.runtimeSessionName);nextCleanupWarnings=warnings;await runRecollection();return currentJob;}
    };`);
  const makeWorker = (dir) => factory(createHash,existsSync,readFile,writeFile,rename,chmod,mkdir,join,basename,captureExpression,captureDownload,collectionOutcome,composeResearchResponse,durationLabelSeconds,readResearchReportState,
    redactTransportSecrets,turnContentSha256,validateArtifactBytes,appendOracleJobLifecycleEvent,applyOracleJobCleanupWarnings,dir,evalPage,openUrl,conversationIdFromUrl,() => sleep(1),usesSharedBrowser,timedOutRecollectionBinding,AgentBrowserTimeoutError);
  const jobDir = join(root, 'job');
  await mkdir(jobDir);
  const job = { id: 'synthetic', phase: 'downloading_artifacts', status: 'waiting', submittedAt: new Date().toISOString(), responsePath: join(jobDir, 'response.md'), conversationId: 'synthetic', selection: { provider: 'chatgpt' }, config: { artifacts: { capture: true } } };
  const worker = makeWorker(jobDir);
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
  const completed = { ...second, status: 'complete', phase: 'complete', completedAt: new Date().toISOString(), runtimeSessionName: 'oracle-a0b3cbba-e718-43cc-aec2-1dbde5831d5e', cleanupPending: false, lastCleanupAt: staleCleanupAt,
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
  assert.equal(admission.priorWorker.runtimeSessionName, completed.runtimeSessionName, 'Predecessor provenance is persisted, not held in memory');
  assert.equal(reopened.recollectionPriorWorker, undefined, 'A clean teardown retires the persisted predecessor record');
  assert.equal(await readFile(reopened.responsePath, 'utf8'), exact);
  // A teardown warning keeps the fresh identity persisted for terminal-cleanup reconciliation and
  // keeps the predecessor recorded, instead of restoring an identity whose resources are gone.
  const warned = await worker.recollect({ ...reopened, lastCleanupAt: staleCleanupAt }, ['Browser close warning during cleanup: synthetic']);
  assert.equal(warned.collectionStatus, 'complete');
  assert.equal(warned.cleanupPending, true);
  assert.deepEqual(warned.cleanupWarnings, ['Browser close warning during cleanup: synthetic']);
  assert.notEqual(warned.runtimeSessionName, completed.runtimeSessionName, 'The fresh session stays persisted while its cleanup is pending');
  assert.equal(warned.recollectionPriorWorker.runtimeSessionName, completed.runtimeSessionName, 'The predecessor is still recorded');
  // A recollection that learns the exact identity and then fails keeps that identity durably.
  const learned = { ...second, collectionBinding: { conversationId: 'synthetic', responseIndex: 1 }, selection: { provider: 'chatgpt', tool: 'deep_research' } };
  const learnedButFailed = await worker.collect(learned, learned.collectionBinding);
  assert.equal(learnedButFailed.collectionStatus, 'partial');
  assert.equal(learnedButFailed.collectionBinding.messageId, 'new', 'A message ID learned before a later frame failure must survive');
  const partial = await worker.collect(second, { ...binding, messageId: 'wrong' });
  assert.equal(partial.collectionStatus, 'partial');
  assert(partial.collectionRequiredMissing.includes('bound_response_capture'));
  assert.equal(partial.collectionBinding.messageId, 'new', 'A failed recollection must not change the durable turn binding');
  assert.equal(await readFile(partial.responsePath, 'utf8'), exact);
  assert.equal(await readFile(manifest[0].copiedPath, 'utf8'), 'artifact payload\n');

  // A turn without any data-message-id binds by normalized text: the same content re-rendered
  // with different class attributes still recollects; changed content is refused.
  await evaluate(`for (const el of document.querySelectorAll('[data-message-id]')) el.removeAttribute('data-message-id');`);
  const indexOnly = await worker.collect({ ...second, collectionBinding: undefined }, { conversationId: 'synthetic', responseIndex: 1 });
  assert.equal(indexOnly.collectionStatus, 'complete');
  assert.equal(indexOnly.collectionBinding.messageId, undefined);
  assert.match(indexOnly.collectionBinding.turnSha256, /^[a-f0-9]{64}$/);
  await evaluate(`for (const el of document.querySelectorAll('article, article > *')) el.className = 'rerender-' + Math.random().toString(16).slice(2);`);
  const rerendered = await worker.collect(indexOnly, indexOnly.collectionBinding);
  assert.equal(rerendered.collectionStatus, 'complete', 'Class churn between renders must not invalidate an index-only binding');
  assert.equal(rerendered.collectionBinding.turnSha256, indexOnly.collectionBinding.turnSha256);
  await evaluate(`document.querySelectorAll('article')[1].insertAdjacentHTML('beforeend', '<p>Edited after completion</p>')`);
  const changed = await worker.collect(rerendered, rerendered.collectionBinding);
  assert.equal(changed.collectionStatus, 'partial', 'Changed turn content must be refused for an index-only binding');
  assert(changed.collectionOptionalMissing.some((gap) => /refusing index-only recollection/.test(gap)));
  assert.equal(await readFile(changed.responsePath, 'utf8'), exact, 'Earlier bytes survive the refusal');
  await evaluate(`document.querySelectorAll('article p').forEach((p) => p.remove()); document.querySelectorAll('article')[0].setAttribute('data-message-id', 'old'); document.querySelectorAll('article')[1].setAttribute('data-message-id', 'new');`);

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

  // The redesigned shell's code block is a `CodeBlock-…` container whose action bar names the
  // language beside its buttons; a live reply nests a `pre`, a reloaded conversation a bare block
  // `code` (observed 2026-10-16). Each variant captures fenced blocks in the named language, the
  // label is not prose, and a source pill or export-named link to another site is a citation,
  // never a download (activating one opened a third-party tab and spent the download deadline).
  const yaml = 'schema_version: synthetic.v1\ntasks:\n  - id: one\n';
  const notes = '# Plan\n\n- one\n';
  const codeShell = (label, inner) => `<div class="relative CodeSurface-a1 CodeBlock-b2 @container"><div class="flex ActionBar-c3"><svg></svg><div class="truncate">${label}</div><div class="ms-auto"><div role="presentation"><span class="contents"><button aria-label="Enable word wrap"><svg></svg></button></span><span class="contents"><button aria-label="Copy code"><svg></svg></button></span></div></div></div>${inner}</div>`;
  const liveCode = (label, text) => codeShell(label, `<div class="relative"><div class="InlineCodePane-d4"><div class="Viewer-e5"><div class="chatgpt-code-scrollport"><pre class="m-0"><code><span>${text}</span></code></pre></div></div></div></div>`);
  const reloadedCode = (label, text) => codeShell(label, `<div class="overflow-auto"><code class="whitespace-pre! block CodeContent-f6"><span>${text}</span></code></div>`);
  const citations = '<a href="https://raw.githubusercontent.com/example/repo/main/docs/API.md" aria-label="GitHub, https://raw.githubusercontent.com/example/repo/main/docs/API.md, 1 additional source">GitHub +1</a> <a href="https://example.invalid/files/export-controls.pdf">Export controls guide.pdf</a>';
  for (const [variant, block] of [['live', liveCode], ['reloaded', reloadedCode]]) {
    await evaluate(`document.body.innerHTML=${JSON.stringify(`<article data-message-author-role="assistant" data-message-id="code-${variant}"><p>Plan, per ${citations}.</p>${block('YAML', yaml)}${block('Markdown', notes)}<a href="${origin}/files/plan.yaml" download="plan.yaml">plan.yaml</a></article>`)}`);
    const turn = await evaluate(captureExpression({ responseIndex: 0, messageId: `code-${variant}` }));
    assert.deepEqual(turn.codeBlocks.map(({ language, text }) => ({ language, text })), [{ language: 'yaml', text: yaml }, { language: 'markdown', text: notes }], `${variant}: one block per container, in its action bar's language`);
    assert(turn.markdown.includes('```yaml\n' + yaml + '```'), `${variant}: the fence keeps the language`);
    assert(!/^(?:YAML|Markdown)$/m.test(turn.markdown), `${variant}: the action bar label is not prose`);
    assert.deepEqual(turn.candidates.map((candidate) => candidate.label), ['plan.yaml'], `${variant}: a link to another site is never a download`);
    assert.deepEqual(turn.sources.filter((source) => source.kind === 'artifact').map((source) => source.label), ['plan.yaml']);
  }

  // A runnable block (Python, with a Run button) is a CodeMirror editor that renders only the rows
  // near the viewport (observed 2026-10-17): its text is the editor's own document, the saved HTML
  // and the fence hold every line, and without that document the rendered rows join one per line.
  const script = 'import sys\n\nprint("smoke ok")\nsys.exit(0)';
  const editorRows = (rows) => rows.map((row) => `<div class="cm-line">${row || '<br>'}</div>`).join('');
  const runnable = (rows) => `<div class="relative CodeSurface-a1 CodeBlock-b2 @container"><div class="flex ActionBar-c3"><svg></svg><div class="truncate">Python</div><div class="ms-auto"><span class="contents"><button aria-label="Copy code"><svg></svg></button></span><button aria-label="Run code"><svg></svg>Run</button></div></div><div class="InlineCodePane-d4"><div class="cm-editor"><div class="cm-announced"></div><div class="cm-scroller"><div class="cm-content" role="textbox" aria-label="Edit code">${editorRows(rows)}</div></div></div></div></div>`;
  await evaluate(`document.body.innerHTML=${JSON.stringify(`<article data-message-author-role="assistant" data-message-id="runnable"><p>Script:</p>${runnable(script.split('\n').slice(0, 2))}</article>`)};document.querySelector('.cm-content').cmTile={view:{state:{doc:{toString:()=>${JSON.stringify(script)}}}}};`);
  const editorTurn = await evaluate(captureExpression({ responseIndex: 0, messageId: 'runnable' }));
  assert.deepEqual(editorTurn.codeBlocks.map(({ language, text }) => ({ language, text })), [{ language: 'python', text: script }], 'an editor block reads its whole document, not the rendered rows');
  assert(editorTurn.markdown.includes('```python\n' + script + '\n```'), 'the fence holds every line of the editor document');
  assert(editorTurn.rawHtml.includes('sys.exit(0)'), 'the saved HTML holds the rows the editor did not render');
  assert(!/^(?:Python|Run)$/m.test(editorTurn.markdown), 'neither the label nor the Run button is prose');
  await evaluate(`const editor=document.querySelector('.cm-content');delete editor.cmTile;editor.innerHTML=${JSON.stringify(editorRows(script.split('\n')))};`);
  assert.equal((await evaluate(captureExpression({ responseIndex: 0, messageId: 'runnable' }))).codeBlocks[0].text, script, 'without the document, the rendered rows join one per line');

  // A sandboxed cross-origin report frame delegates its export to the host page (Chrome forbids
  // downloads from sandboxed frames). The pre-armed native download collector must recover the
  // exact bytes Chrome saved, bound to the tab's main frame, while the frame realm sees nothing.
  // The report document mirrors the research widget observed on 2026-10-06: inside `main`, a
  // toolbar holds Export, a status line with animated counters heads the report, one clickable
  // element wraps the whole report body, citations render as numbered pills, diagrams as SVG, and
  // the widget state holds the Markdown source and its references.
  const citeToken = '\ue200cite\ue202turn0view0\ue201';
  const exportedReport = `# Research report\n\nClaim with a source.${citeToken}\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n`;
  const reportMessage = { id: 'report-message', content: { parts: [exportedReport] }, metadata: { is_complete: true, content_references: [
    { matched_text: citeToken, type: 'grouped_webpages', items: [{ title: 'Primary', url: 'https://example.invalid/primary?x=1#evidence', supporting_websites: [] }], safe_urls: [] }] } };
  pages.set('/host.html', `<!doctype html><h6>ChatGPT said:</h6><div><article data-message-author-role="assistant" data-message-id="research"><p>Launching research</p><iframe sandbox="allow-scripts" src="http://localhost:${fixture.address().port}/report.html"></iframe></article></div><script>
window.exportsPerformed = 0;
window.addEventListener('message', (event) => { if (event.data?.type !== 'export') return; window.exportsPerformed += 1;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([${JSON.stringify(exportedReport)}], { type: 'text/markdown' })); a.download = 'deep-research-report.md';
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href); });</script>`);
  pages.set('/report.html', `<!doctype html><main><div><button aria-label="Export">Export</button></div><div class="w-full p-px"><div>Research completed in 12m · <span role="img" aria-label="27"><span>0</span><span>1</span><span>2</span></span> citations · <span role="img" aria-label="80"><span>0</span><span>8</span></span> searches</div>
<div role="button" tabindex="0"><div><h1>Research report</h1><p>Claim with a source<sup role="button" data-citation-index="1">1</sup>. Export to Markdown keeps <a href="https://example.invalid/primary?x=1#evidence">Primary</a>.</p>
<pre><div><svg viewBox="0 0 10 10"><text>A</text><text>B</text></svg></div></pre></div></div></div></main><script>
window.openai = { widgetState: { report_message: ${JSON.stringify(reportMessage)} } };
document.querySelector('button').onclick = () => setTimeout(() => { const option = document.createElement('div'); option.setAttribute('role', 'menuitem'); option.textContent = 'Export to Markdown';
  document.body.append(option); option.onclick = () => { option.remove(); parent.postMessage({ type: 'export', format: 'markdown' }, '*'); }; }, 250);</script>`);
  // Harness-only: this owned headless Chromium may be told where to save, so the native file is comparable.
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(root, 'downloads') }, session);
  await cdp.send('Page.navigate', { url: `${origin}/host.html` }, session);
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
  assert.deepEqual(report.candidates.map((candidate) => candidate.label), ['Export'], 'The clickable element wrapping the report is never a download candidate');
  assert(!report.markdown.includes('Research completed in'), 'The widget status line and its counters are not report body');
  assert.match(report.markdown, /Claim with a source\[1\]\./, 'A citation pill stays a visible numbered marker');
  assert.deepEqual(report.citationPills, ['1']);
  assert.equal(report.diagramsWithoutSource, 1);
  assert.deepEqual(report.codeBlocks, [], 'Diagram layout text is never captured as code');
  assert.match(report.markdown, /_\[Diagram not captured: the page shows it as an image without its source\.\]_/);
  const reportState = await frameEvaluate(`(${readResearchReportState.toString()})()`);
  assert.equal(reportState.markdown, exportedReport, 'The widget state holds the report Markdown source');
  assert.deepEqual(reportState.references[0].sources, [{ title: 'Primary', url: 'https://example.invalid/primary?x=1#evidence' }]);
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
  const research = composeResearchResponse({ capture: report, reportState, nativeMarkdown: native.toString('utf8') });
  assert.equal(research.method, 'native_report_download');
  assert(research.markdown.includes('Claim with a source.[^1]') && research.markdown.includes('[^1]: [Primary](https://example.invalid/primary?x=1#evidence)'), research.markdown);
  assert(research.markdown.includes('```mermaid\ngraph TD\n  A --> B\n```'), 'The diagram source survives');
  assert.deepEqual(research.requiredMissing, []);
  // The shell exposes a fallback textbox before the real editor hydrates.
  // Run the actual prompt writer against that predecessor state in owned Chromium, for the earlier
  // `#prompt-textarea` editor and for the current labeled contenteditable textbox without an id.
  {
    const composerNames = new Set(['setComposerText', 'toJsonScript', 'toAsyncJsonScript']);
    const composerDeclarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && composerNames.has(node.name?.text));
    assert.equal(composerDeclarations.length, composerNames.size);
    const editorExpression = `[...document.querySelectorAll(${JSON.stringify(CHATGPT_COMPOSER_EDITOR_SELECTOR)})].find((el) => el.isContentEditable)`;
    const writeComposer = new Function('evalPage', 'snapshotText', 'findEntry', 'isGrokJob', 'agentBrowser', 'CHATGPT_COMPOSER_EDITOR_SELECTOR', 'isChatGptComposerEntry',
      'AGENT_BROWSER_TIMEOUTS', 'batchInvocation', 'composerTextDigest', 'composerTextDigestExpression', 'withHeartbeatWhile', 'log',
      composerDeclarations.map(node => node.getText(tree)).join('\n') + '\nreturn setComposerText;')(
      async (_job, expression) => { const result = await evaluate(
        `(async () => {
          if (window.hydrateOnComposerRead) {
            const shell = window.hydrateOnComposerRead;
            window.hydrateOnComposerRead = false;
            setTimeout(() => {
              const editor = document.createElement('div');
              if (shell === 'current') {
                editor.setAttribute('role', 'textbox');
                editor.setAttribute('aria-label', 'Ask ChatGPT');
              } else {
                editor.id = 'prompt-textarea';
              }
              editor.contentEditable = 'true';
              editor.textContent = 'PREVIOUS OWNED DRAFT';
              document.querySelector('textarea').replaceWith(editor);
            }, 50);
          }
          return await (` + expression + `);
        })()`); return typeof result === "string" ? JSON.parse(result) : result; },
      async () => evaluate(`[{kind:'textbox', label:document.querySelector('textarea')?.getAttribute('aria-label') || 'Ask ChatGPT', ref:(${editorExpression}) ? 'editor' : 'fallback'}]`),
      (entries, predicate) => entries.find(predicate), () => false,
      async (_job, subcommand, options) => {
        assert.equal(subcommand, 'batch');
        const [[command, ref, text]] = JSON.parse(options.input);
        assert.equal(command, 'fill');
        await evaluate(`(() => {
          const editor = ` + (ref === 'editor' ? editorExpression : `document.querySelector('textarea')`) + `;
          if (!editor?.isContentEditable) throw new Error('Stale fallback textbox reference');
          editor.focus(); document.execCommand('insertText', false, ` + JSON.stringify(text) + `);
        })()`);
      },
      CHATGPT_COMPOSER_EDITOR_SELECTOR, isChatGptComposerEntry,
      AGENT_BROWSER_TIMEOUTS, batchInvocation, composerTextDigest, composerTextDigestExpression, async task => task(), async () => {},
    );
    const editorText = () => evaluate(`(${editorExpression}).innerText`);
    for (const [shell, fallbackLabel] of [['legacy', 'Chat with ChatGPT'], ['current', 'Ask ChatGPT']]) {
      await evaluate(`document.body.innerHTML='<textarea aria-label="${fallbackLabel}">PREVIOUS OWNED DRAFT</textarea>';window.hydrateOnComposerRead=${JSON.stringify(shell)};`);
      await writeComposer({}, 'ONLY THE NEW PROMPT');
      assert.equal(await editorText(), 'ONLY THE NEW PROMPT', `${shell} composer`);
      await writeComposer({}, 'SECOND REPLACEMENT');
      assert.equal(await editorText(), 'SECOND REPLACEMENT', `${shell} composer`);
    }
    assert.equal(await evaluate("document.querySelector('#prompt-textarea')"), null, 'The current shell has no legacy editor id');
    // A noneditable replacement must time out without altering or filling it.
    await evaluate("document.querySelector('[aria-label=\"Ask ChatGPT\"]').contentEditable='false';window.realDateNow=Date.now;let clock=0;Date.now=()=>clock+=20000;");
    try {
      await assert.rejects(writeComposer({}, 'MUST NOT BE INSERTED'), /Could not clear ChatGPT composer draft/);
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Ask ChatGPT\"]').innerText"), 'SECOND REPLACEMENT');
    } finally {
      await evaluate('Date.now=window.realDateNow;');
    }
  }

  // Another client can navigate the job's tab while the job waits (an agent's own CDP connection
  // adopting the visible tab, observed 2026-10-04). Synthetic conversations: the job's own, whose
  // second exchange carries the job archive and is still generating, and a foreign one whose turn
  // at the same index has finished.
  {
    const ownUrl = `${origin}/c/own`;
    const exchange = (key, prompt, id, text, header = '') => `<div data-turn-key="${key}"><div><h5>You said:</h5><div data-message-author-role="user">${prompt}</div></div>
<div>${header}<h6>ChatGPT said:</h6><div data-chatgpt-selection-message-id="${id}"><p>${text}</p></div></div></div>`;
    // The reasoning-time label renders as a span in the exchange's activity header (observed 2026-10-06).
    const ownPage = (text, generating, earlierPrompt = 'Earlier prompt') => `<!doctype html><main>${exchange('o0', earlierPrompt, 'own-0', 'Earlier answer.')}
${exchange('o1', 'Review this <span>context-nav.tar.zst</span>', 'own-1', text, '<div class="activity-header"><span><span>Worked for 15m 7s</span></span></div>')}</main>${generating ? '<button data-testid="stop-button">Stop</button>' : ''}`;
    pages.set('/c/own', ownPage('OWN partial', true));
    pages.set('/c/foreign', `<!doctype html><main>${exchange('f0', 'Other prompt', 'foreign-0', 'Foreign earlier.')}${exchange('f1', 'Other follow-up', 'foreign-1', 'FOREIGN FINISHED ANSWER')}</main>`);
    const completionSource = extract(['waitForChatCompletion', 'reconcileStreamedTurn', 'observeTurns', 'observedPagePath', 'returnToOwnConversation', 'noteOwnConversation', 'toJsonScript']);
    const waitForCompletion = new Function('evalPage', 'openUrl', 'sleep', 'observeConversationExpression', 'CHATGPT_STOP_CONTROL_SELECTOR', 'chatGptGenerationActive',
      'deriveAssistantCompletionSignature', 'nextStaleStopState', 'isConversationPathUrl', 'classifyDeepResearchTurn', 'appendOracleJobLifecycleEvent', 'nextMissingTurnState', 'nextMissingTurnReloadState', 'detectCompletionFailure', 'throwIfProviderTransientError', `let currentJob; let conversationLeftEpisode = false;
      const RELOAD_RECONCILE_TIMEOUT_MS = 5000, RELOAD_RECONCILE_POLL_MS = 50, STALE_STOP_CONTROL_MS = 120000, MISSING_TURN_RELOAD_MS = 300000, MISSING_TURN_RELOAD_MAX = 1;
      function isGrokJob() { return false; }
      async function heartbeat() {}
      async function log() {}
      async function snapshotText() { return ''; }
      async function readPageSignals() { return { text: '', composerPresent: true }; }
      async function collectArtifactCandidates() { return []; }
      async function mutateJob(fn) { currentJob = fn(currentJob); return currentJob; }
      async function agentBrowser(_job, command, url) { if (command !== 'open') throw Error('No send permitted'); await openUrl(url); }
      ${completionSource}
      return async (job, baseline) => { currentJob = job; const result = await waitForChatCompletion(job, baseline); return { result, job: currentJob }; };`)(
      evalPage, openUrl, sleep, observeConversationExpression, CHATGPT_STOP_CONTROL_SELECTOR, chatGptGenerationActive, deriveAssistantCompletionSignature,
      nextStaleStopState, isConversationPathUrl, classifyDeepResearchTurn, appendOracleJobLifecycleEvent, nextMissingTurnState, nextMissingTurnReloadState, detectCompletionFailure, throwIfProviderTransientError);
    const onOwn = async () => { try { return await evaluate('location.pathname') === '/c/own'; } catch { return false; } };
    await navigate(`${origin}/c/foreign`);
    const navJob = { id: 'nav', phase: 'awaiting_response', status: 'waiting', submittedAt: new Date().toISOString(), conversationId: 'own', chatUrl: ownUrl,
      selection: { provider: 'chatgpt' }, config: { worker: { pollMs: 50, completionTimeoutMs: 30_000 } } };
    let settled = false;
    const waiting = waitForCompletion(navJob, 1).finally(() => { settled = true; });
    for (let i = 0; i < 200 && !(await onOwn()); i += 1) await sleep(25);
    assert(await onOwn(), 'The job reopens its own conversation');
    await sleep(500);
    assert.equal(settled, false, 'A finished turn in another conversation never completes the job');
    pages.set('/c/own', ownPage('OWN FINAL ANSWER', false));
    await evaluate(`document.querySelector('[data-chatgpt-selection-message-id="own-1"]').innerHTML = '<p>OWN FINAL ANSWER</p>'; document.querySelector('[data-testid="stop-button"]').remove();`);
    const { result, job: waited } = await waiting;
    assert.deepEqual(result, { responseIndex: 1, responseText: 'OWN FINAL ANSWER' }, 'Completion and text come from the job conversation only');
    assert.equal(waited.lifecycleEvents.filter((event) => event.kind === 'navigation').length, 1, 'One breadcrumb per departure');

    // Live 2026-10-20, job 8df0d1e1: navigation from Home left its composer mounted in a
    // display:none workspace. Its Stop had no layout box and was absent from accessibility,
    // while the visible conversation had finished (Copy / Rate response / Regenerate response).
    // Replay the retained workspace, not a timer that merely removes the stale control.
    const hiddenStopPage = `<!doctype html><div class="Workspace-IfYAxV" style="display:none!important">
<form><div class="ComposerLayoutFooter-_8IVRO"><button type="button" aria-label="Stop"><svg><path d="M4 4H16V16H4Z"></path></svg></button></div></form></div>
<main>${exchange('h0', 'Marker prompt', 'hidden-stop-0', 'STALE_STOP_DIAGNOSTIC_OK')}
<button aria-label="Copy"></button><button aria-label="Rate response"></button><button aria-label="Regenerate response"></button></main>`;
    pages.set('/c/hidden-stop', hiddenStopPage);
    await navigate(`${origin}/c/hidden-stop`);
    const hiddenStopJob = { ...navJob, id: 'hidden-stop', conversationId: 'hidden-stop', chatUrl: `${origin}/c/hidden-stop`,
      config: { worker: { pollMs: 20, completionTimeoutMs: 1000 } } };
    const beforeHiddenCompletion = opens.length;
    const hiddenCompletion = await waitForCompletion(hiddenStopJob, 0);
    assert.deepEqual(hiddenCompletion.result, { responseIndex: 0, responseText: 'STALE_STOP_DIAGNOSTIC_OK' },
      'A non-rendered Home composer must not hold a finished conversation until the stale-stop reload');
    assert.equal(opens.length - beforeHiddenCompletion, 1, 'Only normal committed-turn reconciliation reloads the conversation');

    // A hidden match can precede a real generating control. Offscreen is not non-rendered:
    // polling must still wait with unchanged text, no text during thinking, and Deep Research.
    await evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="live-stop" aria-label="Stop" style="position:absolute;left:-10000px">Stop</button>')`);
    for (const [text, tool] of [['UNCHANGED PARTIAL', undefined], ['', undefined], ['Deep Research has started.', 'deep_research']]) {
      await evaluate(`document.querySelector('[data-chatgpt-selection-message-id="hidden-stop-0"]').textContent=${JSON.stringify(text)}`);
      await assert.rejects(waitForCompletion({ ...hiddenStopJob, selection: { provider: 'chatgpt', tool },
        config: { worker: { pollMs: 20, completionTimeoutMs: 150 } } }, 0), /Timed out waiting for ChatGPT response completion/,
      'A rendered stop remains authoritative, regardless of action buttons or text stability');
    }
    await evaluate(`document.querySelector('#live-stop').remove()`);
    assert.equal((await evaluate(observeConversationExpression({ conversationId: 'hidden-stop', stopSelector: CHATGPT_STOP_CONTROL_SELECTOR }))).stopPresent, false);
    console.log('Hidden-workspace stop replay: prompt completion; active, empty-thinking, and research turns still wait.');

    // A capture that cannot reach the bound turn saves nothing, least of all text streamed from
    // another conversation, and records that recollection (never resubmission) recovers it.
    const navDir = join(root, 'nav-job');
    await mkdir(navDir);
    const collectJob = { ...navJob, phase: 'downloading_artifacts', responsePath: join(navDir, 'response.md'), config: { artifacts: { capture: true } } };
    await navigate(`${origin}/c/foreign`);
    const missed = await makeWorker(navDir).collect(collectJob, { conversationId: 'own', responseIndex: 4 }, 'FOREIGN FINISHED ANSWER');
    assert.equal(existsSync(collectJob.responsePath), false, 'No response is written from an unbound read');
    assert.equal(missed.recollectionNeeded, true);
    assert.equal(missed.collectionStatus, 'failed');
    assert(missed.collectionRequiredMissing.includes('bound_response_capture'));
    // From another conversation's page, collection reopens the job's own and captures its turn.
    await navigate(`${origin}/c/foreign`);
    const recovered = await makeWorker(navDir).collect(collectJob, { conversationId: 'own', responseIndex: 1 }, 'FOREIGN FINISHED ANSWER');
    assert.equal(await readFile(collectJob.responsePath, 'utf8'), 'OWN FINAL ANSWER');
    assert.equal(recovered.recollectionNeeded, undefined);
    assert.equal(recovered.collectionBinding.messageId, 'own-1');
    assert.deepEqual([recovered.observedTurn.durationLabel, recovered.observedTurn.durationSeconds], ['Worked for 15m 7s', 907]);
    assert.equal(recovered.lifecycleEvents.filter((event) => event.kind === 'navigation').length, 1);

    // A positional binding saved by a failed capture is recollected through the user turn that
    // carries the job's own archive; the reply must still sit at the saved index.
    const anchoredDir = join(root, 'anchored-job');
    await mkdir(anchoredDir);
    const anchoredJob = { id: 'anchored', status: 'complete', phase: 'complete', completedAt: new Date().toISOString(), conversationId: 'own', chatUrl: ownUrl,
      archivePath: '/synthetic/nav/context-nav.tar.zst', collectionBinding: { conversationId: 'own', responseIndex: 1 }, responsePath: join(anchoredDir, 'response.md'),
      runtimeSessionName: 'oracle-b1c2d3e4-0000-4000-8000-000000000001', cleanupPending: false, selection: { provider: 'chatgpt' },
      config: { artifacts: { capture: true }, browser: { chatGptRelayEndpoint: 'http://127.0.0.1:9224' } } };
    await navigate(`${origin}/c/foreign`);
    const anchored = await makeWorker(anchoredDir).recollect(anchoredJob);
    assert.equal(anchored.collectionStatus, 'complete', anchored.recollectionError);
    assert.equal(await readFile(anchoredJob.responsePath, 'utf8'), 'OWN FINAL ANSWER');
    assert.equal(anchored.collectionBinding.messageId, 'own-1', 'The archive anchor yields the exact turn identity');
    assert.match(anchored.collectionBinding.turnSha256, /^[a-f0-9]{64}$/);
    assert.equal('anchorFileName' in anchored.collectionBinding, false);
    const refusedDir = join(root, 'refused-job');
    await mkdir(refusedDir);
    const refusedJob = { ...anchoredJob, collectionBinding: { conversationId: 'own', responseIndex: 0 }, responsePath: join(refusedDir, 'response.md') };
    const refused = await makeWorker(refusedDir).recollect(refusedJob);
    assert.match(refused.recollectionError, /assistant turn 1, not the saved turn 0; refusing anchored recollection/);
    assert.equal(existsSync(refusedJob.responsePath), false);
    pages.set('/c/own', ownPage('OWN FINAL ANSWER', false, 'Earlier prompt <span>context-nav.tar.zst</span>'));
    const doubled = await makeWorker(refusedDir).recollect({ ...refusedJob, collectionBinding: { conversationId: 'own', responseIndex: 1 } });
    assert.match(doubled.recollectionError, /appears in several user turns/);
    assert.equal(existsSync(refusedJob.responsePath), false);

    // The composer control wait is evaluated through toString in pages that get no animation frames.
    await evaluate(`document.body.innerHTML = '<button id="plus" style="position:fixed;left:10px;top:10px;width:40px;height:40px">+</button>'; window.requestAnimationFrame = () => 0;`);
    assert.equal(await evaluate(`(${waitForStationaryControl.toString()})('#plus', { timeoutMs: 3000 })`), true, 'The control wait ends without animation frames');

    // The send state says whether a failure may have followed a prompt the provider received.
    const sendSource = extract(['clickSend']);
    const sendStates = [];
    const runSend = (activation, accepted) => new Function('activation', 'accepted', 'sendStates', `
      let current = {};
      async function mutateJob(fn) { current = fn(current); sendStates.push(current.promptSendState); return current; }
      async function waitForSendReady() {}
      async function sendAcceptanceState() { return {}; }
      async function activateSendButton() { return activation; }
      async function waitForSendAccepted() { return accepted; }
      async function captureDiagnostics() {}
      async function log() {}
      function sendLabelsForJob() { return ['Send prompt']; }
      function isGrokJob() { return false; }
      ${sendSource}
      return clickSend({}, 0);`)(activation, accepted, sendStates);
    await runSend({ ok: true }, true);
    assert.deepEqual(sendStates.splice(0), ['attempted', 'accepted']);
    await assert.rejects(runSend({ ok: false, reason: 'disabled' }, true), /Could not activate/);
    assert.deepEqual(sendStates.splice(0), ['attempted', 'not_sent'], 'A click that never happened sent nothing');
    await assert.rejects(runSend({ ok: true }, false), /did not leave the composer/);
    assert.deepEqual(sendStates.splice(0), ['attempted'], 'An unconfirmed send may have reached the provider');
  }
  await recollectionCases({ root, origin, pages, evaluate, navigate });
  console.log(JSON.stringify({ status: 'passed', syntheticOnly: true, exactCode: true, richDom: true, genericDownload: true, frameExport: true, hostDelegatedNativeExport: true,
    researchWidgetState: true, researchCitations: true, idempotentCollection: true, partialPreserved: true, conversationGuard: true, anchoredRecollection: true,
    composerHydration: true, restoredDraftReplacement: true, frameFreeControlWait: true, promptSendState: true, oldTurnClicks: 0, sends: 0 }));
} finally {
  cdp?.close();
  fixture.close();
  processHandle.kill('SIGTERM');
  await new Promise((resolve) => { if (processHandle.exitCode !== null) resolve(); else processHandle.once('exit', resolve); });
  await rm(root, { recursive: true, force: true });
}

// These cases execute the production declarations and their serialized page expressions. Only
// transport, time and resource ownership are fixtures; capture, collection and disk writes are real.
async function recollectionCases({ root, origin, pages, evaluate, navigate }) {
  const candidateRoot = fileURLToPath(new URL('../', import.meta.url));
  const directory = join(root, 'recollection');
  const timeoutText = 'Timed out waiting for ChatGPT response completion';
  const at = '2026-01-01T00:00:00.000Z';
  const cases = [];
  // The lifecycle log is bounded at 64 entries; these tuple cases use short histories, not a full log.
  const terminal = job => [job.status, job.phase, job.error, job.completedAt,
    lifecycle.getLatestOracleTerminalLifecycleEvent(job), job.recollectionCompletionVerifiedAt];
  const fileMap = async directory => {
    const result = {};
    const visit = async (path, prefix = '') => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(path, entry.name), name + '/');
        else result[name] = (await readFile(join(path, entry.name))).toString('base64');
      }
    };
    await visit(directory);
    return result;
  };
  async function fixture(options = {}, sourceRoot = candidateRoot, change = text => text) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory);
    const jobPath = join(directory, 'job.json');
    const source = change(await readFile(join(sourceRoot, 'extensions/oracle/worker/run-job.mjs'), 'utf8'));
    const syntax = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declarations = names => {
      const found = syntax.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.includes(node.name?.text));
      assert.equal(found.length, names.length, names.join(', '));
      return found.map(node => node.getText(syntax)).join('\n');
    };
    const load = path => import(pathToFileURL(join(sourceRoot, 'extensions/oracle', path)).href);
    const life = { ...await load('shared/job-lifecycle-helpers.mjs') };
    if (change.lifecycle) life.timedOutRecollectionBinding = new Function(`return ${change.lifecycle(life.timedOutRecollectionBinding.toString())};`)();
    const capture = await load('worker/response-capture.mjs');
    const flow = await load('worker/chatgpt-flow-helpers.mjs');
    const ui = await load('worker/chatgpt-ui-helpers.mjs');
    const signals = await load('worker/provider-page-signals.mjs');
    const page = { id: 'bound', text: 'Complete reply', stop: false, ...options.page };
    let now = Date.parse(at), evaluations = 0, opens = 0, sent = options.mode !== 'ordinary', failed = false;
    const events = { writes: [], calls: [], logs: [], captures: 0, downloads: 0, afterShutdown: 0, readsAfterOutcome: 0, history: [], returns: [] };
    const fakeProcess = new EventEmitter();
    Object.assign(fakeProcess, { pid: process.pid, argv: ['node', 'worker', 'fixture', '--recollect'], exitCode: 0 });
    let exited;
    const exit = new Promise(resolve => { exited = resolve; });
    let signalled = false, outcomeSaved = false, api;
    const signal = () => { if (!signalled) { signalled = true; fakeProcess.emit('SIGTERM'); } };
    fakeProcess.exit = () => exited();
    const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const body = () => `<div data-message-author-role="user"><span>context-fixture.tar.zst</span></div>` + (sent
      ? options.grok ? `<div class="message-bubble">${escape(page.text)}</div>`
        : `<article data-message-author-role="assistant" ${page.id ? `data-message-id="${page.id}"` : ''} ${options.research ? 'data-report-id="report"' : ''}>${page.html ?? `<p>${escape(page.text)}</p>`}${options.artifact ? '<a download="result.txt" href="/payload.txt">Download result.txt</a>' : ''}</article>` : '')
      + (page.stop ? '<button data-testid="stop-button">Stop</button>' : '')
      + (page.retry ? '<button id="retry">Retry</button>' : '')
      + '<div contenteditable="true">DO_NOT_SEND</div>';
    const render = async () => {
      pages.set('/c/recollection', '<!doctype html><body>' + body());
      await evaluate(`document.body.innerHTML=${JSON.stringify(body())};`);
    };
    pages.set('/c/recollection', '<!doctype html><body>' + body());
    pages.set('/payload.txt', options.invalidArtifact ? '<!doctype html><html>Sign in</html>' : 'artifact payload\n');
    await navigate(`${origin}/c/recollection`);
    const job = { id: 'fixture', status: options.mode === 'complete' ? 'complete' : 'failed', phase: options.mode === 'complete' ? 'complete' : 'failed',
      createdAt: at, submittedAt: at, phaseAt: at, completedAt: at, error: options.mode === 'complete' ? undefined : options.timeoutError ?? (options.grok ? 'Timed out waiting for Grok response completion' : timeoutText),
      promptSendState: 'accepted', archivePath: '/fixture/context-fixture.tar.zst', conversationId: 'recollection', chatUrl: `${origin}/c/recollection`,
      collectionBinding: { conversationId: 'recollection', responseIndex: 0, ...options.binding }, recollectionNeeded: true,
      runtimeId: 'fixture', runtimeSessionName: 'prior', cleanupPending: false, responsePath: join(directory, 'response.md'),
      promptPath: join(directory, 'prompt.txt'), selection: { provider: options.grok ? 'grok' : 'chatgpt', ...(options.research ? { tool: 'deep_research' } : {}) },
      config: { browser: { chatUrl: `${origin}/c/recollection`, chatGptRelayEndpoint: 'synthetic' }, worker: { completionTimeoutMs: 100, pollMs: 10 }, artifacts: { capture: Boolean(options.artifact) } },
      ...(options.proof ? { recollectionCompletionVerifiedAt: options.proof } : {}) };
    if (options.mode === 'ordinary') Object.assign(job, { status: 'submitted', phase: 'submitted', completedAt: undefined, error: undefined, collectionBinding: undefined });
    await writeFile(jobPath, JSON.stringify(job, null, 2) + '\n');
    await writeFile(job.promptPath, 'Fixture prompt');
    if (options.oldResponse !== undefined) await writeFile(job.responsePath, options.oldResponse);
    if (options.seedFiles) for (const [name, bytes] of Object.entries(options.seedFiles)) {
      if (name === 'artifacts.json' || name.startsWith('artifacts/')) {
        await mkdir(join(directory, 'artifacts'), { recursive: true });
        await writeFile(join(directory, name), Buffer.from(bytes, 'base64'));
      }
    }
    const initial = structuredClone(job);
    const initialFiles = await fileMap(directory);
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const deps = {
      ...life, ...capture, ...flow, ...ui, ...signals,
      Date: Clock, process: fakeProcess, createHash, existsSync, chmod, mkdir, join, basename,
      jobId: job.id, jobDir: directory, jobPath, ORACLE_STATE_DIR: join(root, 'locks'), AGENT_BROWSER_BIN: 'unused',
      AgentBrowserTimeoutError, RELOAD_RECONCILE_TIMEOUT_MS: 100, RELOAD_RECONCILE_POLL_MS: 10,
      STALE_STOP_CONTROL_MS: 120000, MISSING_TURN_RELOAD_MS: 300000, MISSING_TURN_RELOAD_MAX: 1,
      DEEP_RESEARCH_FRAME_WAIT_MS: 100, DEEP_RESEARCH_REPORT_EXPRESSION: 'document.body.innerText', POST_SEND_SETTLE_MS: 0,
      ARTIFACT_DOWNLOAD_TIMEOUT_MS: 1000, GROK_LABELS: { stop: 'Stop model response' },
      readFile: async (path, ...args) => {
        if (path === join(directory, 'response.raw.txt') && options.failRawRead?.()) throw Object.assign(new Error('Injected saved raw-text read failure'), { code: 'EACCES' });
        const value = await readFile(path, ...args);
        if (path === jobPath && outcomeSaved) {
          events.readsAfterOutcome++;
          if (options.signalAt === 'callback') signal();
        }
        return value;
      },
      writeFile: async (path, bytes, ...args) => {
        const text = String(bytes);
        if (path.startsWith(jobPath + '.') && text.includes('"recollectionCompletionVerifiedAt"') && options.signalAt === 'after-callback') signal();
        const point = path.startsWith(jobPath + '.') ? (text.includes('"recollectionCompletionVerifiedAt"') ? 'commit'
          : text.includes('"responseCapturePath"') ? 'outcome' : text.includes('"turnSha256"') ? 'binding' : 'job')
          : path.includes('/artifacts/') ? 'artifact' : path.includes('artifacts.json') && text.includes('"downloaded"') ? 'downloaded-manifest'
          : ['response.block-0.txt', 'response.raw.txt', 'response.raw.html', 'response.md', 'response.capture.json', 'artifacts.json'].find(name => path.includes('/' + name + '.'));
        if (!failed && options.failAt === point) { failed = true; throw new Error('Injected persistence failure: ' + point); }
        return writeFile(path, bytes, ...args);
      },
      rename: async (from, to) => {
        await rename(from, to); events.writes.push(to.slice(directory.length + 1));
        if (to === jobPath) {
          const state = JSON.parse(await readFile(to, 'utf8')); events.history.push(state);
          if (state.responseCapturePath && !state.recollectionCompletionVerifiedAt) {
            outcomeSaved = true;
            if (options.signalAt === 'before-commit') signal();
          }
        }
      },
      withLock, readProcessStartedAt: () => 'fixture-start', randomUUID: () => 'fixture-session',
      jobBlocksAdmission: () => false, usesSharedBrowser: () => true,
      assertAgentBrowserVersionSupported: async () => {}, assertManagedBrowserUnchanged: async () => {},
      tryAcquireRuntimeLeaseForJob: async () => { events.calls.push('runtime-lease'); return true; },
      tryAcquireConversationLeaseForJob: async () => { events.calls.push('conversation-lease'); return true; }, releaseLease: async () => {},
      launchBrowser: async () => { events.calls.push('launch'); }, closeBrowser: async () => {}, cleanupRuntime: async () => [],
      withHeartbeatWhile: async task => task(), heartbeat: async () => {}, log: async message => { events.logs.push(message); }, sleep: async ms => { now += ms; },
      evalPage: async (_job, expression) => {
        evaluations++;
        if (signalled) events.afterShutdown++;
        if (expression.includes('function captureScopedResponse')) events.captures++;
        if (expression.includes('function captureDownload')) events.downloads++;
        await options.beforeRead?.({ page, evaluations, opens, expression, render });
        let result = await evaluate(expression);
        while (typeof result === 'string') { try { result = JSON.parse(result); } catch { break; } }
        if (options.signalAt === 'wait' && events.captures === 1) signal();
        if (options.lateId && events.captures === 1) { page.id = 'bound'; await render(); }
        return result;
      },
      agentBrowser: async (_job, command, url) => {
        events.calls.push(command);
        assert.equal(command, 'open', 'Only conversation navigation is permitted');
        if (!url.startsWith(origin)) return { stdout: '' };
        opens++;
        if (opens > 1 && options.reloadFailure) throw new Error('Fixture reload failed');
        await options.onOpen?.({ page, opens });
        await render(); await navigate(url); return { stdout: '' };
      },
      snapshotText: async () => (page.stop ? '- button "Stop" [ref=stop]\n' : '') + (page.retry ? '- button "Retry" [ref=retry]' : '') + (options.research ? '\n- Iframe "Deep research"' : ''),
      readPageSignals: async () => ({ text: page.failure || '' }),
      findEntry: (_snapshot, predicate) => [{ kind: 'button', label: 'Retry', ref: 'retry', disabled: false }].find(predicate),
      clickRef: async () => { events.calls.push('retry'); throw new Error('Retry activated'); },
      installSignalHandlers: () => {}, waitForOracleReady: async () => {}, configureModel: async () => { events.calls.push('configure'); },
      uploadArchive: async () => { events.calls.push('upload'); }, setComposerText: async () => { events.calls.push('composer'); },
      clickSend: async () => { events.calls.push('send'); sent = true; await render(); },
      observeSelection: async () => undefined, enableDeepResearch: async () => true,
      waitForStableChatUrl: async () => job.chatUrl, currentUrl: async () => job.chatUrl,
      stripChatGptResponseChrome: text => text, captureDiagnostics: async () => {}, promoteQueuedJobsAfterCleanup: async () => {},
      armDeepResearchFrameCapture: async () => {}, boundResearchFrame: async () => {
        if (options.frameFailure) throw new Error('Fixture frame missing');
        return { sessionId: 'fixture-frame', targetId: 'fixture-frame' };
      },
      deepResearchCdp: { evaluate: async (_session, expression) => evaluate(expression) },
      parseEvalResult: value => value,
    };
    const names = ['run', 'runRecollection', 'waitForChatCompletion', 'reconcileStreamedTurn', 'waitForDeepResearchReport',
      'captureBoundTurn', 'acquireBoundTurn', 'collectBoundResult', 'flushArtifactsState', 'preserveCaptureFile',
      'secureWriteText', 'ensurePrivateDir', 'toJsonScript', 'toAsyncJsonScript', 'observeTurns', 'assistantMessages', 'grokAssistantMessages',
      'collectArtifactCandidates', 'returnToOwnConversation', 'noteOwnConversation', 'readJobUnlocked', 'readJob',
      'writeJobUnlocked', 'mutateJob', 'OracleWorkerError', 'isGrokJob', 'providerForJob'];
    deps.events = events;
    api = new Function(...Object.keys(deps), `let currentJob, shuttingDown=false, conversationLeftEpisode=false, managedBrowserChangedError;
      ${declarations(names)}
      const collect = collectBoundResult;
      collectBoundResult = async (...args) => { const result = await collect(...args); events.returns.push(structuredClone(result)); return result; };
      return { run, runRecollection, collectBoundResult, state:()=>currentJob };`)(...Object.values(deps));
    return { initial, initialFiles, page, events, source, render, signal, admission: life.timedOutRecollectionBinding,
      read: async () => JSON.parse(await readFile(jobPath, 'utf8')),
      run: async () => {
        let error;
        try { await (options.mode === 'ordinary' ? api.run() : api.runRecollection()); } catch (caught) { error = caught; }
        if (signalled) await exit;
        return { job: JSON.parse(await readFile(jobPath, 'utf8')), files: await fileMap(directory), events, error: error?.message };
      } };
  }
  const add = (name, run) => cases.push({ name, run });
  const unchanged = (f, result) => {
    assert.deepEqual(terminal(result.job), terminal(f.initial));
    for (const state of result.events.history) assert.deepEqual(terminal(state), terminal(f.initial));
  };
  add('streaming-preserves-terminal-failure', async change => {
    const f = await fixture({ page: { stop: true, text: 'partial' } }, candidateRoot, change);
    const result = await f.run(); unchanged(f, result);
    assert.match(result.job.recollectionError, /generat|completion|deadline/i);
    assert(!result.events.writes.some(path => /response|artifacts/.test(path)));
    const retry = await fixture({}, candidateRoot, change); assert.equal((await retry.run()).job.status, 'complete');
  });
  add('stable-identity-saves-verified-capture', async change => {
    let reloadCaptures = 0;
    const f = await fixture({ beforeRead: async ({ page, opens, expression, render }) => {
      if (opens > 1 && expression.includes('function captureScopedResponse')) {
        page.text = ++reloadCaptures <= 2 ? 'Verified final bytes' : 'Later substituted bytes'; await render();
      }
    } }, candidateRoot, change);
    const result = await f.run(); assert.equal(result.job.status, 'complete');
    assert.match(result.job.recollectionCompletionVerifiedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(Buffer.from(result.files['response.md'], 'base64').toString(), 'Verified final bytes');
    assert.equal(reloadCaptures, 2, 'Save the second stable capture without reading again');
    assert.equal(result.job.collectionBinding.messageId, 'bound');
    assert(result.events.history.filter(state => state.recollectionCompletionVerifiedAt).every(state => state.status === 'complete'));
    assert(!result.events.calls.some(call => ['send', 'retry', 'composer', 'upload', 'configure'].includes(call)));
  });
  add('anchored-identity-required', async change => {
    for (const lateId of [false, true]) {
      const f = await fixture({ page: { id: undefined }, lateId }, candidateRoot, change);
      const result = await f.run(); unchanged(f, result);
      assert.equal(result.events.captures, 1, 'R1 refusal must precede a second read');
      assert(!result.events.writes.some(path => /response|artifacts/.test(path)));
      assert.deepEqual(result.job.collectionBinding, f.initial.collectionBinding);
    }
  });
  add('saved-identity-must-match', async change => {
    for (const id of ['bound', 'replacement', undefined]) {
      const f = await fixture({ binding: { messageId: 'bound' }, page: { id } }, candidateRoot, change);
      const result = await f.run();
      if (id === 'bound') assert.equal(result.job.status, 'complete'); else unchanged(f, result);
    }
  });
  add('empty-current-rendering-borrows-nothing', async change => {
    for (const html of ['<button>Copy</button>', '<p>   </p>', '<pre><code class="language-markdown">   </code></pre>']) {
      const f = await fixture({ page: { html }, oldResponse: 'Earlier response' }, candidateRoot, change);
      const result = await f.run(); unchanged(f, result);
      assert.equal(Buffer.from(result.files['response.md'], 'base64').toString(), 'Earlier response');
    }
  });
  // The pre-write nonempty guard makes the old-response fallback unreachable with a valid
  // strict capture. Keep its explicit exclusion as a structural defense, not a fabricated DOM case.
  add('strict-old-response-fallback-is-excluded', async change => {
    const source = change(await readFile(join(candidateRoot, 'extensions/oracle/worker/run-job.mjs'), 'utf8'));
    assert.match(source, /else if \(!verifiedRecollection && job\.responsePath && existsSync\(job\.responsePath\)\)/);
  });
  add('bound-identity-survives-later-neighbors', async change => {
    const f = await fixture({ beforeRead: async ({ evaluations }) => {
      if (evaluations === 2) await evaluate(`document.querySelector('article').insertAdjacentHTML('beforebegin', '<article data-message-author-role="assistant" data-message-id="neighbor">OTHER REPLY</article>')`);
    } }, candidateRoot, change);
    const result = await f.run(); assert.equal(result.job.status, 'complete');
    assert.equal(Buffer.from(result.files['response.md'], 'base64').toString(), 'Complete reply');
    assert.equal(result.job.collectionBinding.messageId, 'bound');
  });
  add('collector-error-never-commits', async change => {
    for (const failAt of ['binding', 'response.block-0.txt', 'response.raw.txt', 'response.raw.html', 'response.md',
      'response.capture.json', 'artifacts.json', 'downloaded-manifest', 'artifact', 'outcome', 'commit']) {
      const f = await fixture({ failAt, artifact: true, page: { html: '<pre><code class="language-markdown">Current response</code></pre>' } }, candidateRoot, change);
      const result = await f.run(); unchanged(f, result);
      assert.match(result.job.recollectionError, /Injected persistence failure/, failAt);
    }
  });
  add('reload-failure-never-commits', async change => {
    const f = await fixture({ reloadFailure: true }, candidateRoot, change);
    unchanged(f, await f.run());
  });
  add('reload-failure-retains-original-error', async change => {
    const f = await fixture({ reloadFailure: true }, candidateRoot, change);
    const result = await f.run(); unchanged(f, result);
    assert.equal(result.job.recollectionError, 'Fixture reload failed');
  });
  add('reload-instability-and-generation-reset-stability', async change => {
    for (const mode of ['growing', 'generating', 'foreign']) {
      let reloadCaptures = 0;
      const f = await fixture({ beforeRead: async ({ page, opens, expression, render }) => {
        if (opens > 1 && expression.includes('function captureScopedResponse')) {
          reloadCaptures++;
          if (mode === 'foreign') {
            pages.set('/c/foreign-recollection', '<article data-message-author-role="assistant" data-message-id="bound">Foreign reply</article>');
            await navigate(`${origin}/c/foreign-recollection`);
          } else {
            if (mode === 'growing') page.text = `Growing ${reloadCaptures}`;
            else page.stop = reloadCaptures % 2 === 0;
            await render();
          }
        }
      } }, candidateRoot, change);
      unchanged(f, await f.run());
    }
  });
  add('shutdown-before-callback-prevents-proof', async change => {
    for (const signalAt of ['wait', 'before-commit', 'callback']) {
      const f = await fixture({ signalAt }, candidateRoot, change);
      const result = await f.run(); unchanged(f, result);
      assert(!result.events.logs.some(message => message.includes('; job fixture is complete')), signalAt);
      if (signalAt === 'wait') assert.equal(result.events.afterShutdown, 0);
      if (signalAt === 'before-commit') assert.equal(result.events.readsAfterOutcome, 1, 'Only signal finalization may acquire the job after the pre-commit fence');
    }
  });
  add('shutdown-after-callback-is-publication-limit', async change => {
    const f = await fixture({ signalAt: 'after-callback' }, candidateRoot, change);
    const result = await f.run(); assert.equal(result.job.status, 'complete'); assert(result.job.recollectionCompletionVerifiedAt);
  });
  add('completed-recollection-never-initializes-proof', async change => {
    for (const proof of [undefined, at]) {
      const f = await fixture({ mode: 'complete', binding: { messageId: 'bound' }, proof }, candidateRoot, change);
      assert.equal((await f.run()).job.recollectionCompletionVerifiedAt, proof);
    }
  });
  const verifiedHtml = '<h1>Verified heading</h1><p>Original body</p>';
  const assertVerifiedReplyKept = (before, after) => {
    for (const key of ['status', 'phase', 'error', 'errorCode', 'completedAt', 'recollectionCompletionVerifiedAt',
      'collectionBinding', 'responsePath', 'collectionStatus', 'collectionRequiredMissing', 'collectionOptionalMissing', 'artifactPaths']) {
      assert.deepEqual(after.job[key], before.job[key], key);
    }
    assert.match(after.job.recollectionError, /verified reply.*saved hash.*verified response.*kept/);
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
    for (const name of Object.keys(before.files)) if (name !== 'job.json') assert.equal(after.files[name], before.files[name], name);
    assert(!Object.keys(after.files).some(name => name.endsWith('.previous')));
  };
  add('verified-reply-change-is-refused', async change => {
    for (const afterAnchor of [false, true]) {
      let armed = false, reads = 0;
      const f = await fixture({ page: { html: verifiedHtml }, beforeRead: async ({ page, expression, render }) => {
        if (armed && expression.includes('function captureScopedResponse') && ++reads === 2 && afterAnchor) {
          page.html = '<h1>Verified heading</h1><p>Changed body</p>'; await render();
        }
      } }, candidateRoot, change);
      const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
      if (!afterAnchor) { f.page.html = '<h1>Verified heading</h1><p>Changed body</p>'; await f.render(); }
      armed = true;
      const result = await f.run(); assertVerifiedReplyKept(verified, result);
      assert.equal(reads, afterAnchor ? 2 : 1, 'A changed verified reply is not a retryable hydration failure');
    }
  });
  const whitespaceHtml = spaces => `<pre><code class="language-python">print("a${spaces}b")</code></pre>`;
  add('verified-reply-whitespace-change-is-refused', async change => {
    for (const path of ['first', 'retry', 'collector']) {
      let armed = false, reads = 0;
      const f = await fixture({ artifact: true, page: { html: whitespaceHtml(' ') }, beforeRead: async ({ page, expression, render }) => {
        if (!armed || !expression.includes('function captureScopedResponse')) return;
        reads++;
        if (path === 'retry' && reads === 1) {
          pages.set('/c/whitespace-foreign', '<article data-message-author-role="assistant" data-message-id="bound">Foreign reply</article>');
          await navigate(`${origin}/c/whitespace-foreign`);
        } else if (path === 'collector' && reads === 2) {
          page.html = whitespaceHtml('  '); await render();
        }
      } }, candidateRoot, change);
      const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
      const savedText = Buffer.from(verified.files['response.raw.txt'], 'base64').toString();
      assert(savedText.includes('print("a b")'));
      assert.equal(turnContentSha256(savedText), turnContentSha256(savedText.replace('print("a b")', 'print("a  b")')),
        'Whitespace changes are invisible to the legacy identity hash');
      if (path !== 'collector') { f.page.html = whitespaceHtml('  '); await f.render(); }
      armed = true;
      const result = await f.run(); assertVerifiedReplyKept(verified, result);
      assert.equal(reads, path === 'first' ? 1 : 2, path);
    }
  });
  add('verified-reply-missing-raw-text-is-refused', async change => {
    const f = await fixture({ artifact: true, page: { html: verifiedHtml } }, candidateRoot, change);
    const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
    await rm(join(directory, 'response.raw.txt'));
    const files = { ...verified.files }; delete files['response.raw.txt'];
    const captures = f.events.captures;
    const result = await f.run(); assertVerifiedReplyKept({ job: verified.job, files }, result);
    assert.equal(f.events.captures - captures, 1, 'An absent saved raw text is not retried or recreated');
  });
  add('verified-reply-unreadable-raw-text-is-refused', async change => {
    let failRawRead = false;
    const f = await fixture({ artifact: true, page: { html: verifiedHtml }, failRawRead: () => failRawRead }, candidateRoot, change);
    const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
    const captures = f.events.captures; failRawRead = true;
    const result = await f.run(); assertVerifiedReplyKept(verified, result);
    assert.equal(f.events.captures - captures, 1, 'An unreadable saved raw text is a permanent refusal');
  });
  add('verified-reply-redacted-text-recollects', async change => {
    const text = 'Transport https://example.invalid/file?X-Amz-Signature=SYNTHETIC_SECRET';
    const f = await fixture({ page: { text } }, candidateRoot, change);
    const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
    const savedText = Buffer.from(verified.files['response.raw.txt'], 'base64').toString();
    assert.equal(savedText, redactTransportSecrets(text));
    assert.notEqual(savedText, text, 'The capture and its saved redacted form are distinguishable');
    assert.equal(verified.job.collectionBinding.turnSha256, turnContentSha256(text));
    const result = await f.run(); assert.equal(result.job.recollectionError, undefined);
    assert.equal(result.job.recollectionCompletionVerifiedAt, verified.job.recollectionCompletionVerifiedAt);
    assert.deepEqual(result.job.collectionBinding, verified.job.collectionBinding);
    assert.equal(result.files['response.raw.txt'], verified.files['response.raw.txt']);
    assert.equal(result.files['response.md'], verified.files['response.md']);
    assert.equal(f.events.returns.length, 2, 'The saved form, not unredacted capture text, authorizes recollection');
  });
  add('verified-reply-equal-text-recollects', async change => {
    const f = await fixture({ artifact: true, page: { html: verifiedHtml } }, candidateRoot, change);
    const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
    assert.notEqual(turnContentSha256(Buffer.from(verified.files['response.md'], 'base64').toString()), verified.job.collectionBinding.turnSha256,
      'Rendered Markdown differs from raw text, so hashing response.md is a discriminating mutation');
    const result = await f.run(); assert.equal(result.job.recollectionError, undefined);
    assert.equal(result.job.recollectionCompletionVerifiedAt, verified.job.recollectionCompletionVerifiedAt);
    assert.deepEqual(result.job.collectionBinding, verified.job.collectionBinding);
    assert.equal(result.job.collectionStatus, verified.job.collectionStatus);
    assert.equal(result.files['response.md'], verified.files['response.md']);
    assert.equal(f.events.returns.length, 2, 'Equal raw text still reaches artifact collection');
    assert.equal(f.events.downloads, 1, 'The validated artifact is reused');
  });
  add('verified-reply-missing-hash-is-refused', async change => {
    const f = await fixture({ page: { html: verifiedHtml } }, candidateRoot, change);
    const verified = await f.run(); assert.equal(verified.job.status, 'complete'); assert(verified.job.recollectionCompletionVerifiedAt);
    const withoutHash = { ...verified.job, collectionBinding: { ...verified.job.collectionBinding } };
    delete withoutHash.collectionBinding.turnSha256;
    await writeFile(join(directory, 'job.json'), JSON.stringify(withoutHash, null, 2) + '\n');
    assertVerifiedReplyKept({ job: withoutHash, files: verified.files }, await f.run());
  });
  add('recollection-never-sends-or-retries', async change => {
    for (const failure of ['', 'There was an error generating a response']) {
      const f = await fixture({ page: { retry: true, failure } }, candidateRoot, change);
      const result = await f.run();
      assert(!result.events.calls.some(call => ['retry', 'send', 'composer', 'upload', 'configure'].includes(call)));
    }
  });
  add('optional-artifact-failure-and-validated-reuse', async change => {
    const failed = await (await fixture({ artifact: true, invalidArtifact: true }, candidateRoot, change)).run();
    assert.equal(failed.job.phase, 'complete_with_artifact_errors'); assert(failed.job.recollectionCompletionVerifiedAt);
    const first = await (await fixture({ artifact: true }, candidateRoot, change)).run();
    assert.equal(first.job.status, 'complete'); assert.equal(first.events.downloads, 1);
    const second = await (await fixture({ artifact: true, seedFiles: first.files }, candidateRoot, change)).run();
    assert.equal(second.job.status, 'complete'); assert.equal(second.events.downloads, 0);
  });
  add('read-projects-durable-proof-and-staging', async () => {
    const source = await readFile(join(candidateRoot, 'extensions/oracle/lib/tools.ts'), 'utf8');
    const tree = ts.createSourceFile('tools.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'redactJobDetails');
    const deps = { ...lifecycle, buildOracleQueueSnapshot: () => ({}), getJobDir: () => directory };
    const project = new Function(...Object.keys(deps), ts.transpile(declaration.getText(tree)) + '; return redactJobDetails;')(...Object.values(deps));
    for (const status of ['failed', 'complete']) {
      const job = { id: 'fixture', status, phase: status, responsePath: '/staging/response.md', generationStatus: 'completed',
        collectionStatus: 'partial', collectionBinding: { messageId: 'bound' }, recollectionCompletionVerifiedAt: status === 'complete' ? at : undefined };
      const result = project(job);
      for (const key of ['status', 'responsePath', 'generationStatus', 'collectionStatus', 'collectionBinding', 'recollectionCompletionVerifiedAt']) assert.deepEqual(result[key], job[key], key);
    }
  });
  const assertUnsupportedTimeout = async (options, change) => {
    const source = await readFile(join(candidateRoot, 'extensions/oracle/lib/tools.ts'), 'utf8');
    const tree = ts.createSourceFile('tools.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let object;
    const visit = node => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(tree) === 'name' && ts.isStringLiteral(property.initializer) && property.initializer.text === 'oracle_read')) object = node;
      ts.forEachChild(node, visit);
    };
    visit(tree); assert(object);
    const f = await fixture(options, candidateRoot, change);
    const result = await f.run();
    assert.match(result.error, /unsupported.*the job was not changed and nothing was resent/);
    assert.deepEqual(result.files, f.initialFiles);
    assert.deepEqual(result.events.calls, []);
    const deps = { ORACLE_READ_PARAMS: {}, readJobForProject: () => f.initial, getProjectId: () => 'fixture',
      timedOutRecollectionBinding: f.admission, basename,
      buildOracleToolErrorResult: (_tool, error) => ({ error: error.message }),
      execFileAsync: async () => { throw new Error('Worker must not be spawned'); } };
    const reader = new Function(...Object.keys(deps), ts.transpile(`const tool = ${object.getText(tree)};`) + ';return tool;')(...Object.values(deps));
    const refused = await reader.execute('fixture', { jobId: 'fixture', action: 'recollect' }, undefined, undefined, { cwd: 'fixture' });
    assert.match(refused.error, /unsupported.*the job was not changed and nothing was resent/);
  };
  add('grok-provider-with-chatgpt-timeout-is-refused', async change => {
    await assertUnsupportedTimeout({ grok: true, timeoutError: timeoutText }, change);
  });
  add('chatgpt-provider-with-grok-timeout-is-refused', async change => {
    await assertUnsupportedTimeout({ timeoutError: 'Timed out waiting for Grok response completion' }, change);
  });
  add('unsupported-timeouts-are-mutation-free', async change => {
    for (const options of [{ grok: true }, { research: true }]) await assertUnsupportedTimeout(options, change);
    assert.throws(() => timedOutRecollectionBinding({ status: 'failed', error: 'Timed out waiting for Grok response completion' }, undefined, basename), /Grok.*unsupported/);
  });
  const results = [];
  for (const item of cases) {
    if (process.env.PI_ORACLE_CAPTURE_CASE && !item.name.includes(process.env.PI_ORACLE_CAPTURE_CASE)) continue;
    try { await item.run(text => text); results.push({ name: item.name, passed: true }); }
    catch (error) { results.push({ name: item.name, passed: false, error: error.stack || String(error) }); }
    console.log(JSON.stringify(results.at(-1)));
  }
  if (process.env.PI_ORACLE_RECOLLECTION_MUTATIONS === '1') {
    const once = (before, after) => source => {
      assert.equal(source.split(before).length, 2, `Mutation target must occur once: ${before}`);
      return source.replace(before, after);
    };
    const removeLine = fragment => source => {
      const lines = source.split('\n');
      assert.equal(lines.filter(line => line.includes(fragment)).length, 1, fragment);
      return lines.filter(line => !line.includes(fragment)).join('\n');
    };
    const mutations = [
      ['identity requirement', 'anchored-identity-required', removeLine('if (!anchoredTurn.captured.messageId?.trim())')],
      ['saved identity comparison', 'saved-identity-must-match', removeLine('if (savedId && savedId !== anchoredTurn.captured.messageId)')],
      ['second read supplies identity', 'anchored-identity-required', once('const anchoredTurn = await acquireBoundTurn(currentJob, binding);', 'let anchoredTurn = await acquireBoundTurn(currentJob, binding); if (!anchoredTurn.captured.messageId) anchoredTurn = await acquireBoundTurn(currentJob, anchoredTurn.binding);')],
      ['nonempty guard', 'empty-current-rendering-borrows-nothing', removeLine('if (!redactTransportSecrets(rendered).trim())')],
      ['old response borrowing', 'strict-old-response-fallback-is-excluded', once('else if (!verifiedRecollection && job.responsePath', 'else if (job.responsePath')],
      ['strict rethrow', 'collector-error-never-commits', once('if (verifiedRecollection || (error instanceof OracleWorkerError && error.code === "verified_reply_changed")) throw error;', 'if (error instanceof OracleWorkerError && error.code === "verified_reply_changed") throw error;')],
      ['artifact persistence rethrow', 'collector-error-never-commits', removeLine('if (verifiedRecollection && persisting) throw error;')],
      ['bound reload rethrow', 'reload-failure-retains-original-error', removeLine('if (binding) throw error;')],
      ['later capture substitution', 'stable-identity-saves-verified-capture', once('verifiedRecollection ? verifiedRecollection.verifiedTurn : await acquireBoundTurn(job, binding)', 'await acquireBoundTurn(job, binding)')],
      ['proof outside transition', 'stable-identity-saves-verified-capture', once('const verifiedAt = timedOutChat ? new Date().toISOString() : undefined;', 'const verifiedAt = timedOutChat ? new Date().toISOString() : undefined; if (timedOutChat) await mutateJob(job => ({ ...job, recollectionCompletionVerifiedAt: verifiedAt }));')],
      ['proof on complete recollection', 'completed-recollection-never-initializes-proof', once('if (!timedOutChat) await mutateJob((job) => ({ ...job, recollectionError: undefined }));', 'if (!timedOutChat) await mutateJob((job) => ({ ...job, recollectionError: undefined, recollectionCompletionVerifiedAt: new Date().toISOString() }));')],
      ['wait shutdown check', 'shutdown-before-callback-prevents-proof', removeLine('if (recollectionBinding && shuttingDown)')],
      ['pre-commit shutdown check', 'shutdown-before-callback-prevents-proof', removeLine('if (timedOutChat && shuttingDown) return;')],
      ['callback shutdown check', 'shutdown-before-callback-prevents-proof', once('timedOutChat && shuttingDown ? job : transitionOracleJobPhase', 'transitionOracleJobPhase')],
      ['Retry activation', 'recollection-never-sends-or-retries', once('if (!recollectionBinding && !retriedAfterFailure)', 'if (!retriedAfterFailure)')],
      ['Research refusal', 'unsupported-timeouts-are-mutation-free', Object.assign(text => text, { lifecycle: removeLine('if (job.selection?.tool === "deep_research")') })],
      ['Grok refusal', 'unsupported-timeouts-are-mutation-free', Object.assign(text => text, { lifecycle: removeLine('if (job.error === "Timed out waiting for Grok response completion"') })],
      ['Grok provider mismatch', 'grok-provider-with-chatgpt-timeout-is-refused', Object.assign(text => text, { lifecycle: once(' || job.selection?.provider === "grok"', '') })],
      ['Grok timeout-text mismatch', 'chatgpt-provider-with-grok-timeout-is-refused', Object.assign(text => text, { lifecycle: once('job.error === "Timed out waiting for Grok response completion" || ', '') })],
      ['verified reply refusal', 'verified-reply-change-is-refused', once('if (job.recollectionCompletionVerifiedAt) {', 'if (false) {')],
      ['response-file hash substitution', 'verified-reply-equal-text-recollects', once('turnSha256 !== binding.turnSha256', 'turnContentSha256(await readFile(job.responsePath, "utf8")) !== binding.turnSha256')],
      ['verified reply retry suppression', 'verified-reply-change-is-refused', removeLine('if (error instanceof OracleWorkerError && error.code === "verified_reply_changed") throw error;')],
      ['verified reply collector rethrow', 'verified-reply-change-is-refused', once('if (verifiedRecollection || (error instanceof OracleWorkerError && error.code === "verified_reply_changed"))', 'if (verifiedRecollection)')],
      ['verified reply partial-marking exclusion', 'verified-reply-change-is-refused', once('if (timedOutChat || (error instanceof OracleWorkerError && error.code === "verified_reply_changed"))', 'if (timedOutChat)')],
      ['normalized saved-text comparison', 'verified-reply-whitespace-change-is-refused', once('!savedRawText?.equals(Buffer.from(redactTransportSecrets(captured.rawText)))', '(savedRawText ? turnContentSha256(savedRawText.toString("utf8")) !== turnContentSha256(redactTransportSecrets(captured.rawText)) : true)')],
      ['absent saved-text refusal', 'verified-reply-missing-raw-text-is-refused', once('!savedRawText?.equals(Buffer.from(redactTransportSecrets(captured.rawText)))', '(savedRawText && !savedRawText.equals(Buffer.from(redactTransportSecrets(captured.rawText))))')],
      ['comparison before redaction', 'verified-reply-redacted-text-recollects', once('!savedRawText?.equals(Buffer.from(redactTransportSecrets(captured.rawText)))', '!savedRawText?.equals(Buffer.from(captured.rawText))')],
    ];
    for (const [name, caseName, change] of mutations) {
      const mutated = change(await readFile(join(candidateRoot, 'extensions/oracle/worker/run-job.mjs'), 'utf8'));
      assert.equal(ts.createSourceFile('mutation.mjs', mutated, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
      if (change.lifecycle) {
        const helper = change.lifecycle(timedOutRecollectionBinding.toString());
        assert.equal(ts.createSourceFile('mutation.mjs', helper, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length, 0);
      }
      const item = cases.find(item => item.name === caseName);
      let killed = false;
      try { await item.run(change); } catch (error) {
        if (error.code !== 'ERR_ASSERTION') throw error;
        killed = true;
      }
      console.log(JSON.stringify({ mutation: name, killed, case: caseName }));
      assert(killed, `Mutation survived: ${name}`);
    }
  }
  if (process.env.PI_ORACLE_CAPTURE_BASELINE_ROOT) {
    const fixtures = [
      { page: { html: '<h1>Rich reply</h1><p>Body</p>' } },
      { page: { html: '<pre><code class="language-markdown"># Exact\n\nBody</code></pre>' } },
      { page: { id: undefined } },
      { page: { id: undefined, html: '<p class="rerendered">Complete reply</p>' }, binding: { turnSha256: turnContentSha256('Complete reply') } },
      { page: { id: undefined }, binding: { turnSha256: turnContentSha256('Changed reply') }, oldResponse: 'Earlier response' },
      { binding: { messageId: 'missing' }, oldResponse: 'Earlier response' },
      { page: { html: '<div data-message-id="other">Ambiguous</div>' } },
      { page: { html: '<button>Copy</button>' }, oldResponse: 'Earlier response' },
      { artifact: true }, { artifact: true, invalidArtifact: true }, { grok: true }, { research: true, frameFailure: true },
      { research: true, page: { html: '<p>Research completed in 1m · 2 sources</p><h1>Report</h1><p>Report body</p>' } },
    ];
    for (const mode of ['ordinary', 'complete']) for (const [index, options] of fixtures.entries()) {
      const baseline = await (await fixture({ ...options, mode }, process.env.PI_ORACLE_CAPTURE_BASELINE_ROOT)).run();
      const candidate = await (await fixture({ ...options, mode })).run();
      assert.deepEqual(candidate.files, baseline.files, `differential ${mode}/${index} file bytes`);
      assert.deepEqual(candidate.events.returns, baseline.events.returns, `differential ${mode}/${index} collector returns`);
      assert.equal(candidate.error, baseline.error, `differential ${mode}/${index} return error`);
      if (mode === 'ordinary' && !options.frameFailure) {
        assert.equal(baseline.events.returns.length, 1, JSON.stringify({ fixture: index, job: baseline.job, calls: baseline.events.calls }));
      }
      if (options.frameFailure) assert.match(baseline.job.error || baseline.job.recollectionError || '', /report|frame/i);
      if (mode === 'complete' && options.research && !options.frameFailure) {
        assert(baseline.files['response.md'], 'The completed Research fixture must actually capture a report');
        assert.notEqual(baseline.job.collectionStatus, 'failed');
      }
      if (mode === 'ordinary' && options.grok) {
        const metadata = JSON.parse(Buffer.from(baseline.files['response.capture.json'], 'base64').toString());
        assert.equal(metadata.method, 'text_fallback', 'The Grok fixture must exercise its streamed-text fallback');
      }
      console.log(`Differential matched: ${mode}/${index}`);
    }
    for (const mode of ['ordinary', 'complete']) {
      const seed = await (await fixture({ artifact: true, mode })).run();
      const baseline = await (await fixture({ artifact: true, mode, seedFiles: seed.files }, process.env.PI_ORACLE_CAPTURE_BASELINE_ROOT)).run();
      const candidate = await (await fixture({ artifact: true, mode, seedFiles: seed.files })).run();
      assert.deepEqual(candidate.files, baseline.files, `differential ${mode}/validated-reuse file bytes`);
      assert.deepEqual(candidate.events.returns, baseline.events.returns, `differential ${mode}/validated-reuse returns`);
      assert.equal(candidate.events.downloads, 0);
      console.log(`Differential matched: ${mode}/validated-reuse`);
    }
    const whitespacePair = async sourceRoot => {
      const f = await fixture({ mode: 'complete', binding: { messageId: 'bound' }, page: { html: whitespaceHtml(' ') } }, sourceRoot);
      const before = await f.run(); assert.equal(before.job.recollectionCompletionVerifiedAt, undefined);
      f.page.html = whitespaceHtml('  '); await f.render();
      const after = await f.run(); assert.equal(after.job.recollectionError, undefined);
      assert.equal(after.job.recollectionCompletionVerifiedAt, undefined);
      assert.equal(after.job.collectionBinding.turnSha256, before.job.collectionBinding.turnSha256);
      assert.notEqual(after.files['response.raw.txt'], before.files['response.raw.txt']);
      assert(Buffer.from(after.files['response.raw.txt'], 'base64').toString().includes('print("a  b")'));
      return after;
    };
    const baseline = await whitespacePair(process.env.PI_ORACLE_CAPTURE_BASELINE_ROOT);
    const candidate = await whitespacePair(candidateRoot);
    assert.deepEqual(candidate.files, baseline.files, 'differential complete/whitespace-only-change file bytes');
    assert.deepEqual(candidate.events.returns, baseline.events.returns, 'differential complete/whitespace-only-change returns');
    assert.equal(candidate.error, baseline.error, 'differential complete/whitespace-only-change return error');
    console.log('Differential matched: complete/whitespace-only-change');
  } else console.log('SKIP differential: set PI_ORACLE_CAPTURE_BASELINE_ROOT to a second source root (no fetch or vendored baseline).');
  console.log(`Recollection cases: ${results.filter(result => result.passed).length} passed, ${results.filter(result => !result.passed).length} failed`);
  assert(results.every(result => result.passed), 'Recollection acceptance failed');
}
