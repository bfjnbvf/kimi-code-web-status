const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

test('保留原版色板，并由 Kimi Web 的主题设置选择亮暗模式', () => {
  assert.match(css, /--ksb-green:\s*#16c456/);
  assert.match(css, /--ksb-orange:\s*#ff9500/);
  assert.match(css, /--ksb-danger:\s*#ff3849/);
  assert.match(css, /html\[data-color-scheme="dark"\]\s+#ksb-widget/);
  assert.match(css, /html\[data-color-scheme="system"\]\s+#ksb-widget/);
  assert.doesNotMatch(css, /var\(--color-(?:text|success|warning|danger|selected|hover|surface-raised|line)/);
});
