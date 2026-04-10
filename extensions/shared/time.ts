const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", {
  numeric: "always",
  style: "narrow",
});

const RELATIVE_TIME_UNITS = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
] as const;

export function formatCompactRelativeTime(
  value: string | number | Date,
  nowMs: number = Date.now(),
): string | undefined {
  const targetMs =
    value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  if (Number.isNaN(targetMs)) {
    return undefined;
  }

  const diffSeconds = Math.round((targetMs - nowMs) / 1000);
  const absDiffSeconds = Math.abs(diffSeconds);
  if (absDiffSeconds < 60) {
    return "now";
  }

  for (const [unit, secondsPerUnit] of RELATIVE_TIME_UNITS) {
    if (absDiffSeconds >= secondsPerUnit || unit === "second") {
      const valueForUnit = Math.sign(diffSeconds) * Math.floor(absDiffSeconds / secondsPerUnit);
      return RELATIVE_TIME_FORMATTER.format(valueForUnit, unit).replace(/ ago$/, "");
    }
  }
}
