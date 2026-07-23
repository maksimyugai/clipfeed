import { assertEquals } from "@std/assert";
import { createTranslateQueue } from "./translateQueue.ts";

Deno.test("createTranslateQueue: an id not yet in flight can be enqueued when slots are free", () => {
  const q = createTranslateQueue(5);
  assertEquals(q.canEnqueue("a"), true);
});

Deno.test("createTranslateQueue: start() reserves a slot, finish() releases it", () => {
  const q = createTranslateQueue(1);
  q.start("a");
  assertEquals(q.canEnqueue("b"), false);
  q.finish("a");
  assertEquals(q.canEnqueue("b"), true);
});

Deno.test("createTranslateQueue: the same id already in flight cannot be enqueued again, even with free slots elsewhere", () => {
  const q = createTranslateQueue(5);
  q.start("a");
  assertEquals(q.canEnqueue("a"), false);
});

Deno.test("createTranslateQueue: exactly maxConcurrent ids may be in flight at once, the next one is blocked", () => {
  const q = createTranslateQueue(5);
  for (const id of ["a", "b", "c", "d", "e"]) {
    assertEquals(q.canEnqueue(id), true);
    q.start(id);
  }
  assertEquals(q.canEnqueue("f"), false);
});

Deno.test("createTranslateQueue: finishing one of five frees exactly one slot for a new id", () => {
  const q = createTranslateQueue(5);
  for (const id of ["a", "b", "c", "d", "e"]) q.start(id);
  q.finish("c");
  assertEquals(q.canEnqueue("f"), true);
  q.start("f");
  assertEquals(q.canEnqueue("g"), false);
});

Deno.test("createTranslateQueue: finish() on an id that was never started is a harmless no-op", () => {
  const q = createTranslateQueue(1);
  q.finish("ghost");
  assertEquals(q.canEnqueue("a"), true);
});
