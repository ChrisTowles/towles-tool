import { test } from "node:test";
import assert from "node:assert/strict";

import { SLACK, compare } from "./bundle-budget.mjs";

const budget = { js: 100_000, css: 10_000 };

test("compare passes a build at or just under budget", () => {
  assert.deepEqual(compare({ js: 100_000, css: 10_000 }, budget), { over: [], loosen: [] });
  assert.deepEqual(compare({ js: 99_000, css: 9_900 }, budget), { over: [], loosen: [] });
});

test("compare flags each kind that grew past its budget", () => {
  const { over } = compare({ js: 100_001, css: 10_001 }, budget);
  assert.equal(over.length, 2);
  assert.match(over[0], /^js:/);
});

test("compare asks to tighten once a build sits beyond the slack", () => {
  const { over, loosen } = compare({ js: 100_000 * (1 - SLACK) - 1, css: 10_000 }, budget);
  assert.deepEqual(over, []);
  assert.equal(loosen.length, 1);
  assert.match(loosen[0], /^js:/);
});
