import type { Metadata } from "next";
import { ComingSoon } from "@/components/app/coming-soon";

export const metadata: Metadata = { title: "Invoices" };

export default function Page() {
  return <ComingSoon title="Invoices" description="Issue VAT invoices, print them and see what is paid or overdue." />;
}
