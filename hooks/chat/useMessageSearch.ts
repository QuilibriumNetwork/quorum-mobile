/**
 * useMessageSearch - Hook for searching through loaded messages
 *
 * Uses MiniSearch for fuzzy, prefix-based full-text search.
 * Returns matching messages with relevance score.
 *
 * Perf: the MiniSearch index is built lazily — only the first time the
 * user opens search in this session, and rebuilt only while search is
 * open. For a chat with ~1000 messages the build takes 50–100ms of
 * synchronous JS, which is wasted when the user never searches (the
 * common case). Indexing is also moved off the render path to the next
 * task (`setTimeout`) so it doesn't compete with
 * the chat update tick — there's a ~frame delay before the first
 * keystroke produces results, but that's invisible compared to the
 * typing latency it removes.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import MiniSearch from 'minisearch';
import type { DisplayMessage } from '@/components/Chat/types';
import { logger } from '@quilibrium/quorum-shared';
export interface SearchResult {
  message: DisplayMessage;
  /** Index of the first match in message content */
  matchIndex: number;
  /** Relevance score from MiniSearch */
  score: number;
}

function buildIndex(messages: DisplayMessage[]) {
  const ms = new MiniSearch<{ id: string; content: string; userName: string }>({
    fields: ['content', 'userName'],
    storeFields: ['id'],
    searchOptions: {
      fuzzy: 0.2,
      prefix: true,
      boost: { content: 2, userName: 1 },
    },
  });

  // Dedupe by id before handing off — MiniSearch throws "duplicate id"
  // on addAll if any id repeats, which would crash the whole space
  // render. Duplicate display-messages can appear briefly during
  // page-transition state (same message in two pages) or if the same
  // wire message was delivered via both the inbox subscription and
  // the log-since catch-up path before dedup landed in storage.
  const seen = new Set<string>();
  const docs: { id: string; content: string; userName: string }[] = [];
  for (const msg of messages) {
    if (msg.renderType !== 'post' && msg.renderType !== 'embed') continue;
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    docs.push({ id: msg.id, content: msg.content, userName: msg.userName });
  }

  try {
    ms.addAll(docs);
  } catch (e) {
    // Last-resort guardrail. Search degrades gracefully (returns no
    // results) rather than blowing up the whole chat surface if some
    // exotic input still slips past the dedup above.
    logger.warn('[useMessageSearch] MiniSearch.addAll threw:', e);
  }
  return ms;
}

export function useMessageSearch(messages: DisplayMessage[]) {
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [miniSearch, setMiniSearch] = useState<MiniSearch | null>(null);
  // Latch — once the user opens search in this session, keep the index
  // alive and refresh it as messages change. We never re-clear this so
  // a second open is instant.
  const everOpenedRef = useRef(false);

  useEffect(() => {
    if (!isSearchOpen) return;
    everOpenedRef.current = true;
    // Build on the next task, so the search UI renders before the index
    // build blocks the thread. (runAfterInteractions resolved as a microtask
    // under the New Architecture, so it built before the UI got a frame.)
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setMiniSearch(buildIndex(messages));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [messages, isSearchOpen]);

  // Message lookup map for fast retrieval
  const messageMap = useMemo(() => {
    const map = new Map<string, DisplayMessage>();
    for (const msg of messages) {
      map.set(msg.id, msg);
    }
    return map;
  }, [messages]);

  const results = useMemo((): SearchResult[] => {
    if (!query.trim()) return [];
    // Index hasn't built yet (first open in session, building in idle).
    // Returning empty here just means the UI shows no results for
    // ~1 frame; the next render after the build completes will fill in.
    if (!miniSearch) return [];

    const searchResults = miniSearch.search(query.trim());

    return searchResults
      .map(result => {
        const message = messageMap.get(result.id);
        if (!message) return null;

        const lowerContent = message.content.toLowerCase();
        const lowerQuery = query.toLowerCase().trim();
        const matchIndex = lowerContent.indexOf(lowerQuery);

        return {
          message,
          matchIndex: matchIndex !== -1 ? matchIndex : 0,
          score: result.score,
        };
      })
      .filter((r): r is SearchResult => r !== null);
  }, [miniSearch, messageMap, query]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    setQuery('');
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setQuery('');
  }, []);

  return {
    query,
    setQuery,
    results,
    resultCount: results.length,
    isSearchOpen,
    openSearch,
    closeSearch,
  };
}
