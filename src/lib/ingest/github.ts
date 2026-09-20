import { config } from "../config";
import { AppError } from "../util/errors";
import { scrubToken } from "./credentials";
import { extractZip } from "./zip";
import type { RawFile } from "./types";

export interface GitHubRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit chosen by the user; undefined means default branch. */
  ref?: string;
}

export interface GitHubMetadata {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  branch: string;
  commit: string;
  commitMessage: string;
  commitDate: string | null;
  languages: Record<string, number>;
  sizeKb: number;
  isPrivate: boolean;
  approximateFileCount: number | null;
  htmlUrl: string;
}

export function parseGitHubUrl(input: string): GitHubRef {
  const trimmed = input.trim();
  const patterns = [
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|commit|commits)\/([^\s?#]+))?\/?(?:[?#].*)?$/,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return { owner: m[1], repo: m[2], ref: m[3] ? decodeURIComponent(m[3]) : undefined };
  }
  throw new AppError("invalid_github_url", `"${input}" is not a recognizable GitHub repository URL.`, 400, "Use the form https://github.com/owner/repository.");
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "brody-repo-intelligence", "X-GitHub-Api-Version": "2022-11-28" };
  const t = token || config.github.token;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function gh<T>(path: string, token?: string): Promise<T> {
  const url = `${config.github.apiBase}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(token) });
  } catch (e) {
    throw new AppError("github_unreachable", `Could not reach GitHub: ${scrubToken(String(e))}`, 502, "Check network access from the server.");
  }
  if (res.status === 404) {
    throw new AppError("github_not_found", `GitHub returned 404 for ${path.split("?")[0]}.`, 404, token || config.github.token ? "The repository does not exist, or the token lacks access to it." : "The repository is private or does not exist. Supply a personal access token with read access to import a private repository.");
  }
  if (res.status === 401) throw new AppError("github_unauthorized", "GitHub rejected the supplied token.", 401, "Generate a token with `repo` (classic) or `Contents: read` (fine-grained) permission.");
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new AppError("github_rate_limited", remaining === "0" ? "GitHub API rate limit exhausted." : "GitHub denied the request (403).", 429, "Supply a token to raise the rate limit, or wait and retry.");
  }
  if (!res.ok) throw new AppError("github_error", `GitHub API error ${res.status} for ${path.split("?")[0]}.`, 502);
  return (await res.json()) as T;
}

interface RepoResponse { name: string; full_name: string; description: string | null; default_branch: string; size: number; private: boolean; html_url: string; owner: { login: string } }
interface CommitResponse { sha: string; commit: { message: string; committer: { date: string } | null } }
interface TreeResponse { tree: { type: string }[]; truncated: boolean }

export async function fetchGitHubMetadata(ref: GitHubRef, token?: string): Promise<GitHubMetadata> {
  const repo = await gh<RepoResponse>(`/repos/${ref.owner}/${ref.repo}`, token);
  const branch = ref.ref ?? repo.default_branch;
  const commit = await gh<CommitResponse>(`/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}`, token).catch((e) => {
    if (e instanceof AppError && e.code === "github_not_found") throw new AppError("github_ref_not_found", `Branch, tag or commit "${branch}" was not found in ${repo.full_name}.`, 404, "Check the ref name, or leave it blank to use the default branch.");
    throw e;
  });
  const languages = await gh<Record<string, number>>(`/repos/${ref.owner}/${ref.repo}/languages`, token).catch(() => ({}));
  let approximateFileCount: number | null = null;
  try {
    const tree = await gh<TreeResponse>(`/repos/${ref.owner}/${ref.repo}/git/trees/${commit.sha}?recursive=1`, token);
    approximateFileCount = tree.tree.filter((t) => t.type === "blob").length;
    if (tree.truncated) approximateFileCount = approximateFileCount * -1; // negative marks "at least"
  } catch {
    approximateFileCount = null;
  }
  return {
    owner: repo.owner.login,
    repo: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    defaultBranch: repo.default_branch,
    branch,
    commit: commit.sha,
    commitMessage: commit.commit.message.split("\n")[0],
    commitDate: commit.commit.committer?.date ?? null,
    languages,
    sizeKb: repo.size,
    isPrivate: repo.private,
    approximateFileCount,
    htmlUrl: repo.html_url,
  };
}

/** Download the repository snapshot as a zipball and extract it in memory. */
export async function downloadGitHubSnapshot(ref: GitHubRef, commit: string, token?: string): Promise<{ files: RawFile[]; warnings: string[] }> {
  const url = `${config.github.apiBase}/repos/${ref.owner}/${ref.repo}/zipball/${encodeURIComponent(commit)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(token), redirect: "follow" });
  } catch (e) {
    throw new AppError("github_unreachable", `Could not download the repository archive: ${scrubToken(String(e))}`, 502);
  }
  if (!res.ok) throw new AppError("github_download_failed", `GitHub returned ${res.status} while downloading the repository archive.`, 502, "Verify the repository is accessible with the supplied credentials.");
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > config.limits.maxUploadBytes) throw new AppError("repo_too_large", `The repository archive is ${Math.round(length / 1024 / 1024)} MB, above the configured limit.`, 413);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.limits.maxUploadBytes) throw new AppError("repo_too_large", `The repository archive exceeds the configured ${Math.round(config.limits.maxUploadBytes / 1024 / 1024)} MB limit.`, 413);
  const out = await extractZip(buf);
  return { files: out.files, warnings: out.warnings };
}
