import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { GET as groups } from "./route";
import { GET as expanded } from "../jobs/route";
import { GET as builds } from "../route";
import { GET as summary } from "../summary/route";

const JOB = ":python: Unit Tests py3.11 / transformers latest";
const COMMIT = "d".repeat(40);
const FIXTURES = [
  ["development/h100.yml", "Unit Tests (H100)", "RedHat-H100-WDC"],
  ["development/l4.yml", "Unit Tests (L4)", "RedHat-L4-GCP"],
  ["nightly/tests.yml", "Nightly Unit Tests (A100)", "RedHat-A100-WDC"],
];

function mockBackend(t: TestContext, source: string) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    CLICKHOUSE_URL: "https://groups-ch.example", CLICKHOUSE_READ_USER: "reader",
    CLICKHOUSE_READ_PASSWORD: "test", BUILDKITE_API_TOKEN: "test", CI_DATA_SOURCE: source,
  });
  t.after(() => {
    for (const key of ["CLICKHOUSE_URL", "CLICKHOUSE_READ_USER", "CLICKHOUSE_READ_PASSWORD", "BUILDKITE_API_TOKEN", "CI_DATA_SOURCE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  t.mock.method(console, "error", () => {});
  const queries: { sql: string; params: URLSearchParams }[] = [];
  const rows = FIXTURES.map(([, , queue], index) => ({
    job_id: `job-${index}`,
    build_id: source === "otel" ? `speculators:${index + 801}` : `spec-build-${index}`,
    name: JOB, state: index === 0 ? "failed" : "passed", queue,
    web_url: `https://buildkite.com/vllm/speculators/builds/${index + 801}#job`,
    commit_sha: COMMIT, branch: "main", pipeline_slug: "speculators", started_at: "2026-11-17T00:00:00Z",
  }));
  const vllm = { ...rows[0], job_id: "vllm-job", build_id: source === "otel" ? "ci:804" : "vllm-build", name: "Basic Correctness", pipeline_slug: "ci" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.github.com" && url.pathname.includes("/speculators/git/trees/")) {
      return Response.json({ tree: FIXTURES.map(([path]) => ({ type: "blob", path: `.buildkite/${path}` })) });
    }
    if (url.host === "raw.githubusercontent.com" && url.pathname.includes("/speculators/")) {
      const [, group, queue] = FIXTURES.find(([path]) => url.pathname.endsWith(path))!;
      return new Response(`steps:
  - group: '${group}'
    steps:
      - label: ':python: Unit Tests py{{matrix.python}} / transformers {{matrix.transformers}}'
        agents: { queue: ${queue} }
        matrix:
          setup: { python: ['3.11', '3.13'], transformers: [latest] }
`);
    }
    if (url.host === "api.buildkite.com") {
      const number = url.pathname.split("/").at(-1)!;
      const row = [...rows, vllm].find((row) => row.build_id.endsWith(`:${number}`))!;
      return Response.json({ commit: row.commit_sha, branch: "main", state: "running", jobs: [{
        type: "script", name: row.name, state: row.state, web_url: row.web_url,
        started_at: row.started_at, agent_query_rules: [`queue=${row.queue}`],
      }] });
    }
    if (url.host === "groups-ch.example") {
      const sql = String(init?.body);
      queries.push({ sql, params: url.searchParams });
      const result = sql.includes("GROUP BY build_job_id") ? rows.map((row) => ({ build_job_id: row.job_id, queue: row.queue }))
        : sql.includes("AS total") ? [{ total: "0", passed: "0", failed: "0" }]
        : sql.includes(" AS build_id") ? [...rows, vllm, { ...rows[0], name: "Basic Correctness" }].map((row) => ({ ...row, queue: source === "otel" ? row.queue : undefined }))
        : [];
      return new Response(result.map((row) => JSON.stringify(row)).join("\n"));
    }
    return new Response("not found", { status: 404 });
  });
  return { rows, vllm, queries };
}

test("OTel span fallback retains the queue and pipeline needed for repository groups", async (t) => {
  const { rows, queries } = mockBackend(t, "otel");
  delete process.env.BUILDKITE_API_TOKEN;
  // A distinct build-id list bypasses the successful roster response's route cache.
  const buildIds = rows.map((row) => row.build_id).join(",");
  const response = await groups(new NextRequest(`http://localhost/api/builds/groups?${new URLSearchParams({ buildIds })}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.groupsByBuild[rows[0].build_id][0].group, "Unit Tests (H100)");
  assert.equal(body.groupsByBuild[rows[1].build_id][0].group, "Unit Tests (L4)");
  assert.match(queries[0].sql, /j\.agent_queue AS queue/);
  assert.match(queries[0].sql, /j\.pipeline_slug AS pipeline_slug/);
});

for (const source of ["clickhouse", "otel"]) {
  test(`${source}: Speculators and vLLM summaries and expanded groups use the same repository mapping`, async (t) => {
    const { rows, vllm, queries } = mockBackend(t, source);
    const buildIds = [...rows, vllm].map((row) => row.build_id).join(",");
    const response = await groups(new NextRequest(`http://localhost/api/builds/groups?${new URLSearchParams({ buildIds })}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(body.groupsByBuild[row.build_id].map((group: { group: string }) => group.group), [FIXTURES[index][1]]);
      assert.equal(body.startedJobCountsByBuild[row.build_id], source === "otel" ? 1 : index === 0 ? 2 : 1);
    }
    assert.equal(body.groupsByBuild[vllm.build_id][0].group, "Basic Correctness");
    assert.equal(body.jobOptions.filter((option: { name: string }) => option.name === JOB).length, 3,
      "identical labels in different GPU groups must all remain selectable");
    const group = FIXTURES[0][1];
    const detail = await expanded(new NextRequest(`http://localhost/api/builds/jobs?${new URLSearchParams({ buildIds, groups: group })}`));
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.jobsByBuild[rows[0].build_id][group][0].name, JOB);
    assert.equal(detailBody.jobsByBuild[rows[0].build_id][group][0].web_url, rows[0].web_url);
    assert.deepEqual(detailBody.jobsByBuild[rows[1].build_id], {});
    assert.deepEqual(detailBody.jobsByBuild[rows[2].build_id], {});
    if (source === "clickhouse") {
      assert.match(queries[0].sql, /b\.pipeline_slug/);
      assert.match(queries[1].sql, /build_job_agent_query_rule/);
      assert.ok(!queries[1].params.get("param_jobIds")?.includes("vllm-job"), "only other repositories need queue lookup");
    } else {
      assert.equal(queries.length, 0, "a complete REST roster needs no span fallback");
    }
  });

  test(`${source}: build and summary group filters bind matrix patterns and the group's queue`, async (t) => {
    const { queries } = mockBackend(t, source);
    const params = new URLSearchParams({ pipeline: "speculators", jobGroups: "Unit Tests (L4)", source });
    const response = await builds(new NextRequest(`http://localhost/api/builds?${params}`));
    assert.equal(response.status, 200);
    const summaryResponse = await summary(new NextRequest(`http://localhost/api/builds/summary?${params}`));
    assert.equal(summaryResponse.status, 200);
    assert.ok(queries.length >= 5);
    for (const { sql, params } of queries) {
      const values = [...params.values()];
      assert.ok(values.includes(source === "otel" ? "RedHat-L4-GCP" : "queue=RedHat-L4-GCP"));
      assert.ok(values.some((value) => value.includes("3\\.11") && value.includes("3\\.13")));
      assert.ok(!sql.includes("RedHat-L4-GCP"), "queue values must be bound");
      assert.ok(!sql.includes("AND 0"), "valid repository groups must resolve to conditions");
    }
  });
}
