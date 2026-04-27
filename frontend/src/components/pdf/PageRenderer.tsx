"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";

import { HighlightOverlay } from "@/components/pdf/HighlightOverlay";
import { getStoredToken } from "@/lib/api";
import type { Citation, PageData, PageRegion } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";
const imageBlobUrlCache = new Map<string, string>();
const IMAGE_CACHE_NAME = "maia-pdf-images-v1";

type PageJumpLink = {
  label: string;
  pageNumber: number;
  pageLabel?: number;
};

type RegionJumpLink = PageJumpLink & {
  bbox: number[];
};

function hasRenderableBbox(bbox: number[] | undefined): bbox is number[] {
  return Array.isArray(bbox) && bbox.length === 4 && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

function normalizeOutlineLabel(label: string): string {
  return label
    .replace(/\s*[.·•\-–—_]{2,}\s*\d{1,4}\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTrailingPageLabel(text: string): number | undefined {
  const match = text.match(/(\d{1,4})\s*$/);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isPlausibleResolvedTarget(targetPageNumber: number, pageLabel?: number): boolean {
  if (!pageLabel) {
    return true;
  }
  return targetPageNumber >= pageLabel && targetPageNumber <= pageLabel + 40;
}

function parsePersistedPageJumpLinks(regions: PageRegion[] | Record<string, unknown> | null): PageJumpLink[] {
  if (!Array.isArray(regions)) {
    return [];
  }

  const links: PageJumpLink[] = [];
  const seen = new Set<string>();

  for (const region of regions) {
    if (region.type !== "nav_link") {
      continue;
    }

    const targetPageNumber = Number(region.target_page_number);
    if (!Number.isFinite(targetPageNumber) || targetPageNumber <= 0) {
      continue;
    }

    const rawLabel = String(region.target_title ?? region.content ?? "").replace(/\s+/g, " ").trim();
    const label =
      normalizeOutlineLabel(rawLabel) ||
      `Page ${targetPageNumber}`;
    const storedPageLabel = Number(region.target_page_label);
    const pageLabel =
      Number.isFinite(storedPageLabel) && storedPageLabel > 0
        ? storedPageLabel
        : extractTrailingPageLabel(rawLabel);
    if (!isPlausibleResolvedTarget(targetPageNumber, pageLabel)) {
      continue;
    }
    const dedupeKey = `${label.toLowerCase()}::${targetPageNumber}::${Number.isFinite(pageLabel) ? pageLabel : ""}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    links.push({
      label,
      pageNumber: targetPageNumber,
      pageLabel,
    });
  }

  return links;
}

function parseRegionJumpLinks(regions: PageRegion[] | Record<string, unknown> | null): RegionJumpLink[] {
  if (!Array.isArray(regions)) {
    return [];
  }

  const links: RegionJumpLink[] = [];
  const seen = new Set<string>();

  for (const region of regions) {
    if (region.type !== "text" || !hasRenderableBbox(region.bbox)) {
      continue;
    }

    const targetPageNumber = Number(region.target_page_number);
    if (!Number.isFinite(targetPageNumber) || targetPageNumber <= 0) {
      continue;
    }

    const rawLabel = String(region.target_title ?? region.content ?? "").replace(/\s+/g, " ").trim();
    const label =
      normalizeOutlineLabel(rawLabel) ||
      `Page ${targetPageNumber}`;
    const storedPageLabel = Number(region.target_page_label);
    const pageLabel =
      Number.isFinite(storedPageLabel) && storedPageLabel > 0
        ? storedPageLabel
        : extractTrailingPageLabel(rawLabel);
    if (!isPlausibleResolvedTarget(targetPageNumber, pageLabel)) {
      continue;
    }
    const dedupeKey = `${label.toLowerCase()}::${targetPageNumber}::${Number.isFinite(pageLabel) ? pageLabel : ""}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    links.push({
      label,
      pageNumber: targetPageNumber,
      pageLabel,
      bbox: region.bbox.map((value) => Number(value)),
    });
  }

  return links;
}

export function PageRenderer({
  page,
  zoom,
  highlights,
  scrollMode = "contained",
  onNavigateToExactPage,
}: {
  page: PageData;
  zoom: number;
  highlights: Citation[];
  scrollMode?: "contained" | "natural";
  onNavigateToExactPage?: (pageNumber: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });
  const [imageSrc, setImageSrc] = useState(page.image_url);
  const [shouldLoadImage, setShouldLoadImage] = useState(false);
  const coordinateWidth = page.page_width || naturalSize.width;
  const coordinateHeight = page.page_height || naturalSize.height;
  const outlineLinks = useMemo(() => parsePersistedPageJumpLinks(page.regions), [page.regions]);
  const regionJumpLinks = useMemo(() => parseRegionJumpLinks(page.regions), [page.regions]);
  const showRegionLinks = regionJumpLinks.length > 0 && coordinateWidth > 0 && coordinateHeight > 0;
  const showOutlineLinks = !showRegionLinks && outlineLinks.length > 0;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoadImage(true);
          observer.disconnect();
        }
      },
      { rootMargin: "900px 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [page.document_id, page.page_number]);

  useEffect(() => {
    if (!shouldLoadImage) {
      return;
    }

    const cacheKey = `${page.document_id}:${page.page_number}`;
    const cachedBlobUrl = imageBlobUrlCache.get(cacheKey);
    if (cachedBlobUrl) {
      setImageSrc(cachedBlobUrl);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadImage() {
      const token = getStoredToken();
      if (!token) {
        setImageSrc(page.image_url);
        return;
      }

      const imageUrl = `${API_URL}/documents/${page.document_id}/pages/${page.page_number}/image`;
      const cacheKeyRequest = new Request(imageUrl, { method: "GET" });

      if (typeof window !== "undefined" && "caches" in window) {
        try {
          const cache = await window.caches.open(IMAGE_CACHE_NAME);
          const cachedResponse = await cache.match(cacheKeyRequest);
          if (cachedResponse) {
            const cachedBlob = await cachedResponse.blob();
            const cachedObjectUrl = URL.createObjectURL(cachedBlob);
            imageBlobUrlCache.set(cacheKey, cachedObjectUrl);
            if (!cancelled) {
              setImageSrc(cachedObjectUrl);
            }
            return;
          }
        } catch {
          // Ignore cache read failures and fall back to network.
        }
      }

      try {
        const response = await fetch(imageUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "force-cache",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (!cancelled) {
            setImageSrc(page.image_url);
          }
          return;
        }

        if (typeof window !== "undefined" && "caches" in window) {
          try {
            const cache = await window.caches.open(IMAGE_CACHE_NAME);
            await cache.put(cacheKeyRequest, response.clone());
          } catch {
            // Ignore cache write failures.
          }
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        imageBlobUrlCache.set(cacheKey, objectUrl);
        if (!cancelled) {
          setImageSrc(objectUrl);
        }
      } catch (error) {
        if (controller.signal.aborted || cancelled) {
          return;
        }
        setImageSrc(page.image_url);
      }
    }

    void loadImage();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [page.document_id, page.image_url, page.page_number, shouldLoadImage]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) {
      return;
    }

    const syncSize = () => {
      setRenderedSize({
        width: image.clientWidth,
        height: image.clientHeight,
      });
    };

    syncSize();

    const observer = new ResizeObserver(() => {
      syncSize();
    });
    observer.observe(image);

    return () => {
      observer.disconnect();
    };
  }, [imageSrc, zoom]);

  return (
    <div
      ref={containerRef}
      className={`${
        scrollMode === "contained" ? "overflow-y-auto overflow-x-hidden scrollbar-thin" : "overflow-hidden"
      }`}
    >
      <div
        className="mx-auto w-full max-w-[940px] origin-top overflow-hidden border border-black/[0.10] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
      >
        {showOutlineLinks ? (
          <div className="border-b border-black/[0.08] bg-[#f5f4f1] px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                Document outline
              </p>
              <p className="text-[11px] text-muted">Click to jump</p>
            </div>
            <div className="space-y-1">
              {outlineLinks.map((entry) => (
                <button
                  key={`${page.page_number}-${entry.pageNumber}-${entry.label}`}
                  type="button"
                  onClick={() => onNavigateToExactPage?.(entry.pageNumber)}
                  className="flex w-full items-center justify-between gap-3 border border-black/[0.08] bg-white px-3 py-2 text-left transition hover:border-black/20 hover:bg-black/[0.03]"
                >
                  <span className="min-w-0 truncate text-[12px] text-ink">{entry.label}</span>
                  <span className="shrink-0 border border-black/[0.10] bg-[#f5f4f1] px-2 py-1 text-[10px] font-medium tracking-[0.12em] text-muted">
                    {entry.pageLabel ?? entry.pageNumber}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="relative">
          <img
            ref={imageRef}
            src={imageSrc}
            alt={`Page ${page.page_number}`}
            className="block h-auto w-full"
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setRenderedSize({
                width: event.currentTarget.clientWidth,
                height: event.currentTarget.clientHeight,
              });
            }}
          />
          {showRegionLinks ? (
            <div className="pointer-events-none absolute inset-0">
              {regionJumpLinks.map((entry) => {
                const [x1, y1, x2, y2] = entry.bbox;
                const left = (x1 / coordinateWidth) * renderedSize.width;
                const top = (y1 / coordinateHeight) * renderedSize.height;
                const width = ((x2 - x1) / coordinateWidth) * renderedSize.width;
                const height = ((y2 - y1) / coordinateHeight) * renderedSize.height;

                return (
                  <button
                    key={`region-link-${page.page_number}-${entry.pageNumber}-${entry.label}`}
                    type="button"
                    aria-label={`${entry.label}, page ${entry.pageLabel ?? entry.pageNumber}`}
                    title={`${entry.label} -> page ${entry.pageLabel ?? entry.pageNumber}`}
                    onClick={() => onNavigateToExactPage?.(entry.pageNumber)}
                    className="pointer-events-auto absolute border border-transparent bg-transparent transition hover:border-black/15 hover:bg-[#f0e2a0]/20 focus:border-black/20 focus:bg-[#f0e2a0]/24 focus:outline-none"
                    style={{
                      left,
                      top,
                      width: Math.max(width, 24),
                      height: Math.max(height, 16),
                    }}
                  />
                );
              })}
            </div>
          ) : null}
          <HighlightOverlay
            citations={highlights}
            coordinateWidth={coordinateWidth}
            coordinateHeight={coordinateHeight}
            renderedWidth={renderedSize.width}
            renderedHeight={renderedSize.height}
          />
        </div>
      </div>
    </div>
  );
}
