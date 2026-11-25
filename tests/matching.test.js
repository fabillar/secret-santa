// Unit tests for the matching engine. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAssignments, validateAssignments, feasibilityProblem } from '../api/_lib/matching.js';

const people = (spec) =>
  spec.flatMap(([hh, n]) => Array.from({ length: n }, (_, i) => ({ id: `${hh}${i}`, householdId: hh })));

test('valid assignments across many random runs', () => {
  const ps = people([['a', 3], ['b', 2], ['c', 2], ['d', 1]]);
  for (let i = 0; i < 2000; i++) {
    const a = generateAssignments(ps);
    assert.ok(validateAssignments(ps, a));
  }
});

test('tight case: one household is exactly half the pool', () => {
  const ps = people([['a', 4], ['b', 1], ['c', 1], ['d', 2]]);
  for (let i = 0; i < 500; i++) validateAssignments(ps, generateAssignments(ps));
});

test('two households of equal size', () => {
  const ps = people([['a', 5], ['b', 5]]);
  for (let i = 0; i < 200; i++) validateAssignments(ps, generateAssignments(ps));
});

test('infeasible configurations are explained', () => {
  assert.match(feasibilityProblem([]), /no participants/);
  assert.match(feasibilityProblem(people([['a', 1]])), /At least 2/);
  assert.match(feasibilityProblem(people([['a', 3]])), /same household/);
  assert.match(feasibilityProblem(people([['a', 3], ['b', 1]]), { a: 'Smith' }), /Smith/);
  assert.throws(() => generateAssignments(people([['a', 3], ['b', 1]])));
});

test('distribution is not degenerate', () => {
  const ps = people([['a', 1], ['b', 1], ['c', 1], ['d', 1]]);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(JSON.stringify(generateAssignments(ps)));
  assert.equal(seen.size, 9); // number of derangements of 4
});
