import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Reports" };

export default function Page() {
  return <ComingSoon title="Reports" description="Ageing, outstanding, collections and stock reports." />;
}
