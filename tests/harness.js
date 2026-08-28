/**
 * A very small test harness, so the suite runs both in Node and in a browser
 * without pulling in a dependency.
 */

export function createHarness() {
  const results = [];
  let currentGroup = 'general';

  function group(name, body) {
    const previous = currentGroup;
    currentGroup = name;
    body();
    currentGroup = previous;
  }

  function test(name, body) {
    const entry = { group: currentGroup, name, passed: true, message: '' };
    try {
      body();
    } catch (error) {
      entry.passed = false;
      entry.message = error && error.message ? error.message : String(error);
    }
    results.push(entry);
  }

  function fail(message) { throw new Error(message); }

  const assert = {
    ok(value, message = 'expected a truthy value') {
      if (!value) fail(message);
    },
    equal(actual, expected, message) {
      if (actual !== expected) {
        fail(message ?? `expected ${expected}, got ${actual}`);
      }
    },
    /** Relative comparison, which is what physics quantities need. */
    close(actual, expected, tolerance = 1e-6, message) {
      const scale = Math.max(1e-30, Math.abs(expected));
      const error = Math.abs(actual - expected) / scale;
      if (!(error <= tolerance)) {
        fail(message ?? `expected ${expected} +/- ${tolerance * 100}%, got ${actual} (off by ${(error * 100).toPrecision(3)}%)`);
      }
    },
    between(actual, low, high, message) {
      if (!(actual >= low && actual <= high)) {
        fail(message ?? `expected ${actual} to lie within [${low}, ${high}]`);
      }
    },
    greater(actual, threshold, message) {
      if (!(actual > threshold)) fail(message ?? `expected ${actual} > ${threshold}`);
    },
    less(actual, threshold, message) {
      if (!(actual < threshold)) fail(message ?? `expected ${actual} < ${threshold}`);
    },
    /** Every element of the sequence must be strictly smaller than the last. */
    decreasing(values, message) {
      for (let i = 1; i < values.length; i++) {
        if (!(values[i] < values[i - 1])) {
          fail(message ?? `expected a decreasing sequence, but index ${i} (${values[i]}) >= index ${i - 1} (${values[i - 1]})`);
        }
      }
    },
    finite(value, message) {
      if (!Number.isFinite(value)) fail(message ?? `expected a finite number, got ${value}`);
    },
  };

  function summary() {
    const passed = results.filter((r) => r.passed).length;
    return { results, passed, failed: results.length - passed, total: results.length };
  }

  return { group, test, assert, summary };
}
