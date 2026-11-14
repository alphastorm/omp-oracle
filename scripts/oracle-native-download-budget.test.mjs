import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { activateDownloadControl, collectNativeDownload } from '../extensions/oracle/worker/response-capture.mjs';

const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const activateNode = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'activateReportExport');
assert(activateNode);

for (const slowStage of ['setup', 'activation', 'bytes', 'teardown']) {
  test(`native export ${slowStage} consumes the same absolute remaining budget`, async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const listeners = new Map(), observed = [];
    const spend = async (stage, timeout) => {
      const wanted = stage === slowStage ? 90000 : 1;
      observed.push({ stage, timeout });
      now += Math.min(wanted, timeout ?? wanted);
      if (timeout !== undefined && wanted >= timeout) throw new Error('CDP deadline reached');
    };
    const cdp = {
      on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); },
      send: async (method, params, _session, timeout) => {
        const stage = params?.expression?.includes('activateDownloadControl') ? 'activation'
          : params?.expression?.includes('readRegisteredDownload') ? 'bytes'
          : params?.expression?.includes('disarmDownloadRegistry') ? 'teardown' : 'setup';
        await spend(stage, timeout);
        if (stage === 'activation') {
          listeners.get('Page.downloadWillBegin')({ method: 'Page.downloadWillBegin', sessionId: 'page',
            params: { guid: 'g', frameId: 'frame', url: 'blob:test', suggestedFilename: 'report.md' } });
          listeners.get('Page.downloadProgress')({ method: 'Page.downloadProgress', sessionId: 'page',
            params: { guid: 'g', state: 'completed', totalBytes: 1 } });
        }
        return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame' } } }
          : { result: { value: stage === 'bytes' ? 'eA==' : true } };
      },
      evaluate: async () => { await spend('teardown'); return true; },
    };
    const activate = new Function('deepResearchCdp', 'activateDownloadControl',
      `const ARTIFACT_DOWNLOAD_TIMEOUT_MS=90000; ${activateNode.getText(tree)}; return activateReportExport;`)(cdp, activateDownloadControl);
    await assert.rejects(collectNativeDownload({ cdp, pageSessionId: 'page', timeoutMs: 20, deadlineAt: 20,
      activate: remaining => activate({ sessionId: 'page' }, '#export', remaining) }), /deadline|budget/);
    assert(now <= 20, `${slowStage} spent ${now}ms beyond the 20ms whole-operation deadline`);
    assert.equal(listeners.size, 0);
    assert(observed.every(value => value.timeout !== undefined), 'every awaited CDP operation must carry its remaining budget');
  });
}

test('an exhausted activation budget cannot click the export control', async t => {
  let clicks = 0;
  const priorDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ click() { clicks++; } }) };
  t.after(() => { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; });
  await assert.rejects(activateDownloadControl('#export', true, 0), /deadline/);
  assert.equal(clicks, 0);
});

test('an export menu arriving at the activation deadline is not clicked', async t => {
  let now = 0, menuClicks = 0;
  t.mock.method(Date, 'now', () => now);
  const priorDocument = globalThis.document, priorTimer = globalThis.setTimeout;
  const element = { click() {} };
  globalThis.document = { querySelector: () => element,
    querySelectorAll: () => [{ textContent: 'Export to Markdown', getClientRects: () => [1], click() { menuClicks++; } }] };
  globalThis.setTimeout = (fn, ms) => { now += ms; queueMicrotask(fn); };
  t.after(() => { globalThis.setTimeout = priorTimer; if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; });
  await assert.rejects(activateDownloadControl('#export', true, 5), /deadline/);
  assert.equal(menuClicks, 0);
  assert.equal(now, 5);
});
