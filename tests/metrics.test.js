const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendSpeedSample,
  boosterBalanceYuan,
  cacheReadPercentage,
  decodeSpeed,
  medianSpeed,
  normalizeUsage,
  totalInputTokens
} = require('../metrics.js');

test('总输入包含未缓存、缓存读取和缓存创建 token', () => {
  const usage = normalizeUsage({
    inputOther: 120,
    output: 30,
    inputCacheRead: 800,
    inputCacheCreation: 80
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 800,
    cacheCreationTokens: 80
  });
  assert.equal(totalInputTokens(usage), 1_000);
  assert.equal(cacheReadPercentage(usage), 80);
});

test('快照和 OpenAI 风格字段使用同一归一化逻辑', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: '10',
    output_tokens: 2,
    cache_read_tokens: 20,
    cache_creation_tokens: 5
  }), {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 20,
    cacheCreationTokens: 5
  });

  assert.deepEqual(normalizeUsage({ prompt_tokens: 9, completion_tokens: 3 }), {
    inputTokens: 9,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
});

test('无效或负数 token 不会污染累计值', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: -1,
    output_tokens: null,
    cache_read_tokens: 'invalid',
    cache_creation_tokens: Infinity
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });
});

test('缓存分母为零时不生成百分比', () => {
  assert.equal(cacheReadPercentage(normalizeUsage({})), null);
});

test('速度忽略计时精度过低的样本，并使用最近五次中位数', () => {
  assert.equal(decodeSpeed(24, 1), null);
  assert.equal(decodeSpeed(57, 12), null);
  assert.equal(decodeSpeed(200, 4_000), 50);

  let samples = [];
  for (const speed of [40, 42, 41, 900, 43, 44]) {
    samples = appendSpeedSample(samples, speed);
  }
  assert.deepEqual(samples, [42, 41, 900, 43, 44]);
  assert.equal(medianSpeed(samples), 43);
});

test('钱包未启用时不展示接口中的伪余额', () => {
  assert.equal(boosterBalanceYuan(null), null);
  assert.equal(boosterBalanceYuan({
    status: 'STATUS_DISABLED',
    balance: { amountLeft: '7500000000' }
  }), 0);
  assert.equal(boosterBalanceYuan({
    status: 'STATUS_ACTIVE',
    balance: { amountLeft: '315250700' }
  }), 3.152507);
});
