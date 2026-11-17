import { NextRequest, NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";
import type { JobInfo } from "@/lib/test-groups";
import { resolveCiDataSource } from "@/lib/ci-data-source";
import { getBuildGroupJobs, groupBuildJobs } from "@/lib/build-group-jobs";

const TTL = 30_000;
const CDN_CACHE = { maxAge: 60, staleWhileRevalidate: 3_600 };
const MAX_BUILD_IDS = 50;
const MAX_GROUPS = 20;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const buildIds = [
      ...new Set(
        (searchParams.get("buildIds") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 100),
      ),
    ].slice(0, MAX_BUILD_IDS);
    const groups = [
      ...new Set(
        (searchParams.get("groups") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 200),
      ),
    ].slice(0, MAX_GROUPS);

    if (buildIds.length === 0 || groups.length === 0) {
      return cachedJson({ jobsByBuild: {} }, CDN_CACHE);
    }

    const cacheKey = `build-jobs:${buildIds.join(",")}:${groups.join(",")}:${resolveCiDataSource(request)}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const jobs = await getBuildGroupJobs(buildIds, resolveCiDataSource(request));
    const grouped = await groupBuildJobs(jobs, buildIds);
    const groupSet = new Set(groups);
    const jobsByBuild: Record<string, Record<string, JobInfo[]>> = {};
    for (const buildId of buildIds) {
      jobsByBuild[buildId] = Object.fromEntries(
        (grouped.get(buildId)?.groups ?? [])
          .filter((group) => groupSet.has(group.group))
          .map((group) => [group.group, group.jobs]),
      );
    }

    const result = { jobsByBuild };
    setCache(cacheKey, result, TTL);
    return cachedJson(result, CDN_CACHE);
  } catch (error) {
    console.error("Failed to fetch expanded build jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch expanded build jobs" },
      { status: 500 },
    );
  }
}
