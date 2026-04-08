"use client";
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

import { HighlightOverlay } from "@/components/pdf/HighlightOverlay";
import type { Citation, PageData } from "@/lib/types";

export function PageRenderer({
  page,
  zoom,
  highlights,
}: {
  page: PageData;
  zoom: number;
  highlights: Citation[];
}) {
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });

  return (
    <div className="overflow-auto rounded-[26px] border border-line bg-[#f7f5ef] p-4 scrollbar-thin dark:bg-[#1c2732]">
      <div className="mx-auto origin-top overflow-hidden rounded-[22px] border border-line bg-white shadow-card" style={{ width: "fit-content", transform: `scale(${zoom})`, transformOrigin: "top center" }}>
        <div className="relative">
          <img
            src={page.image_url}
            alt={`Page ${page.page_number}`}
            className="block max-w-full"
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
            naturalWidth={naturalSize.width}
            naturalHeight={naturalSize.height}
            renderedWidth={renderedSize.width}
            renderedHeight={renderedSize.height}
          />
        </div>
      </div>
    </div>
  );
}
