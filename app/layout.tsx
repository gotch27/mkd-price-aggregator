import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./style.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "MKD Catalog · Workspace",
  description: "Browse supermarket catalogs, prices, and connected products.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        {children}
        <Toaster
          position="bottom-right"
          theme="light"
          richColors
          closeButton
          duration={5000}
          visibleToasts={3}
        />
      </body>
    </html>
  );
}
