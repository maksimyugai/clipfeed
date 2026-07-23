import { assertEquals } from "@std/assert";
import { createTranslateQueue } from "./translateQueue.ts";

// A controllable "in-flight" promise: the caller decides exactly when it
// resolves, so tests can assert on queue state at each step (started vs.
// still pending) without any real async waiting/timers.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

Deno.test("request: starts immediately when a slot is free", () => {
  const q = createTranslateQueue(3);
  const { promise } = deferred();
  q.request("a", () => promise);
  assertEquals(q.isInFlight("a"), true);
  assertEquals(q.isQueued("a"), false);
});

Deno.test("request: a 4th request beyond the cap of 3 is queued, not started", () => {
  const q = createTranslateQueue(3);
  const runs: string[] = [];
  const pending = ["a", "b", "c"].map(() => deferred());
  q.request("a", () => pending[0].promise);
  q.request("b", () => pending[1].promise);
  q.request("c", () => pending[2].promise);
  q.request("d", () => {
    runs.push("d");
    return Promise.resolve();
  });

  assertEquals(q.isInFlight("a"), true);
  assertEquals(q.isInFlight("b"), true);
  assertEquals(q.isInFlight("c"), true);
  assertEquals(q.isQueued("d"), true);
  assertEquals(q.isInFlight("d"), false);
  assertEquals(runs, []); // d's run() must not have been called yet
});

Deno.test("request: FIFO order — queued ids drain in the order they were requested", async () => {
  const q = createTranslateQueue(1);
  const started: string[] = [];
  const first = deferred();
  q.request("a", () => {
    started.push("a");
    return first.promise;
  });
  q.request("b", () => {
    started.push("b");
    return Promise.resolve();
  });
  q.request("c", () => {
    started.push("c");
    return Promise.resolve();
  });

  assertEquals(started, ["a"]);
  first.resolve();
  await first.promise;
  // Allow the .finally() microtask (pump()) to run.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(started, ["a", "b", "c"]);
});

Deno.test("request: finishing one in-flight item drains exactly one queued item (drain)", async () => {
  const q = createTranslateQueue(2);
  const started: string[] = [];
  const a = deferred();
  const b = deferred();
  const c = deferred(); // controlled so its own completion can't cascade a second drain
  q.request("a", () => {
    started.push("a");
    return a.promise;
  });
  q.request("b", () => {
    started.push("b");
    return b.promise;
  });
  q.request("c", () => {
    started.push("c");
    return c.promise;
  });
  q.request("d", () => {
    started.push("d");
    return Promise.resolve();
  });

  assertEquals(started, ["a", "b"]);
  assertEquals(q.isQueued("c"), true);
  assertEquals(q.isQueued("d"), true);

  a.resolve();
  await a.promise;
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(started, ["a", "b", "c"]); // exactly one queued item drained
  assertEquals(q.isQueued("c"), false);
  assertEquals(q.isInFlight("c"), true);
  assertEquals(q.isQueued("d"), true); // still waiting — only one slot freed
  assertEquals(q.isInFlight("a"), false);
});

Deno.test("request: dedupes an id already queued — a second request() call before the first settles is a no-op", () => {
  const q = createTranslateQueue(1);
  const runs: string[] = [];
  const first = deferred();
  q.request("a", () => {
    runs.push("a-1");
    return first.promise;
  });
  q.request("b", () => Promise.resolve()); // queued behind "a"
  q.request("b", () => {
    runs.push("b-2"); // must never run — "b" was already queued
    return Promise.resolve();
  });

  assertEquals(q.isQueued("b"), true);
  // Only one entry for "b" — cancelQueued() must clear it in a single call.
  q.cancelQueued();
  assertEquals(q.isQueued("b"), false);
});

Deno.test("request: dedupes an id already in flight — a second request() call is a no-op", () => {
  const q = createTranslateQueue(3);
  const runs: string[] = [];
  const { promise } = deferred();
  q.request("a", () => {
    runs.push("a-1");
    return promise;
  });
  q.request("a", () => {
    runs.push("a-2");
    return Promise.resolve();
  });
  assertEquals(runs, ["a-1"]);
  assertEquals(q.isInFlight("a"), true);
});

Deno.test("cancelQueued: drops every queued id but leaves in-flight ids running", () => {
  const q = createTranslateQueue(1);
  const runs: string[] = [];
  const { promise } = deferred();
  q.request("a", () => {
    runs.push("a");
    return promise;
  });
  q.request("b", () => {
    runs.push("b");
    return Promise.resolve();
  });
  q.request("c", () => {
    runs.push("c");
    return Promise.resolve();
  });

  q.cancelQueued();

  assertEquals(q.isInFlight("a"), true); // untouched
  assertEquals(q.isQueued("b"), false);
  assertEquals(q.isQueued("c"), false);
  assertEquals(runs, ["a"]); // b/c never ran
});

