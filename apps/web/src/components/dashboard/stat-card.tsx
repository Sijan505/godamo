import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const TONES = {
  default: { icon: "bg-secondary text-primary", value: "text-foreground" },
  saffron: { icon: "bg-saffron/15 text-warning", value: "text-foreground" },
  success: { icon: "bg-success-soft text-success", value: "text-foreground" },
  danger: { icon: "bg-danger-soft text-danger", value: "text-danger" },
  warning: { icon: "bg-warning-soft text-warning", value: "text-foreground" },
} as const;

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: keyof typeof TONES;
  href?: string;
}) {
  const body = (
    <Card
      className={cn(
        "h-full gap-3 px-5 py-4 transition-shadow",
        href && "hover:shadow-md",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", TONES[tone].icon)}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </div>
      <p className={cn("font-heading text-2xl font-semibold tabular-nums tracking-tight", TONES[tone].value)}>
        {value}
      </p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </Card>
  );
  return href ? (
    <Link href={href} className="rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40">
      {body}
    </Link>
  ) : (
    body
  );
}
