'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const css=fs.readFileSync(require.resolve('../public/clipnest.css'),'utf8');
const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');

test('admin panel overrides global #app dark-theme typography with readable colors',()=>{
  assert.match(css,/#app\.admin-shell \.console-heading h1\s*\{\s*color:#172d20/);
  assert.match(css,/#app\.admin-shell \.console-muted[^\{]*\{[^}]*color:#43564a/);
});

test('admin task bar uses a green background and assets are cache-busted',()=>{
  assert.match(css,/#app\.admin-shell>\.console-tabs\.admin-tabs\s*\{[^}]*background:#17683f/);
  assert.match(html,/clipnest\.css\?v=admin-green-contrast-3/);
  assert.match(html,/console\.js\?v=admin-live-duties-2/);
});
