"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Money and quantities arrive as decimal strings (never floats) from the API. */
type Money = string;

export interface DashboardSummary {
  asOf: string;
  todaySales: { total: Money; invoiceCount: number };
  todayCollections: { total: Money; byMethod: { method: string; total: Money; count: number }[] };
  receivable: { total: Money; overdue: Money };
  lowStockCount: number;
  expiringSoonCount: number;
  pendingCreditApprovals: number;
  pendingHandovers: number;
  salesLast7Days: { date: string; dateBS: string; total: Money }[];
  topDebtors: {
    party: { id: string; name: string; phone: string | null; creditLimit: Money };
    balance: Money;
    over90Days: Money;
  }[];
  recentInvoices: {
    id: string;
    fiscalYear: string;
    invoiceNo: number;
    invoiceDate: string;
    party: { id: string; name: string };
    total: Money;
    status: "ISSUED" | "CANCELLED";
    outstanding: Money;
    paymentStatus: "PAID" | "PARTIAL" | "UNPAID" | "CANCELLED";
    isOverdue: boolean;
  }[];
}

export function useDashboardSummary() {
  return useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => apiFetch<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}
