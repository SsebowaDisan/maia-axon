"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface SearchMatch {
  pageNumber: number;
  // 0-indexed occurrence on that page (0 = first hit on the page).
  indexInPage: number;
}

export interface PdfSearchState {
  query: string;
  setQuery: (value: string) => void;
  matches: SearchMatch[];
  currentIndex: number;
  currentMatch: SearchMatch | null;
  searching: boolean;
  goNext: () => void;
  goPrev: () => void;
  goToIndex: (index: number) => void;
  clear: () => void;
}

const MIN_QUERY_LENGTH = 2;

// Word-level full-document search across a loaded PDF. Pulls text content
// per page lazily through pdfjs and caches the lowercased string so the
// next search of the same doc is essentially free.
export function usePdfSearch(pdf: PDFDocumentProxy | null): PdfSearchState {
  const [query, setQueryState] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searching, setSearching] = useState(false);

  const pageTextCacheRef = useRef<Map<number, string>>(new Map());
  const docFingerprintRef = useRef<string | null>(null);

  // When a different PDF loads, drop the cache so we don't search stale text.
  useEffect(() => {
    const fp = pdf?.fingerprints?.[0] ?? null;
    if (fp !== docFingerprintRef.current) {
      docFingerprintRef.current = fp;
      pageTextCacheRef.current.clear();
      setMatches([]);
      setCurrentIndex(0);
    }
  }, [pdf]);

  useEffect(() => {
    const needle = query.trim().toLowerCase();
    if (!pdf || needle.length < MIN_QUERY_LENGTH) {
      setMatches([]);
      setCurrentIndex(0);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    (async () => {
      const collected: SearchMatch[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) {
          return;
        }
        let pageText = pageTextCacheRef.current.get(pageNumber);
        if (pageText === undefined) {
          try {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            pageText = content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" ")
              .toLowerCase();
            pageTextCacheRef.current.set(pageNumber, pageText);
          } catch {
            pageTextCacheRef.current.set(pageNumber, "");
            pageText = "";
          }
        }
        let cursor = 0;
        let occurrence = 0;
        while (true) {
          const found = pageText.indexOf(needle, cursor);
          if (found === -1) {
            break;
          }
          collected.push({ pageNumber, indexInPage: occurrence });
          occurrence += 1;
          cursor = found + needle.length;
        }
      }
      if (!cancelled) {
        setMatches(collected);
        setCurrentIndex(0);
        setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, query]);

  const goNext = useCallback(() => {
    setCurrentIndex((idx) => (matches.length === 0 ? 0 : (idx + 1) % matches.length));
  }, [matches.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((idx) =>
      matches.length === 0 ? 0 : (idx - 1 + matches.length) % matches.length,
    );
  }, [matches.length]);

  const goToIndex = useCallback(
    (index: number) => {
      if (matches.length === 0) {
        setCurrentIndex(0);
        return;
      }
      const clamped = Math.max(0, Math.min(matches.length - 1, index));
      setCurrentIndex(clamped);
    },
    [matches.length],
  );

  const clear = useCallback(() => {
    setQueryState("");
    setMatches([]);
    setCurrentIndex(0);
  }, []);

  return {
    query,
    setQuery: setQueryState,
    matches,
    currentIndex,
    currentMatch: matches[currentIndex] ?? null,
    searching,
    goNext,
    goPrev,
    goToIndex,
    clear,
  };
}
