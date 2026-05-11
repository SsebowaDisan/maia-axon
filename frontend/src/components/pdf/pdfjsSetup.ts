"use client";

// Centralised PDF.js worker setup. Imported once by any module that uses
// react-pdf so the worker URL is configured before <Document> mounts.
//
// We self-host the worker from /public/pdfjs (kept in sync with the
// installed pdfjs-dist version). Same-origin loading is faster than a
// CDN — no third-party DNS + TLS handshake on first PDF open, and it
// survives if the CDN goes down. The worker file is checked into
// public/pdfjs/pdf.worker.min.mjs; if you bump pdfjs-dist, re-copy
// node_modules/pdfjs-dist/build/pdf.worker.min.mjs over the public one.

import { pdfjs } from "react-pdf";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
}
