import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Stock" };

export default function Page() {
  return <ComingSoon title="Stock" description="Stock by godown, transfers, adjustments, counts and expiry." />;
}
