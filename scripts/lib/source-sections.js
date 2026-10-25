'use strict';

const assert = require('assert');
const parser = require('@babel/parser');
const cache = new Map();

function nodes(source) {
  if (cache.has(source)) return cache.get(source);
  const tree = parser.parse(source, { sourceType: 'script', allowAwaitOutsideFunction: true });
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  cache.set(source, result);
  return result;
}

function section(source, predicate, label) {
  const matches = nodes(source).filter(predicate);
  assert.strictEqual(matches.length, 1, `Expected one source section: ${label}`);
  return source.slice(matches[0].start, matches[0].end);
}

function functionSource(source, name) {
  return section(source, n => n.type === 'FunctionDeclaration' && n.id.name === name, name);
}

function routeSource(source, method, path) {
  return section(source, n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' &&
    n.expression.callee.type === 'MemberExpression' && n.expression.callee.object.name === 'router' &&
    n.expression.callee.property.name === method && n.expression.arguments[0]?.value === path, `${method} ${path}`);
}

function conditionalSource(source, test) {
  return section(source, n => n.type === 'IfStatement' && source.slice(n.test.start, n.test.end) === test, test);
}

module.exports = { functionSource, routeSource, conditionalSource };
