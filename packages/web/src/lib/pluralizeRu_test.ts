import { assertEquals } from "@std/assert";
import { pluralizeRu } from "./pluralizeRu.ts";

const forms: [string, string, string] = ["выжимка", "выжимки", "выжимок"];

const cases: [number, string][] = [
  [1, "выжимка"],
  [2, "выжимки"],
  [5, "выжимок"],
  [11, "выжимок"],
  [21, "выжимка"],
  [22, "выжимки"],
  [25, "выжимок"],
  [101, "выжимка"],
  [111, "выжимок"],
];

for (const [n, expected] of cases) {
  Deno.test(`pluralizeRu(${n}, ...) -> "${expected}"`, () => {
    assertEquals(pluralizeRu(n, forms), expected);
  });
}
