"use client";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export function PageActions({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? createPortal(children, target) : null;
}
