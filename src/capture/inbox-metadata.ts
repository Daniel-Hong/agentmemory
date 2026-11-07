import { isDeepStrictEqual } from 'node:util';
import type { InboxRecord } from '../functions/capture.js';
import type { CaptureReviewHistory } from '../types.js';
import type { StateKV } from '../state/kv.js';
import { KV } from '../state/schema.js';
import { committedSdkResolution } from './sdk-resolution-record.js';

export type CaptureInboxMetadata = Omit<InboxRecord, 'payload'> & {
  preview: string;
  reviewPreview: string;
};

export function projectCaptureInbox(value: unknown): CaptureInboxMetadata {
  const record = value as InboxRecord;
  if (!record) return record;
  const { payload, ...metadata } = record;
  const data = payload?.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  const label = typeof data.tool_name === 'string' ? data.tool_name : payload?.hookType;
  let text = '';
  try { text = JSON.stringify(data.tool_input ?? data.prompt ?? payload?.data ?? ''); } catch {}
  const reviewLabel = typeof data.tool_name === 'string' ? data.tool_name : record.hookType;
  return {
    ...metadata,
    preview: payload ? `${label}: ${text}`.slice(0, 160) : '',
    reviewPreview: (reviewLabel + ': ' + JSON.stringify(data.tool_input ?? data.prompt ?? data.message ?? '')).slice(0, 500),
  };
}

export function listCaptureInboxMetadata(kv: StateKV): Promise<CaptureInboxMetadata[]> {
  return kv.list(KV.captureInbox, { project: projectCaptureInbox });
}

export async function listLocalCaptureResolutionKeys(kv: StateKV): Promise<Set<string> | undefined> {
  if (!kv.graphFileList?.accepts(KV.captureReview)) return undefined;
  const rows = await kv.list(KV.captureReview, { project: (value, key) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof key !== 'string' || !key ||
        (value as CaptureReviewHistory).key !== key) throw Error('capture_review_key_unverified');
    return { key, hasResolution: (value as CaptureReviewHistory).sdkResolution !== undefined };
  } });
  return new Set(rows.filter(row => row.hasResolution).map(row => row.key));
}

export async function committedInboxMetadata(
  kv: StateKV,
  history: CaptureReviewHistory | null | undefined,
  metadata: CaptureInboxMetadata,
): Promise<boolean> {
  if (history?.sdkResolution === undefined) return false;
  const current = await kv.get<InboxRecord>(KV.captureInbox, metadata.key);
  if (!current) return false;
  const { payload, ...currentMetadata } = current;
  const { preview, reviewPreview, ...expectedMetadata } = metadata;
  return isDeepStrictEqual(currentMetadata, expectedMetadata) && committedSdkResolution(history, current);
}
