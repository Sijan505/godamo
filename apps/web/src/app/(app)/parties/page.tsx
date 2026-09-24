import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Parties" };

export default function Page() {
  return <ComingSoon title="Parties" description="Customers and suppliers, credit limits, ledgers and reminders." />;
}
