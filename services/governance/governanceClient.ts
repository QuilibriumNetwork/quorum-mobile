/**
 * /hegemony governance client.
 *
 * The Farcaster /hegemony channel runs governance through casts: a cast whose
 * text starts with `PROPOSAL:` is a proposal, and `FOR` / `AGAINST` replies
 * (optionally `FOR: <reason>`) are votes, weighted by the voter's hypersnap
 * reputation ("points"), last-vote-per-fid winning.
 *
 * The reputation-weighted tallies are computed server-side from a large points
 * snapshot, so we consume the same pre-parsed feed the hypersnap portal uses
 * (`GET /api/governance`) rather than re-deriving it on-device. Types mirror
 * `~/src/hypersnap-portal/src/lib/governance.ts`.
 */

const HEGEMONY_API_BASE = 'https://api.hypria.app';

export interface ResolvedEmbed {
  type: 'url' | 'cast';
  url?: string;
  hash?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  authorPfpUrl?: string;
  text?: string;
  timestamp?: string;
}

export interface CastReply {
  authorFid: number;
  authorUsername: string;
  authorDisplayName: string;
  authorPfpUrl: string;
  text: string;
  timestamp: string;
  /** Voter's hypersnap reputation points (vote weight). */
  points: number;
  replies: CastReply[];
}

export interface ChannelCast {
  hash: string;
  authorFid: number;
  authorUsername: string;
  authorDisplayName: string;
  authorPfpUrl: string;
  text: string;
  timestamp: string;
  likes: number;
  recasts: number;
  replies: number;
  embeds: ResolvedEmbed[];
  directReplies: CastReply[];
  isProposal: boolean;
  /** Sum of FOR voters' points (proposals only). */
  votesFor: number;
  /** Sum of AGAINST voters' points (proposals only). */
  votesAgainst: number;
}

/** Reputation tier from a points total (mirrors the portal). */
export function getTier(points: number): string {
  if (points >= 1_000_000) return 'Hegemon';
  if (points >= 500_000) return 'Consul';
  if (points >= 200_000) return 'Senator';
  return 'Citizen';
}

/** Classify a reply's text as a FOR/AGAINST vote (mirrors the backend). */
export function parseVote(text: string): 'for' | 'against' | null {
  const t = text.trim();
  if (t === 'FOR' || t.startsWith('FOR:') || t.startsWith('FOR :')) return 'for';
  if (t === 'AGAINST' || t.startsWith('AGAINST:') || t.startsWith('AGAINST :')) return 'against';
  return null;
}

export async function fetchGovernance(): Promise<ChannelCast[]> {
  const res = await fetch(`${HEGEMONY_API_BASE}/api/governance`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`governance fetch ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as ChannelCast[]) : [];
}
