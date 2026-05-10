"use client";

// Centralised PDF.js worker setup. Imported once by any module that uses
// react-pdf so the worker URL is configured before <Document> mounts.
//
// We point the worker at a CDN copy of pdfjs-dist pinned to the exact
// version react-pdf bundles. Avoids the "Worker version mismatch"
// runtime error and avoids Next.js/webpack trying to inline a 4MB
// worker file at build time (which fails to parse). For a production-
// grade self-hosted setup, copy the worker into /public at build time
// and switch this URL to "/pdf.worker.min.mjs".

import { pdfjs } from "react-pdf";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}
