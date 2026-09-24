#!/usr/bin/env node
// Exercise actual worker functions on an explicitly owned ChatGPT tab; never send.
// Usage: node scripts/oracle-composer-proof.mjs SESSION TARGET [DRAFT] [EXISTING_DRAFT]
// Add --research-tool to prove fill -> Deep Research selection, retaining the tab for inspection.
// ORACLE_COMPOSER_CDP_URL (required) is the DevTools HTTP origin of the signed-in browser to drive; there is no default.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseSnapshotEntries } from '../extensions/oracle/worker/artifact-heuristics.mjs';
import { isDeepResearchMenuEntry, snapshotHasDeepResearchPill } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';

const researchTool = process.argv.includes('--research-tool');
const [session, target, draftFile, existingDraftFile] = process.argv.slice(2).filter(v => v !== '--research-tool');
assert(session && target, 'Supply an existing pinned diagnostic session and its owned target ID');
const endpoint = process.env.ORACLE_COMPOSER_CDP_URL;
assert(endpoint, 'Set ORACLE_COMPOSER_CDP_URL to the DevTools HTTP origin of the signed-in browser to drive; there is no default, so the probe never lands in another account');
console.log(JSON.stringify({ event: `Driving the browser at ${endpoint}` }));
const prefix = ['--session', session, '--cdp', endpoint, '--pin-tab'];
const binary = process.env.AGENT_BROWSER_PATH || '/opt/homebrew/bin/agent-browser';
const run = (args, input) => execFileSync(binary, [...prefix, ...args], {
  encoding: 'utf8', input, timeout: 35000, maxBuffer: 4 * 1024 * 1024,
});
const tabs = JSON.parse(run(['--json', 'tab', 'list'])).data.tabs;
assert(tabs.some(t => t.targetId === target && t.active), 'Refusing a tab not owned by this probe');

// Parse declarations to exercise production behavior without launching the worker entrypoint.
const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('run-job.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['parseEvalResult', 'toJsonScript', 'toAsyncJsonScript', 'evalPage', 'snapshotText', 'findEntry', 'clickRef', 'setComposerText', 'enableDeepResearch', 'OracleWorkerError']);
const declarations = tree.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && names.has(n.name?.text));
assert.equal(declarations.length, names.size, 'Worker function extraction is incomplete');
const agentBrowser = async (_job, ...args) => {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {};
  return { stdout: run(args, options.input) };
};
const labels = { composer: 'Chat with ChatGPT', addFiles: 'Add files and more' };
const api = new Function('agentBrowser', 'parseSnapshotEntries', 'isGrokJob', 'labelsForJob',
  'CHATGPT_LABELS', 'isDeepResearchMenuEntry', 'snapshotHasDeepResearchPill', 'log',
  declarations.map(n => n.getText(tree)).join('\n') + '\nreturn {setComposerText, enableDeepResearch, snapshotText, evalPage, toJsonScript};')(
  agentBrowser, parseSnapshotEntries, () => false, () => labels, labels,
  isDeepResearchMenuEntry, snapshotHasDeepResearchPill, async message => console.log(JSON.stringify({ event: message })),
);
const evaluate = body => api.evalPage({}, api.toJsonScript(body));
const content = async () => (await evaluate("return {text: document.querySelector('#prompt-textarea')?.innerText ?? null};")).text;
const normalize = text => text.replace(/\s+/g, ' ').trim();
const toolText = async () => (await evaluate(`
  const el=document.querySelector('#prompt-textarea');
  return {text:Array.from(el.childNodes).map(n=>{const c=n.cloneNode(true);c.querySelectorAll?.('[data-inline-selection-pill]').forEach(p=>p.replaceWith('\\u001f'));return c.textContent;}).join('\\n')};
`)).text;
assert((await evaluate('return {origin: location.origin};')).origin === 'https://chatgpt.com');
run(['wait', '#prompt-textarea']);

if (researchTool) {
  assert(draftFile, 'Tool-selection proof requires the exact prepared prompt file');
  const prompt = readFileSync(draftFile, 'utf8');
  const before = normalize((await toolText()).replace('\u001f ', '').replace('\u001f', ''));
  assert(!before || before === normalize(prompt), 'Refusing an unrelated existing draft');
  await api.setComposerText({}, prompt);
  await api.enableDeepResearch({});
  assert(snapshotHasDeepResearchPill(await api.snapshotText({}), labels.composer));
  const [beforePill,afterPill,...extraPills]=(await toolText()).split('\u001f');
  assert(afterPill !== undefined && !extraPills.length && !normalize(afterPill) && normalize(beforePill) === normalize(prompt), 'Tool selection must preserve the complete prompt and place its pill after the text');
  console.log(JSON.stringify({status:'passed',target,sent:false,deep_research_tool_verified:true,diagnostic_draft_retained:true}));
} else {
  const marker = 'ORACLE_COMPOSER_PROOF';
  const predecessorFile = existingDraftFile || draftFile;
  const predecessor = `${marker}: ${predecessorFile ? readFileSync(predecessorFile, 'utf8') : 'saved predecessor draft that must not leak into the next request.'}`;
  const replacement = existingDraftFile ? readFileSync(draftFile, 'utf8') : `${marker}: replacement request.\n\nOnly this request belongs in the composer.`;
  if (!existingDraftFile && normalize(await content()) === normalize(predecessor)) {
    await evaluate("const el=document.querySelector('#prompt-textarea'); el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); return true;");
  }
  assert(normalize(await content()) === (existingDraftFile ? normalize(predecessor) : ''), 'Refusing to erase an unrelated existing draft');
  try {
    if (!existingDraftFile) await api.setComposerText({}, predecessor);
    assert(normalize(await content()) === normalize(predecessor), 'Predecessor fixture is not present');
    await api.setComposerText({}, replacement);
    const actual = await content();
    assert(normalize(actual) === normalize(replacement), 'Replacement appended to the existing draft');
    console.log(JSON.stringify({ status:'passed',target,sent:false,nonempty_predecessor:true,replacement_only:true,observed_characters:actual.length }));
  } finally {
    const remaining = await content();
    if (remaining?.trim()) {
      assert([predecessor,replacement,predecessor+replacement,predecessor+'\n'+replacement].some(text => normalize(text) === normalize(remaining)), 'Unexpected concurrent draft; preserving it');
      await evaluate("const el=document.querySelector('#prompt-textarea'); el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); return !el.innerText.trim();");
      assert(normalize(await content()) === '', 'Owned diagnostic draft did not clear');
    }
  }
}
