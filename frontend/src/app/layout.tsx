import type { Metadata } from "next";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Maia Axon",
  description: "Group-scoped multimodal document reasoning for engineering teams",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
