import { githubHeaders, githubRawUrl } from "./github";
import {
  ensureTestAreaMapping,
  getTestAreaMappingForCommit,
  parseBuildkiteYaml,
  type TestAreaMapping,
} from "./test-areas";

// Pipelines outside vLLM declare their repository here. Group names and job
// labels are discovered from that repository, never duplicated in the dashboard.
const PIPELINE_REPOSITORIES = new Map([
  ["speculators", "vllm-project/speculators"],
]);
const TTL = 60 * 60 * 1000;
const RETRY_TTL = 5 * 60 * 1000;
const CACHE_LIMIT = 100;
const cache = new Map<string, { mapping: TestAreaMapping | null; expires: number }>();
const inFlight = new Map<string, Promise<TestAreaMapping | null>>();

function emptyMapping(): TestAreaMapping {
  return { jobToGroup: new Map(), patterns: [], groups: [], vllmFallbacks: false };
}

export function pipelineRepository(pipeline?: string | null): string | null {
  return PIPELINE_REPOSITORIES.get(pipeline?.toLowerCase().replace(/\s+/g, "-") ?? "") ?? null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function labelRegex(label: string, matrix: unknown): RegExp {
  const setup = object(matrix).setup;
  const pattern = label.split(/(\{\{matrix(?:\.[\w-]+)?\}\}|%[Nnt])/g).map((part) => {
    if (/^%[Nnt]$/.test(part)) return "\\d+";
    const match = /^\{\{matrix(?:\.([\w-]+))?\}\}$/.exec(part);
    if (!match) return escapeRegex(part);
    const values = match[1] ? object(setup)[match[1]] : matrix;
    return Array.isArray(values) && values.length
      ? `(?:${values.map((value) => escapeRegex(String(value))).join("|")})`
      : ".+";
  }).join("");
  return new RegExp(`^${pattern}$`);
}

/** Standard Buildkite YAML, including nested groups and matrix job labels. */
export function addRepositoryGroups(text: string, mapping = emptyMapping()): TestAreaMapping {
  const parsed = parseBuildkiteYaml(text);
  function visit(steps: unknown, parentGroup?: string, parentQueue?: string) {
    if (!Array.isArray(steps)) return;
    for (const value of steps) {
      const step = object(value);
      const group = typeof step.group === "string" ? step.group : parentGroup;
      const queueValue = object(step.agents).queue;
      const queue = typeof queueValue === "string" ? queueValue : parentQueue;
      if (Array.isArray(step.steps)) {
        visit(step.steps, group, queue);
      } else if (group && typeof step.label === "string") {
        if (!mapping.groups.includes(group)) mapping.groups.push(group);
        mapping.patterns.push({
          regex: labelRegex(step.label, step.matrix), group, queue,
          optional: step.optional === true,
          softFail: step.soft_fail === true || (Array.isArray(step.soft_fail) && step.soft_fail.length > 0),
        });
      }
    }
  }
  visit(Array.isArray(parsed) ? parsed : object(parsed).steps, undefined,
    typeof object(object(parsed).agents).queue === "string" ? object(object(parsed).agents).queue as string : undefined);
  return mapping;
}

async function fetchMapping(repo: string, ref: string): Promise<TestAreaMapping> {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: githubHeaders(),
  });
  if (!response.ok) throw new Error(`GitHub tree request failed: ${response.status}`);
  const tree = await response.json() as { tree?: { type: string; path: string }[]; truncated?: boolean };
  if (!tree.tree || tree.truncated) throw new Error("Incomplete repository tree");
  const paths = tree.tree.filter((entry) => entry.type === "blob" && /^\.buildkite\/.*\.ya?ml$/.test(entry.path))
    .map((entry) => entry.path).sort();
  if (!paths.length) throw new Error("No Buildkite YAML found");
  const texts = await Promise.all(paths.map(async (path) => {
    const file = await fetch(githubRawUrl(repo, ref, path));
    if (!file.ok) throw new Error(`GitHub YAML request failed: ${file.status}`);
    return file.text();
  }));
  return texts.reduce((mapping, text) => addRepositoryGroups(text, mapping), emptyMapping());
}

function repositoryMapping(repo: string, ref: string): Promise<TestAreaMapping | null> {
  const key = `${repo}@${ref}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.mapping);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchMapping(repo, ref).then((mapping) => {
    cache.set(key, { mapping, expires: Date.now() + TTL });
    return mapping;
  }).catch((error) => {
    console.error(`Failed to load Buildkite groups for ${key}:`, error);
    const mapping = cached?.mapping ?? null;
    cache.set(key, { mapping, expires: Date.now() + RETRY_TTL });
    return mapping;
  }).finally(() => {
    inFlight.delete(key);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  });
  inFlight.set(key, request);
  return request;
}

export async function getPipelineGroupMapping(
  pipeline?: string | null,
  commit?: string | null,
  branch?: string | null,
): Promise<TestAreaMapping> {
  const repo = pipelineRepository(pipeline);
  if (!repo) return getTestAreaMappingForCommit(commit, branch);
  // Pin even main-branch builds to their commit, so renamed groups keep their history.
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) {
    const mapping = await repositoryMapping(repo, commit);
    if (mapping) return mapping;
  }
  return await repositoryMapping(repo, "main") ?? emptyMapping();
}

/** A group filter can span pipelines; merge only the selected repositories. */
export async function getGroupFilterMapping(pipeline?: string | null): Promise<TestAreaMapping> {
  if (pipeline) return getPipelineGroupMapping(pipeline);
  const mappings = await Promise.all([
    ensureTestAreaMapping(),
    ...[...PIPELINE_REPOSITORIES.keys()].map((name) => getPipelineGroupMapping(name)),
  ]);
  return {
    jobToGroup: new Map(mappings.flatMap((mapping) => [...mapping.jobToGroup])),
    patterns: mappings.flatMap((mapping) => mapping.patterns),
    groups: [...new Set(mappings.flatMap((mapping) => mapping.groups))],
  };
}
