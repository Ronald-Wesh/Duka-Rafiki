/**
 * Minimal assertion helpers shared by the P2 check harnesses.
 *
 * Deliberately dependency-free: `package.json` has no test runner, and adding one
 * is a shared-surface decision. When the team adds `vitest` or wires up
 * `node:test`, every call site below maps onto it mechanically.
 */

export interface CheckRun {
  eq(label: string, actual: unknown, expected: unknown): void;
  /** Assert a call throws, optionally that the message matches. */
  throws(label: string, fn: () => unknown, messageMatch?: RegExp): void;
  /** Assert a call does NOT throw, and return what it produced. */
  survives<T>(label: string, fn: () => T): T | undefined;
  section(title: string): void;
  /** Prints the tally and sets a non-zero exit code on failure. */
  finish(): void;
  readonly failures: readonly string[];
}

export function createCheckRun(): CheckRun {
  let checks = 0;
  const failures: string[] = [];

  function pass(label: string): void {
    console.log(`  ok   ${label}`);
  }

  function fail(label: string, detail: string): void {
    console.log(`  FAIL ${label}\n         ${detail}`);
    failures.push(label);
  }

  return {
    failures,

    section(title) {
      console.log(`\n${title}`);
    },

    eq(label, actual, expected) {
      checks += 1;
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a === e) pass(label);
      else fail(label, `expected ${e}\n         actual   ${a}`);
    },

    throws(label, fn, messageMatch) {
      checks += 1;
      try {
        const value = fn();
        fail(label, `expected a throw, got ${JSON.stringify(value)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (messageMatch && !messageMatch.test(message)) {
          fail(label, `threw, but message did not match ${messageMatch}\n         got: ${message}`);
        } else {
          pass(label);
        }
      }
    },

    survives(label, fn) {
      checks += 1;
      try {
        const value = fn();
        pass(label);
        return value;
      } catch (err) {
        fail(label, `threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },

    finish() {
      console.log(`\n${checks - failures.length}/${checks} checks passed`);
      if (failures.length > 0) {
        console.error(`\nFAILED (${failures.length}):`);
        for (const f of failures) console.error(`  - ${f}`);
        process.exitCode = 1;
      }
    },
  };
}
