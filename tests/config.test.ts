import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, QQ_DEFAULTS, toIds } from '../src/config.ts';

// 回归：`Number("")` 是 0 且 `isFinite(0)` 为真，早期实现会把「留空=不监听」
// 解析成「监听 0 号」，面板清空后读回来永远显示 0，表现为「保存不了」。
test('toIds 留空/纯分隔符 → 空数组，不得产生 0 号', () => {
  assert.deepEqual(toIds(''), [], '空串应为空数组');
  assert.deepEqual(toIds('   '), [], '纯空格应为空数组');
  assert.deepEqual(toIds(','), [], '逗号应为空数组');
  assert.deepEqual(toIds(',,,'), []);
  assert.deepEqual(toIds(['']), [], '数组里的空串同样应被丢掉');
  assert.deepEqual(toIds([0]), [], '0 不是合法群号/QQ 号');
  assert.deepEqual(toIds('0'), []);
  assert.deepEqual(toIds(-5), []);
  assert.deepEqual(toIds(1.5), [], '非整数不接受');
});

test('toIds 正常号码解析不变', () => {
  assert.deepEqual(toIds('111,222 333'), [111, 222, 333]);
  assert.deepEqual(toIds([111, '222']), [111, 222]);
  assert.deepEqual(toIds(null), []);
  assert.deepEqual(toIds(undefined), []);
});

test('normalizeConfig 字符串 groups/privates 按空格/逗号解析为数字数组', () => {
  const out = normalizeConfig({ groups: '111,222 333', privates: '9' } as never);
  assert.deepEqual(out.groups, [111, 222, 333], '字符串应解析为数字数组');
  assert.deepEqual(out.privates, [9]);
});

test('normalizeConfig 无法解析的字符串 groups/privates → 空数组', () => {
  const out = normalizeConfig({ groups: 'abc,xyz' } as never);
  assert.deepEqual(out.groups, [], '无法解析应回退为空数组');
});

test('normalizeConfig 缺省值来自 QQ_DEFAULTS', () => {
  const out = normalizeConfig({} as never);
  assert.equal(out.mode, QQ_DEFAULTS.mode);
  assert.equal(out.wsPort, QQ_DEFAULTS.wsPort);
  assert.equal(out.forwardExpandLimit, QQ_DEFAULTS.forwardExpandLimit);
  assert.equal(out.sendIntervalMs, QQ_DEFAULTS.sendIntervalMs);
});

test('normalizeConfig vision 缺省 model 存在', () => {
  const out = normalizeConfig({} as never);
  assert.equal(typeof out.vision.model, 'string');
  assert.ok(out.vision.maxConcurrent >= 1);
  assert.equal(out.vision.videoEnabled, false);
  assert.equal(out.vision.videoDir, 'videos');
  assert.equal(out.vision.videoFrameIntervalSec, 1);
  assert.equal(out.vision.videoMaxFrames, 12);
  assert.equal(out.vision.videoSegmentSec, 8);
  assert.equal(out.vision.videoMaxSegments, 12);
  assert.equal(out.vision.videoAudioEnabled, true);
});
