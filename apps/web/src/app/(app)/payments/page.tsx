import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Payments" };

export default function Page() {
  return <ComingSoon title="Payments" description="Receipts, cheques, supplier payments and cash handovers." />;
}
