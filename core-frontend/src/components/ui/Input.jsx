import React from "react";
import { cn } from "../../lib/cn";

const base =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 shadow-xs focus:outline-none focus:ring-2 focus:ring-zinc-300 focus:border-zinc-400";

export function Input({ className, ...props }) {
  return <input className={cn(base, className)} {...props} />;
}

export function Textarea({ className, rows = 3, ...props }) {
  return <textarea rows={rows} className={cn(base, "min-h-[42px]", className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return (
    <select className={cn(base, "pr-8 appearance-none", className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, children, ...props }) {
  return (
    <label className={cn("text-sm font-medium text-zinc-800", className)} {...props}>
      {children}
    </label>
  );
}
