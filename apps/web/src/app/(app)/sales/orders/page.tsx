import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Sales orders" };

export default function Page() {
  return <ComingSoon title="Sales orders" description="Book, confirm and track orders from salesmen and the office." />;
}
