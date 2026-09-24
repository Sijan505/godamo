import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/** Placeholder for sections that arrive in a later step. */
export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-primary">
            <Construction className="size-6" aria-hidden="true" />
          </span>
          <p className="font-heading text-lg font-semibold">Coming in the next step</p>
          <p className="max-w-md text-muted-foreground">
            {description ?? `The ${title.toLowerCase()} screens are being built.`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
