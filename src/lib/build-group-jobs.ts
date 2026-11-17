import { queryClickHouse } from "./clickhouse";
import { getBuildJobRosterRows } from "./buildkite-build-jobs";
import { queryBuildJobsFromOtel } from "./otel-ci";
import { getPipelineGroupMapping, pipelineRepository } from "./repository-test-groups";
import { aggregateJobsByGroup, type JobInfo } from "./test-groups";

/** Shared roster for group summaries and expanded cells, including queue identity. */
export async function getBuildGroupJobs(buildIds: string[], source: string): Promise<Record<string, unknown>[]> {
  if (source === "otel") {
    const jobs = await getBuildJobRosterRows(buildIds);
    return jobs.length ? jobs : queryBuildJobsFromOtel(buildIds);
  }
  const jobs = await queryClickHouse<Record<string, unknown>>(`
    SELECT
      j.id AS job_id,
      j.build_id AS build_id,
      j.name AS name,
      j.state AS state,
      j.web_url AS web_url,
      j.started_at AS started_at,
      b.commit AS commit_sha,
      b.branch AS branch,
      b.pipeline_slug AS pipeline_slug
    FROM buildkite.build_job AS j FINAL
    INNER JOIN (
      SELECT id, commit, branch, pipeline_slug
      FROM buildkite.build FINAL
      WHERE id IN {buildIds:Array(String)} AND NOT _fivetran_deleted
    ) AS b ON j.build_id = b.id
    WHERE j.build_id IN {buildIds:Array(String)}
      AND NOT j._fivetran_deleted
      AND j.type = 'script'
      AND j.name IS NOT NULL
  `, { buildIds });
  // vLLM's historical mappings do not need queues. Only read the rule table
  // for jobs belonging to repositories with queue-dependent group definitions.
  const jobIds = jobs.filter((job) => typeof job.pipeline_slug === "string" && pipelineRepository(job.pipeline_slug))
    .flatMap((job) => typeof job.job_id === "string" ? [job.job_id] : []);
  if (!jobIds.length) return jobs;
  const queues = await queryClickHouse<{ build_job_id: string; queue: string }>(`
    SELECT build_job_id, any(substring(rule, 7)) AS queue
    FROM buildkite.build_job_agent_query_rule FINAL
    WHERE build_job_id IN {jobIds:Array(String)}
      AND NOT _fivetran_deleted AND startsWith(rule, 'queue=')
    GROUP BY build_job_id
  `, { jobIds });
  const byJob = new Map(queues.map((row) => [row.build_job_id, row.queue]));
  return jobs.map((job) => ({ ...job, queue: byJob.get(job.job_id as string) }));
}

export async function groupBuildJobs(rows: Record<string, unknown>[], buildIds: string[]) {
  const jobs = new Map<string, JobInfo[]>();
  const refs = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.build_id !== "string" || typeof row.name !== "string" || typeof row.state !== "string") continue;
    refs.set(row.build_id, row);
    const entries = jobs.get(row.build_id) ?? [];
    entries.push({
      name: row.name, state: row.state,
      web_url: typeof row.web_url === "string" ? row.web_url : undefined,
      ...(typeof row.queue === "string" && row.queue ? { queue: row.queue } : {}),
    });
    jobs.set(row.build_id, entries);
  }
  const mappings = new Map<string, ReturnType<typeof getPipelineGroupMapping>>();
  return new Map(await Promise.all(buildIds.map(async (id) => {
    const row = refs.get(id);
    const pipeline = typeof row?.pipeline_slug === "string" ? row.pipeline_slug : id.split(":")[0];
    const commit = typeof row?.commit_sha === "string" ? row.commit_sha : null;
    const branch = typeof row?.branch === "string" ? row.branch : null;
    const key = JSON.stringify([pipeline, commit, branch]);
    if (!mappings.has(key)) mappings.set(key, getPipelineGroupMapping(pipeline, commit, branch));
    const mapping = await mappings.get(key)!;
    const buildJobs = jobs.get(id) ?? [];
    return [id, { mapping, groups: aggregateJobsByGroup(buildJobs, mapping), jobs: buildJobs }] as const;
  })));
}
