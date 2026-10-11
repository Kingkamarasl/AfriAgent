"use client";

import Link from "next/link";

/** Shared navigation. Small enough that a layout would cost more than it saves. */
const LINKS = [
  ["/", "Dashboard"],
  ["/knowledge", "Knowledge"],
  ["/handoffs", "Handoffs"],
] as const;

export function AppNav({ current }: { current: string }) {
  return (
    <nav className="mb-5 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {LINKS.map(([href, label]) => {
        const active = href === current;
        return (
          <Link
            key={href}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              active
                ? "border-emerald-500 text-zinc-900 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
