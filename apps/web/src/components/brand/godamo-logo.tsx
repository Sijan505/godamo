import { cn } from "@/lib/utils";

/** The Godamo mark: a godown roof with a stack of saffron boxes. Uses currentColor for the roof. */
export function GodamoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={cn("size-8 shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 52 L60 18 L108 52"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 60 V101 M96 60 V101 M18 101 H102"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g fill="#F28C28">
        <rect x="34" y="78" width="16" height="16" rx="2" />
        <rect x="52" y="78" width="16" height="16" rx="2" />
        <rect x="70" y="78" width="16" height="16" rx="2" />
        <rect x="43" y="60" width="16" height="16" rx="2" />
        <rect x="61" y="60" width="16" height="16" rx="2" />
        <rect x="52" y="42" width="16" height="16" rx="2" />
      </g>
    </svg>
  );
}

/** Mark + lowercase "godamo" wordmark in Sora bold. Colour follows `className` (currentColor). */
export function GodamoLogo({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <GodamoMark className={markClassName} />
      {showWordmark ? (
        <span className="font-heading text-xl font-bold leading-none tracking-tight">
          godamo
        </span>
      ) : (
        <span className="sr-only">Godamo</span>
      )}
    </span>
  );
}
