'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('player icon helpers are declared before their first use in the watch player', () => {
  const helperDeclaration = html.indexOf('const playerIconButton=');
  const firstHelperCall = html.indexOf('playerIconButton(');

  assert.notEqual(helperDeclaration, -1, 'playerIconButton helper should exist');
  assert.notEqual(firstHelperCall, -1, 'playerIconButton should be used');
  assert.ok(
    helperDeclaration < firstHelperCall,
    'playerIconButton must be initialized before player controls call it'
  );
});
