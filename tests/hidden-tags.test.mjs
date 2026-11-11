// tests/hidden-tags.test.mjs — P26：回复标签块（thinking / state）要配双通道隐藏正则
import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenTagGaps } from '../src/forge/lib/protocol.mjs';
import { detectFrameworks } from '../src/forge/lib/extras.mjs';

const thinkingRule = { findRegex: '<thinking>[\\s\\S]*?<\\/thinking>\\s*', markdownOnly: true, promptOnly: true };
const stateRule = { findRegex: '/<state>[\\s\\S]*?<\\/state>\\s*/g', markdownOnly: true, promptOnly: true };
const body = '回复结构：<thinking>推演</thinking> 正文，末尾 <state>\n诡异.主角.心神: -6\n</state>';

test('只有 thinking 正则、正文要求 <state> 时报 state 缺口', () => {
  assert.deepEqual(hiddenTagGaps([body], [thinkingRule]), ['state']);
});

test('两条正则都在时没有缺口；/…/g 写法和裸写法都认', () => {
  assert.deepEqual(hiddenTagGaps([body], [thinkingRule, stateRule]), []);
});

test('只开一个通道或已停用的正则不算', () => {
  assert.deepEqual(hiddenTagGaps([body], [thinkingRule, { ...stateRule, promptOnly: false }]), ['state']);
  assert.deepEqual(hiddenTagGaps([body], [thinkingRule, { ...stateRule, disabled: true }]), ['state']);
});

test('一条正则同时覆盖多个标签也算', () => {
  const both = { findRegex: '/<(thinking|think|state)>[\\s\\S]*?<\\/\\1>/g', markdownOnly: true, promptOnly: true };
  assert.deepEqual(hiddenTagGaps([body], [both]), []);
});

test('正文没提到标签块时不报', () => {
  assert.deepEqual(hiddenTagGaps(['普通说明'], []), []);
});

test('detectFrameworks：<state> / xbgetvar 标记为变量 2.0', () => {
  const fw = detectFrameworks({ data: { description: '{{xbgetvar_yaml::诡异}}', extensions: {} } });
  assert.equal(fw.find(f => f.id === 'xiaobaix')?.state2, true);
  const tasksOnly = detectFrameworks({ data: { description: '', extensions: { 'xiaobaix-tasks': { tasks: [{ name: 'a', commands: 'x' }] } } } });
  assert.equal(tasksOnly.find(f => f.id === 'xiaobaix')?.state2 ?? false, false);
});
