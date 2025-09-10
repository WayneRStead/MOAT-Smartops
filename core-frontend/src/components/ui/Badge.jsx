import React from "react";
import { cn } from "../../lib/cn";

const variants = {
  gray: "bg-zinc-100 text-zinc-800 border-zinc-200",
  green: "bg-green-100 text-green-800 border-green-200",
  amber: "bg-amber-100 text-amber-800 border-amber-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
};
export default function Badge({ variant = "gray", className, ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