Deno.test("cancelQueued: a later request for a previously-cancelled id is treated as brand new", () => {
  const q = createTranslateQueue(1);
  const runs: string[] = [];
  const { promise } = deferred();
  q.request("a", () => {
    runs.push("a");
    return promise;
  });
  q.request("b", () => {
    runs.push("b");
    return Promise.resolve();
  });
  q.cancelQueued();
  assertEquals(q.isQueued("b"), false);

  q.request("b", () => {
    runs.push("b-again");
    return Promise.resolve();
  });
  assertEquals(q.isQueued("b"), true);
});

Deno.test("cancel: drops a single still-queued id without touching others or any in-flight id", () => {
  const q = createTranslateQueue(1);
  const runs: string[] = [];
  const { promise } = deferred();
  q.request("a", () => {
    runs.push("a");
    return promise;
  });
  q.request("b", () => {
    runs.push("b");
    return Promise.resolve();
  });
  q.request("c", () => {
    runs.push("c");
    return Promise.resolve();
  });

  q.cancel("b");

  assertEquals(q.isInFlight("a"), true);
  assertEquals(q.isQueued("b"), false);
  assertEquals(q.isQueued("c"), true);
});

Deno.test("cancel: a no-op when the id is already in flight — in-flight requests are never dropped", () => {
  const q = createTranslateQueue(1);
  const { promise } = deferred();
  q.request("a", () => promise);
  q.cancel("a");
  assertEquals(q.isInFlight("a"), true);
});

Deno.test("cancel: a no-op when the id isn't listed at all", () => {
  const q = createTranslateQueue(1);
  q.cancel("ghost"); // must not throw
  assertEquals(q.isPending("ghost"), false);
});

// --- expanded-card priority ---

Deno.test("priority: a priority request queues ahead of already-queued non-priority requests", async () => {
  const q = createTranslateQueue(1);
  const started: string[] = [];
  const a = deferred();
  q.request("a", () => {
    started.push("a");
    return a.promise;
  });
  q.request("b", () => {
    started.push("b");
    return Promise.resolve();
  }); // queued (normal)
  q.request("c", () => {
    started.push("c");
    return Promise.resolve();
  }, { priority: true }); // queued, but jumps ahead of "b"

  a.resolve();
  await a.promise;
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(started, ["a", "c", "b"]);
});

Deno.test("priority: an already-queued (non-priority) id promoted to priority is drained ahead of the rest", async () => {
  const q = createTranslateQueue(1);
  const started: string[] = [];
  const a = deferred();
  q.request("a", () => {
    started.push("a");
    return a.promise;
  });
  q.request("b", () => {
    started.push("b");
    return Promise.resolve();
  });
  q.request("c", () => {
    started.push("c");
    return Promise.resolve();
  });
  // "c" gets expanded by the reader before its turn — promote it.
  q.request("c", () => {
    started.push("c-promoted");
    return Promise.resolve();
  }, { priority: true });

  a.resolve();
  await a.promise;
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(started, ["a", "c", "b"]);
});

Deno.test("priority: multiple priority requests still drain in their own FIFO order", async () => {
  const q = createTranslateQueue(1);
  const started: string[] = [];
  const a = deferred();
  q.request("a", () => {
    started.push("a");
    return a.promise;
  });
  q.request("b", () => {
    started.push("b");
    return Promise.resolve();
  }, { priority: true });
  q.request("c", () => {
    started.push("c");
    return Promise.resolve();
  }, { priority: true });

  a.resolve();
  await a.promise;
  await Promise.resolve();
  await Promise.resolve();

  assertEquals(started, ["a", "b", "c"]);
});

Deno.test("priority: cannot preempt an already in-flight request — priority only affects queue order", () => {
  const q = createTranslateQueue(1);
  const runs: string[] = [];
  const { promise } = deferred();
  q.request("a", () => {
    runs.push("a");
    return promise;
  });
  q.request("b", () => {
    runs.push("b");
    return Promise.resolve();
  }, { priority: true });

  assertEquals(q.isInFlight("a"), true);
  assertEquals(q.isQueued("b"), true);
  assertEquals(runs, ["a"]);
});

// --- isPending (what the skeleton keys off of) ---

Deno.test("isPending: true while queued, true while in flight, false once neither", () => {
  const q = createTranslateQueue(1);
  const a = deferred();
  const b = deferred();
  q.request("a", () => a.promise);
  q.request("b", () => b.promise); // queued behind "a"

  assertEquals(q.isPending("a"), true); // in flight
  assertEquals(q.isPending("b"), true); // queued

  q.cancelQueued();
  assertEquals(q.isPending("b"), false); // dropped, no longer pending

  assertEquals(q.isPending("never-requested"), false);
});

Deno.test("isPending: false again once an in-flight request settles", async () => {
  const q = createTranslateQueue(1);
  const { promise, resolve } = deferred();
  q.request("a", () => promise);
  assertEquals(q.isPending("a"), true);

  resolve();
  await promise;
  await Promise.resolve();

  assertEquals(q.isPending("a"), false);
});
