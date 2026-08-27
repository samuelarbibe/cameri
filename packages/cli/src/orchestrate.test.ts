import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseShard, parseSpecList, specFilter } from "./orchestrate.ts";

describe("parseShard", () => {
  it("reads index and total", () => {
    assert.deepEqual(parseShard("3/8"), { index: 3, total: 8 });
    assert.deepEqual(parseShard(" 1 / 2 "), { index: 1, total: 2 });
  });

  it("refuses anything that is not a shard", () => {
    for (const value of ["", "3", "3/", "/8", "a/b", "0/8", "9/8", "-1/8", "1/0"]) {
      assert.equal(parseShard(value), undefined, value);
    }
  });
});

describe("parseSpecList", () => {
  it("reads spec files out of Playwright's JSON report", () => {
    const report = JSON.stringify({
      suites: [
        {
          title: "chromium",
          suites: [{ file: "tests/b.spec.ts" }, { file: "tests/a.spec.ts" }],
        },
      ],
    });

    assert.deepEqual(parseSpecList(report), ["tests/a.spec.ts", "tests/b.spec.ts"]);
  });

  it("reads a plain list, since anything but Playwright would produce one", () => {
    assert.deepEqual(parseSpecList("tests/b.spec.ts\ntests/a.spec.ts\n"), [
      "tests/a.spec.ts",
      "tests/b.spec.ts",
    ]);
  });

  it("de-duplicates, because one file listed per project is still one file", () => {
    assert.deepEqual(parseSpecList("a.spec.ts\na.spec.ts\n"), ["a.spec.ts"]);
  });

  it("is empty for empty or unparseable input, rather than throwing", () => {
    assert.deepEqual(parseSpecList(""), []);
    assert.deepEqual(parseSpecList("   \n  "), []);
    assert.deepEqual(parseSpecList("{not json"), []);
  });
});

describe("specFilter", () => {
  it("anchors at the end so a spec cannot select its own snapshot file", () => {
    const filter = specFilter("tests/a.spec.ts");
    assert.match("tests/a.spec.ts", new RegExp(filter));
    assert.doesNotMatch("tests/a.spec.ts.snap", new RegExp(filter));
  });

  it("escapes regex metacharacters in the path", () => {
    const filter = specFilter("tests/app(v2)/a+b.spec.ts");
    assert.match("tests/app(v2)/a+b.spec.ts", new RegExp(filter));
    // Unescaped, the `.` would match any character here.
    assert.doesNotMatch("tests/app(v2)/a+bXspec.ts", new RegExp(filter));
  });
});
