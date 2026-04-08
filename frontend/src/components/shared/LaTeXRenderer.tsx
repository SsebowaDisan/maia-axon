"use client";

import katex from "katex";

export function LaTeXRenderer({
  expression,
  block = false,
}: {
  expression: string;
  block?: boolean;
}) {
  const html = katex.renderToString(expression, {
    displayMode: block,
    throwOnError: false,
  });

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
