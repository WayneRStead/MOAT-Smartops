import React from "react";
import { cn } from "../../lib/cn";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";
const variants = {
  primary: "bg-black text-white hover:bg-zinc-800 focus:ring-black",
  secondary:
    "bg-white text-zinc-900 border border-zinc-200 hover:bg-zinc-50 focus:ring-zinc-300",
  outline:
    "bg-transparent text-zinc-900 border border-zinc-300 hover:bg-zinc-50 focus:ring-zinc-300",
  subtle:
    "bg-zinc-100 text-zinc-900 hover:bg-zinc-200 focus:ring-zinc-300",
  danger:
    "bg-red-600 text-white hover:bg-red-700 focus:ring-red-600",
};
const sizes = {
  sm: "px-3 py-1.5 text-xs rounded-lg",
  md: "", // default
  lg: "px-4.5 py-2.5 text-base",
};

export default function Button({
  as: Tag = "button",
  variant = "secondary",
  size = "md",
  className,
  ...props
}) {
  return (
    <Tag className={cn(base, variants[variant], sizes[size], className)} {...props} />
  );
}
