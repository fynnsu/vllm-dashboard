import assert from "node:assert/strict";
import test from "node:test";
import { addRepositoryGroups, getPipelineGroupMapping, pipelineRepository } from "./repository-test-groups";
import { aggregateJobsByGroup, getTestGroup, resolveGroupsToJobConditions } from "./test-groups";

const LABEL = ":python: Unit Tests py{{matrix.python}} / transformers {{matrix.transformers}}";
const JOB = ":python: Unit Tests py3.13 / transformers latest";

function pipeline(group: string, queue: string) {
  return `steps:
  - group: '${group}'
    steps:
      - label: '${LABEL}'
        agents:
          queue: ${queue}
        matrix:
          setup:
            python: ['3.11', '3.13']
            transformers: [latest]
`;
}

test("Speculators matrix jobs keep the H100, L4 and nightly A100 groups distinct", () => {
  const mapping = addRepositoryGroups(pipeline("Unit Tests (H100)", "RedHat-H100-WDC"));
  addRepositoryGroups(pipeline("Unit Tests (L4)", "RedHat-L4-GCP"), mapping);
  addRepositoryGroups(pipeline("Nightly Unit Tests (A100)", "RedHat-A100-WDC"), mapping);
  for (const [queue, group] of [
    ["RedHat-H100-WDC", "Unit Tests (H100)"],
    ["RedHat-L4-GCP", "Unit Tests (L4)"],
    ["RedHat-A100-WDC", "Nightly Unit Tests (A100)"],
  ]) {
    const [result] = aggregateJobsByGroup([{ name: JOB, state: "passed", queue }], mapping);
    assert.equal(result.group, group);
    assert.equal(result.passed, 1);
  }
  assert.equal(getTestGroup(JOB, mapping), null, "missing queues must not guess between identical labels");
  assert.equal(getTestGroup(JOB, mapping, "other"), null);
  assert.equal(getTestGroup(JOB.replace("3.13", "3.12"), mapping, "RedHat-H100-WDC"), null);
  assert.equal(getTestGroup(JOB.replace("3.13", "3x13"), mapping, "RedHat-H100-WDC"), null);
  assert.equal(getTestGroup(":amd: Some unrelated job", mapping), null, "vLLM heuristics must not leak into other repos");
});

test("nested and root groups inherit queues and handle list matrices and parallel labels", () => {
  const mapping = addRepositoryGroups(`agents: { queue: shared }
steps:
  - group: Outer
    steps:
      - group: Inner
        steps:
          - label: 'Smoke {{matrix}} %N/%t'
            matrix: ['3.11', '3.13']
            soft_fail: [{ exit_status: 1 }]
            optional: true
  - label: Bootstrap
`);
  assert.equal(getTestGroup("Smoke 3.11 2/4", mapping, "shared"), "Inner");
  assert.equal(getTestGroup("Bootstrap", mapping, "shared"), null);
  assert.equal(mapping.patterns[0].optional, true);
  assert.equal(mapping.patterns[0].softFail, true);
  const conditions = resolveGroupsToJobConditions(["Inner"], mapping);
  assert.deepEqual(conditions.exactNames, []);
  assert.deepEqual(conditions.regexPatterns, []);
  assert.equal(conditions.queuePatterns[0].queue, "shared");
  assert.ok(new RegExp(conditions.queuePatterns[0].pattern).test("Smoke 3.11 2/4"));
});

test("repository mappings use each build's commit, deduplicate concurrent loads, and cache results", async (t) => {
  const calls: string[] = [];
  const commit = "a".repeat(40);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/git/trees/")) {
      return Response.json({ tree: [
        { type: "blob", path: ".buildkite/development/tests.yml" },
        { type: "blob", path: ".buildkite/nightly/tests.yml" },
        { type: "blob", path: "docs/example.yml" },
      ] });
    }
    assert.ok(url.includes(`/${commit}/`));
    return new Response(pipeline(url.includes("nightly") ? "Nightly" : "Development", url.includes("nightly") ? "a100" : "h100"));
  });
  const [first, second] = await Promise.all([
    getPipelineGroupMapping("speculators", commit, "main"),
    getPipelineGroupMapping("speculators", commit, "main"),
  ]);
  assert.equal(first, second);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes(`/git/trees/${commit}?`));
  assert.equal(getTestGroup(JOB, first, "h100"), "Development");
  assert.equal(await getPipelineGroupMapping("speculators", commit, "branch"), first);
  assert.equal(calls.length, 3);
});

test("missing commit config falls back to the same repository's main and never vLLM", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    assert.ok(url.includes("vllm-project/speculators"));
    if (!url.includes("/main")) return new Response("missing", { status: 404 });
    if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: ".buildkite/tests.yml" }] });
    return new Response(pipeline("Fallback", "h100"));
  });
  const mapping = await getPipelineGroupMapping("speculators", "b".repeat(40), "feature");
  assert.equal(getTestGroup(JOB, mapping, "h100"), "Fallback");
  assert.equal(getTestGroup("Basic Correctness", mapping), null);
  assert.equal(calls.length, 3);
  assert.equal(pipelineRepository("Speculators"), "vllm-project/speculators");
  assert.equal(pipelineRepository("constructor"), null);
});

test("a truncated tree does not produce partial or cross-repository groups", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: true, tree: [] }));
  const mapping = await getPipelineGroupMapping("speculators", "c".repeat(40), "feature");
  // The previous test's healthy main mapping remains a valid fallback.
  assert.equal(mapping.vllmFallbacks, false);
  assert.equal(getTestGroup("Basic Correctness", mapping), null);
});
