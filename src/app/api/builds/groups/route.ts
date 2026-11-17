import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import { ServerTiming } from "@/lib/server-timing";
import {
  isFailedJobState,
  type GroupStatus,
} from "@/lib/test-groups";
import {
  ensureOptionalJobMatcher,
  ensureSoftFailJobMatcher,
  isOptionalJob,
  isSoftFailJob,
} from "@/lib/test-areas";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { getBuildGroupJobs, groupBuildJobs } from "@/lib/build-group-jobs";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;

type GroupSummary = Omit<GroupStatus, "jobs"> & {
  failedJobs: Array<{ name: string; web_url: string }>;
};

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    const buildIds = [
      ...new Set(
        (request.nextUrl.searchParams.get("buildIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 100),
      ),
    ].slice(0, MAX_BUILD_IDS);

    if (buildIds.length === 0) {
      return cachedJson(
        {
          groupsByBuild: {},
          jobNames: [],
          jobsByBuild: {},
          startedJobCountsByBuild: {},
          optionalJobs: [],
          softFailJobs: [],
          jobOptions: [],
        },
        CDN_CACHE,
      );
    }

    const cacheKey = `build-groups:${buildIds.join(",")}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      const cachedResponse = cachedJson(cached, CDN_CACHE);
      cachedResponse.headers.set("Server-Timing", timing.header());
      return cachedResponse;
    }

    const jobs = await timing.measure("jobs", getBuildGroupJobs(buildIds, resolveCiDataSource(request)));
    const grouped = await timing.measure("groups", groupBuildJobs(jobs, buildIds));
    const startedJobCountsByBuild = Object.fromEntries(buildIds.map((id) => [id, 0]));
    for (const job of jobs) {
      if (typeof job.build_id === "string" && job.started_at) startedJobCountsByBuild[job.build_id]++;
    }
    const jobNamesSet = new Set<string>();
    const jobOptions = new Map<string, { name: string; group: string }>();
    for (const { groups } of grouped.values()) {
      for (const group of groups) {
        for (const job of group.jobs) {
          jobNamesSet.add(job.name);
          jobOptions.set(JSON.stringify([job.name, group.group]), { name: job.name, group: group.group });
        }
      }
    }

    // Normalize repeated job names into one dictionary. The compact
    // name-index/state matrix is small enough to ship with group summaries, so
    // expanding a group is immediate. Only the much larger job URLs stay lazy.
    const jobNames = [...jobNamesSet].sort((a, b) => a.localeCompare(b));
    const jobNameIndex = new Map(
      jobNames.map((name, index) => [name, index]),
    );
    const groupsByBuild: Record<string, GroupSummary[]> = {};
    const compactJobsByBuild: Record<
      string,
      Record<string, Array<[number, string] | [number, string, string[]]>>
    > = {};
    for (const buildId of buildIds) {
      const groups = grouped.get(buildId)?.groups ?? [];
      compactJobsByBuild[buildId] = {};
      groupsByBuild[buildId] = groups.map(({ jobs: groupJobs, ...summary }) => {
        // A runtime-sharded step carries its shards' states, by index.
        compactJobsByBuild[buildId][summary.group] = groupJobs.map((job) =>
          job.shards
            ? [
                jobNameIndex.get(job.name)!,
                job.state,
                job.shards.map((shard) => shard.state),
              ]
            : [jobNameIndex.get(job.name)!, job.state],
        );
        const failedJobs = groupJobs
          .filter((job) => isFailedJobState(job.state) && job.web_url)
          .map((job) => ({ name: job.name, web_url: job.web_url! }));
        return { ...summary, failedJobs };
      });
    }

    // Flag jobs from the pipeline YAML's `optional` and `soft_fail` steps, as
    // indexes into jobNames, so the table's hide toggles track the YAML.
    const hasVllm = [...grouped.values()].some(({ mapping }) => mapping.vllmFallbacks !== false);
    const [optionalMatcher, softFailMatcher] = hasVllm ? await Promise.all([
      ensureOptionalJobMatcher(),
      ensureSoftFailJobMatcher(),
    ]) : [null, null];
    const optionalNames = new Set<string>();
    const softFailNames = new Set<string>();
    for (const { mapping, jobs: buildJobs } of grouped.values()) {
      for (const job of buildJobs) {
        if (mapping.vllmFallbacks !== false && optionalMatcher && softFailMatcher) {
          if (isOptionalJob(job.name, optionalMatcher)) optionalNames.add(job.name);
          if (isSoftFailJob(job.name, softFailMatcher)) softFailNames.add(job.name);
        } else {
          const rules = mapping.patterns.filter((rule) => rule.regex.test(job.name) && (!rule.queue || rule.queue === job.queue));
          if (rules.some((rule) => rule.optional)) optionalNames.add(job.name);
          if (rules.some((rule) => rule.softFail)) softFailNames.add(job.name);
        }
      }
    }
    const jobIndexesWhere = (names: Set<string>) =>
      jobNames.flatMap((name, index) => names.has(name) ? [index] : []);

    const result = {
      groupsByBuild,
      jobNames,
      jobsByBuild: compactJobsByBuild,
      startedJobCountsByBuild,
      optionalJobs: jobIndexesWhere(optionalNames),
      softFailJobs: jobIndexesWhere(softFailNames),
      jobOptions: [...jobOptions.values()]
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    setCache(cacheKey, result, TTL);

    const response = cachedJson(result, CDN_CACHE);
    response.headers.set("Server-Timing", timing.header());
    return response;
  } catch (error) {
    console.error("Failed to fetch build group summaries:", error);
    return NextResponse.json(
      { error: "Failed to fetch build group summaries" },
      { status: 500, headers: { "Server-Timing": timing.header() } },
    );
  }
}
