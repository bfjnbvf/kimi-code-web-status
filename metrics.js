(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KimiMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPEED_SAMPLE_WINDOW = 5;
  const MIN_SPEED_DURATION_MS = 100;

  function toNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function firstDefined(source, keys) {
    for (const key of keys) {
      if (source?.[key] != null) return source[key];
    }
    return 0;
  }

  function normalizeUsage(raw) {
    const usage = raw && typeof raw === 'object' ? raw : {};
    return {
      inputTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputOther', 'input_tokens', 'prompt_tokens'
      ])),
      outputTokens: toNonNegativeInteger(firstDefined(usage, [
        'output', 'output_tokens', 'completion_tokens'
      ])),
      cacheReadTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputCacheRead', 'cache_read_input_tokens', 'cache_read_tokens'
      ])),
      cacheCreationTokens: toNonNegativeInteger(firstDefined(usage, [
        'inputCacheCreation', 'cache_creation_input_tokens', 'cache_creation_tokens'
      ]))
    };
  }

  function totalInputTokens(usage) {
    return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  }

  function cacheReadPercentage(usage) {
    const total = totalInputTokens(usage);
    return total > 0 ? Math.round((usage.cacheReadTokens / total) * 100) : null;
  }

  function decodeSpeed(outputTokens, durationMs) {
    const output = toNonNegativeInteger(outputTokens);
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration < MIN_SPEED_DURATION_MS || output === 0) return null;
    return Math.round(output / (duration / 1_000));
  }

  function appendSpeedSample(samples, speed) {
    if (!Number.isFinite(speed) || speed <= 0) return [...samples].slice(-SPEED_SAMPLE_WINDOW);
    return [...samples, speed].slice(-SPEED_SAMPLE_WINDOW);
  }

  function medianSpeed(samples) {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  function boosterBalanceYuan(wallet) {
    if (!wallet || typeof wallet !== 'object') return null;
    const status = String(wallet?.status || '').toUpperCase();
    if (status !== 'STATUS_ACTIVE' && status !== 'STATUS_ENABLED') return 0;
    const amountLeft = Number(wallet?.balance?.amountLeft);
    return Number.isFinite(amountLeft) ? Math.max(0, amountLeft / 100_000_000) : null;
  }

  return {
    appendSpeedSample,
    boosterBalanceYuan,
    cacheReadPercentage,
    decodeSpeed,
    medianSpeed,
    normalizeUsage,
    toNonNegativeInteger,
    totalInputTokens
  };
});
