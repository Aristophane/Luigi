"use client";

import { useSyncExternalStore } from "react";

const formats = {
  dateTime: { dateStyle: "short", timeStyle: "short" },
  precise: { dateStyle: "short", timeStyle: "medium" },
  date: { day: "numeric", month: "short", year: "numeric" },
  day: { weekday: "long", day: "numeric", month: "long" },
  time: { hour: "2-digit", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const subscribe = () => () => {};
const getTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const getServerTimeZone = () => undefined;

export function LocalDateTime({ value, format = "dateTime", fallback = "—", className }: {
  value?: string | null;
  format?: keyof typeof formats;
  fallback?: string;
  className?: string;
}) {
  // The server cannot know the browser's time zone. Use the same placeholder
  // during SSR and hydration, then format the original instant in local time.
  const timeZone = useSyncExternalStore(subscribe, getTimeZone, getServerTimeZone);
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return <span className={className}>{fallback}</span>;
  return <time
    className={className}
    dateTime={date.toISOString()}
    title={timeZone ? `${new Intl.DateTimeFormat("fr-FR", { ...formats.precise, timeZone }).format(date)} · ${timeZone}` : "Heure locale"}
  >
    {timeZone ? new Intl.DateTimeFormat("fr-FR", { ...formats[format], timeZone }).format(date) : "…"}
  </time>;
}
