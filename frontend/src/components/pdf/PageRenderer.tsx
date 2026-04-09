"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";

import { HighlightOverlay } from "@/components/pdf/HighlightOverlay";
import { getStoredToken } from "@/lib/api";
import type { Citation, PageData } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";

export function PageRenderer({
  page,
  zoom,
  highlights,
  scrollMode = "contained",
}: {
  page: PageData;
  zoom: number;
  highlights: Citation[];
  scrollMode?: "contained" | "natural";
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });
  const [imageSrc, setImageSrc] = useState(page.image_url);
  const coordinateWidth = page.page_width || naturalSize.width;
  const coordinateHeight = page.page_height || naturalSize.height;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function loadImage() {
      const token = getStoredToken();
      if (!token) {
        setImageSrc(page.image_url);
        return;
      }

      const response = await fetch(
        `${API_URL}/documents/${page.document_id}/pages/${page.page_number}/image`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "force-cache",
        },
      );

      if (!response.ok) {
        setImageSrc(page.image_url);
        return;
      }

      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      if (!cancelled) {
        setImageSrc(objectUrl);
      }
    }

    void loadImage();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [page.document_id, page.image_url, page.page_number]);

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
      className={`rounded-[32px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(251,251,250,0.96),rgba(243,241,236,0.96))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:bg-[#1c2732] ${
        scrollMode === "contained" ? "overflow-y-auto overflow-x-hidden scrollbar-thin" : "overflow-hidden"
      }`}
    >
      <div
        className="mx-auto w-full max-w-[980px] origin-top overflow-hidden rounded-[28px] border border-black/[0.08] bg-white shadow-[0_28px_80px_rgba(15,23,42,0.16)]"
        style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
      >
        <div className="relative">
          <img
            ref={imageRef}
            src={imageSrc}
            alt={`Page ${page.page_number}`}
            className="block h-auto w-full"
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
