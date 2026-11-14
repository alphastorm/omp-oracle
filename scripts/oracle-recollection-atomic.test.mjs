import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { CHATGPT_STOP_CONTROL_SELECTOR } from '../extensions/oracle/worker/chatgpt-ui-helpers.mjs';
import { turnContentSha256 } from '../extensions/oracle/worker/response-capture.mjs';

test('the worker reads saved conversation generation and bound capture in one page evaluation', async () => {
  const source = readFileSync(new URL('../extensions/oracle/worker/run-job.mjs', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && ['captureBoundTurn', 'toJsonScript'].includes(node.name?.text));
  assert.equal(functions.length, 2);
  let evaluations = 0;
  const deps = {
    CHATGPT_STOP_CONTROL_SELECTOR, turnContentSha256,
    observeConversationExpression: options => {
      assert.equal(options.conversationId, 'bound-thread');
      assert.equal(options.stopSelector, CHATGPT_STOP_CONTROL_SELECTOR);
      return 'observe()';
    },
    captureExpression: binding => { assert.equal(binding.messageId, 'bound'); return 'capture()'; },
    evalPage: async (_job, expression) => {
      evaluations++;
      assert(expression.includes('observe()') && expression.includes('capture()'));
      return JSON.parse(new Function('observe', 'capture', `return ${expression};`)(
        () => ({ onConversation: true, stopPresent: true }),
        () => ({ rawText: 'partial', rawHtml: '<p>partial</p>', messageId: 'bound' })));
    },
  };
  const captureBound = new Function(...Object.keys(deps), `${functions.map(node => node.getText(tree)).join('\n')}; return captureBoundTurn;`)(...Object.values(deps));
  const result = await captureBound({}, { conversationId: 'bound-thread', messageId: 'bound' }, { observeGeneration: true });
  assert.equal(evaluations, 1);
  assert.equal(result.observation.stopPresent, true);
  assert.equal(result.captured.rawText, 'partial');
});
