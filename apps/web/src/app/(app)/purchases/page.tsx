import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Purchases" };

export default function Page() {
  return <ComingSoon title="Purchases" description="Enter supplier bills; stock and the supplier ledger update automatically." />;
}
