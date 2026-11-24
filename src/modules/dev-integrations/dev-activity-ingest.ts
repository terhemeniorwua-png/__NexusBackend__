import type { PrismaClient } from '@prisma/client';

export const REPOSITORY_COMMIT_MESSAGE_CAP = 4096;
export const REPOSITORY_PR_TITLE_CAP = 500;

export type PushIngestResult = {
  ingestedCommits: number;
  ignoredReason?: string;
  truncated: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeString(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function capMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.slice(0, REPOSITORY_COMMIT_MESSAGE_CAP);
}

function normalizeRepoFullName(value: unknown): string | null {
  const name = safeString(value, 200);
  return name ? name.toLowerCase() : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function branchFromRef(ref: unknown): string | null {
  const raw = safeString(ref, 250);
  if (!raw) return null;
  if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length);
  return raw;
}

function isZeroSha(sha: string | null): boolean {
  return !!sha && /^0{40}$/.test(sha);
}

export function isDefaultBranchPush(payload: Record<string, unknown>): boolean {
  const repository = asRecord(payload.repository);
  const defaultBranch = safeString(repository?.default_branch, 250);
  const refBranch = branchFromRef(payload.ref);
  if (!defaultBranch || !refBranch) return false;
  return defaultBranch === refBranch;
}

export function isTagPush(payload: Record<string, unknown>): boolean {
  const ref = safeString(payload.ref, 250);
  return !!ref && ref.startsWith('refs/tags/');
}

/**
 * Ingest push commits for GitHub default branch only.
 *
 * Truncation: GitHub may truncate the commits array on large pushes
 * (commonly >20 commits). When the push targets the default branch and
 * `after` is not the zero SHA but no commits are present, we cannot
 * reconstruct the missing commit list from the webhook payload alone.
 * Lost on truncation: individual commit mirror rows for commits not
 * included in payload. We ingest whatever commits are present; if none
 * are present, ingestion records 0 commits (no backfill performed).
 * Force-push: history may be rewritten; we upsert commits present in
 * payload by (provider, repositoryFullName, sha) and do not delete
 * existing mirror rows. Branch create/delete: no commit rows deleted;
 * delete/zero-after produces no commit ingestion. Tags ignored.
 */
export async function ingestGithubPushCommits(input: {
  prisma: PrismaClient;
  payload: Record<string, unknown>;
  deliveryId: string;
}): Promise<PushIngestResult> {
  const { prisma, payload, deliveryId } = input;
  if (isTagPush(payload)) {
    return { ingestedCommits: 0, ignoredReason: 'tag_push', truncated: false };
  }

  const repository = asRecord(payload.repository);
  const repositoryFullName = normalizeRepoFullName(repository?.full_name);
  if (!repositoryFullName) {
    return { ingestedCommits: 0, ignoredReason: 'missing_repository', truncated: false };
  }

  if (!isDefaultBranchPush(payload)) {
    return { ingestedCommits: 0, ignoredReason: 'non_default_branch', truncated: false };
  }

  const after = safeString(payload.after, 40);
  const deleted = payload.deleted === true || isZeroSha(after);
  if (deleted) {
    return { ingestedCommits: 0, ignoredReason: 'branch_deleted', truncated: false };
  }

  const commitsRaw = Array.isArray(payload.commits) ? payload.commits : [];
  const branch = branchFromRef(payload.ref);
  const headCommit = asRecord(payload.head_commit);

  const truncated = commitsRaw.length === 0 && !!after && !isZeroSha(after);
  if (truncated) {
    // Lost on truncation: individual commit mirror rows not present in payload.
    // No backfill is performed.
    return { ingestedCommits: 0, ignoredReason: 'truncated_no_commits', truncated: true };
  }

  let ingestedCommits = 0;
  for (const raw of commitsRaw) {
    const commit = asRecord(raw);
    if (!commit) continue;
    const sha = safeString(commit.id, 40)?.toLowerCase() ?? null;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;

    const author = asRecord(commit.author);
    const committedAt =
      parseDate(commit.timestamp) ?? parseDate(author?.date) ?? parseDate(headCommit?.timestamp) ?? new Date();
    const message = capMessage(commit.message);
    const authorName = safeString(author?.name, 200);
    const authorLogin = safeString(author?.username, 200);
    const url = safeString(commit.url, 1000);

    await prisma.repositoryCommit.upsert({
      where: {
        provider_repositoryFullName_sha: {
          provider: 'GITHUB',
          repositoryFullName,
          sha,
        },
      },
      create: {
        provider: 'GITHUB',
        repositoryFullName,
        sha,
        message,
        authorName,
        authorLogin,
        committedAt,
        url,
        branch,
        isDefaultBranch: true,
        sourceDeliveryId: deliveryId,
      },
      update: {
        // Keep original ingested facts stable; refresh mutable display fields.
        message,
        authorName,
        authorLogin,
        committedAt,
        url,
        branch,
        isDefaultBranch: true,
        sourceDeliveryId: deliveryId,
      },
    });
    ingestedCommits += 1;
  }

  return { ingestedCommits, truncated: false };
}

export async function ingestGithubPullRequestEvent(input: {
  prisma: PrismaClient;
  payload: Record<string, unknown>;
  deliveryId: string;
}): Promise<{ ingested: boolean; action?: 'OPENED' | 'MERGED' }> {
  const { prisma, payload, deliveryId } = input;
  const repository = asRecord(payload.repository);
  const repositoryFullName = normalizeRepoFullName(repository?.full_name);
  const pr = asRecord(payload.pull_request);
  const action = safeString(payload.action, 50)?.toLowerCase();

  if (!repositoryFullName || !pr) return { ingested: false };

  const externalPrId = pr.id != null ? String(pr.id) : null;
  if (!externalPrId) return { ingested: false };

  const merged = pr.merged === true || pr.merged_at != null;
  let eventAction: 'OPENED' | 'MERGED' | null = null;
  let occurredAt: Date | null = null;

  if (action === 'opened') {
    eventAction = 'OPENED';
    occurredAt = parseDate(pr.created_at) ?? parseDate(pr.updated_at) ?? new Date();
  } else if (action === 'closed' && merged) {
    eventAction = 'MERGED';
    occurredAt = parseDate(pr.merged_at) ?? parseDate(pr.closed_at) ?? parseDate(pr.updated_at) ?? new Date();
  }

  if (!eventAction || !occurredAt) return { ingested: false };

  const user = asRecord(pr.user);
  const authorLogin = safeString(user?.login, 200);
  const authorName = safeString(user?.login, 200); // GitHub login as display name fallback; no email stored
  const title = safeString(pr.title, REPOSITORY_PR_TITLE_CAP);
  const url = safeString(pr.html_url, 1000);
  const prNumber = typeof pr.number === 'number' ? pr.number : null;

  await prisma.repositoryPullRequestEvent.upsert({
    where: {
      provider_repositoryFullName_externalPrId_action: {
        provider: 'GITHUB',
        repositoryFullName,
        externalPrId,
        action: eventAction,
      },
    },
    create: {
      provider: 'GITHUB',
      repositoryFullName,
      externalPrId,
      prNumber,
      action: eventAction,
      title,
      authorLogin,
      authorName,
      url,
      occurredAt,
      sourceDeliveryId: deliveryId,
    },
    update: {
      prNumber,
      title,
      authorLogin,
      authorName,
      url,
      occurredAt,
      sourceDeliveryId: deliveryId,
    },
  });

  return { ingested: true, action: eventAction };
}

export async function ingestGithubReviewEvent(input: {
  prisma: PrismaClient;
  payload: Record<string, unknown>;
  deliveryId: string;
}): Promise<{ ingested: boolean }> {
  const { prisma, payload, deliveryId } = input;
  const action = safeString(payload.action, 50)?.toLowerCase();
  if (action !== 'submitted') return { ingested: false };

  const repository = asRecord(payload.repository);
  const repositoryFullName = normalizeRepoFullName(repository?.full_name);
  const review = asRecord(payload.review);
  const pr = asRecord(payload.pull_request);
  if (!repositoryFullName || !review) return { ingested: false };

  const externalReviewId = review.id != null ? String(review.id) : null;
  if (!externalReviewId) return { ingested: false };

  const reviewState = safeString(review.state, 50)?.toUpperCase() ?? null;
  if (reviewState === 'DISMISSED') return { ingested: false };

  const user = asRecord(review.user);
  const reviewerLogin = safeString(user?.login, 200);
  const reviewerName = reviewerLogin;
  const submittedAt = parseDate(review.submitted_at) ?? new Date();
  const url = safeString(review.html_url, 1000);
  const externalPrId = pr?.id != null ? String(pr.id) : null;
  const prNumber = typeof pr?.number === 'number' ? pr.number : null;

  await prisma.repositoryReviewEvent.upsert({
    where: {
      provider_repositoryFullName_externalReviewId: {
        provider: 'GITHUB',
        repositoryFullName,
        externalReviewId,
      },
    },
    create: {
      provider: 'GITHUB',
      repositoryFullName,
      externalReviewId,
      externalPrId,
      prNumber,
      reviewState,
      reviewerLogin,
      reviewerName,
      submittedAt,
      url,
      sourceDeliveryId: deliveryId,
    },
    update: {
      externalPrId,
      prNumber,
      reviewState,
      reviewerLogin,
      reviewerName,
      submittedAt,
      url,
      sourceDeliveryId: deliveryId,
    },
  });

  return { ingested: true };
}
