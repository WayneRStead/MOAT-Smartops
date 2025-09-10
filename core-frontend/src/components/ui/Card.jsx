import React from "react";
import { cn } from "../../lib/cn";

export function Card({ className, ...props }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-zinc-200 bg-white shadow-sm",
        className
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }) {
  return <div className={cn("p-4 border-b bg-zinc-50/50", className)} {...props} />;
}
export function CardBody({ className, ...props }) {
  return <div className={cn("p-4", className)} {...props} />;
}
export function CardFooter({ className, ...props }) {
  return <div className={cn("p-3 border-t bg-zinc-50/30", className)} {...props} />;
}
