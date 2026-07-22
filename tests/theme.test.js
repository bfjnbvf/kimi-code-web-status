const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

test('面板跟随 Kimi Web 页面主题，而不是操作系统主题', () => {
  assert.match(css, /var\(--color-text,/);
  assert.match(css, /var\(--color-surface-raised,/);
  assert.match(css, /var\(--color-line,/);
  assert.doesNotMatch(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
});
