"use client";

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Boxes,
  CalendarClock,
  HandCoins,
  Receipt,
  RotateCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { type DashboardSummary, useDashboardSummary } from "@/lib/dashboard";
import { formatNPR, toNumber } from "@/lib/format";
import { formatAD, isoToBS } from "@/lib/nepali-date";
import { cn } from "@/lib/utils";
import { SalesChart } from "./sales-chart";
import { StatCard } from "./stat-card";

export function DashboardView() {
  const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } =
    useDashboardSummary();

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {dataUpdatedAt
              ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · refreshes every minute`
              : "Today at a glance"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RotateCw className={cn(isFetching && "animate-spin")} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {isPending ? (
        <DashboardSkeleton />
      ) : isError ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : "Something went wrong."}
          onRetry={() => void refetch()}
        />
      ) : (
        <DashboardContent data={data} />
      )}
    </div>
  );
}

function DashboardContent({ data }: { data: DashboardSummary }) {
  const hasOverdue = toNumber(data.receivable.overdue) > 0;
  const collectionHint = data.todayCollections.byMethod.length
    ? data.todayCollections.byMethod.map((m) => `${m.method} ${formatNPR(m.total)}`).join(" · ")
    : "No receipts yet today";

  return (
    <>
      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Today's sales"
          value={formatNPR(data.todaySales.total)}
          hint={`${data.todaySales.invoiceCount} invoice${data.todaySales.invoiceCount === 1 ? "" : "s"}`}
          icon={TrendingUp}
          href="/sales/invoices"
        />
        <StatCard
          label="Today's collections"
          value={formatNPR(data.todayCollections.total)}
          hint={collectionHint}
          icon={HandCoins}
          tone="success"
          href="/payments"
        />
        <StatCard
          label="Total receivable"
          value={formatNPR(data.receivable.total)}
          hint="Owed by all parties"
          icon={Wallet}
          tone="saffron"
          href="/reports"
        />
        <StatCard
          label="Overdue"
          value={formatNPR(data.receivable.overdue)}
          hint={hasOverdue ? "Past the party's credit days" : "Nothing overdue"}
          icon={AlertTriangle}
          tone={hasOverdue ? "danger" : "success"}
          href="/reports"
        />
        <StatCard
          label="Low stock"
          value={`${data.lowStockCount} product${data.lowStockCount === 1 ? "" : "s"}`}
          hint="At or below reorder level"
          icon={Boxes}
          tone={data.lowStockCount ? "warning" : "default"}
          href="/stock"
        />
        <StatCard
          label="Expiring soon"
          value={`${data.expiringSoonCount} batch${data.expiringSoonCount === 1 ? "" : "es"}`}
          hint="Within 30 days (incl. expired)"
          icon={CalendarClock}
          tone={data.expiringSoonCount ? "warning" : "default"}
          href="/stock"
        />
      </section>

      <section aria-label="Needs attention" className="grid gap-3 sm:grid-cols-2">
        <AlertLink
          href="/parties"
          count={data.pendingCreditApprovals}
          label="Credit approvals waiting"
          icon={BadgeCheck}
        />
        <AlertLink
          href="/payments"
          count={data.pendingHandovers}
          label="Cash handovers to verify"
          icon={Receipt}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Sales, last 7 days</CardTitle>
            <CardDescription>Issued invoices by day (BS dates)</CardDescription>
          </CardHeader>
          <CardContent>
            <SalesChart days={data.salesLast7Days} />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Top debtors</CardTitle>
            <CardDescription>Highest balances; 90+ days highlighted</CardDescription>
          </CardHeader>
          <CardContent className="px-2 sm:px-3">
            {data.topDebtors.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Party</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">90+ days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topDebtors.map((d) => {
                    const old = toNumber(d.over90Days) > 0;
                    return (
                      <TableRow key={d.party.id}>
                        <TableCell className="max-w-44 truncate font-medium" title={d.party.name}>
                          {d.party.name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNPR(d.balance)}</TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums",
                            old ? "font-semibold text-danger" : "text-muted-foreground",
                          )}
                        >
                          {old ? formatNPR(d.over90Days) : "–"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <EmptyText>No one owes you money right now.</EmptyText>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <CardTitle>Recent invoices</CardTitle>
            <CardDescription>Last 8 invoices</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm" className="self-center">
            <Link href="/sales/invoices">
              All invoices <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="px-2 sm:px-3">
          {data.recentInvoices.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentInvoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium tabular-nums">
                      {inv.fiscalYear}-{inv.invoiceNo}
                    </TableCell>
                    <TableCell>
                      <span className="block text-nepali">{isoToBS(inv.invoiceDate)}</span>
                      <span className="block text-xs text-muted-foreground">{formatAD(inv.invoiceDate)}</span>
                    </TableCell>
                    <TableCell className="max-w-56 truncate" title={inv.party.name}>
                      {inv.party.name}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", inv.status === "CANCELLED" && "text-muted-foreground line-through")}>
                      {formatNPR(inv.total)}
                    </TableCell>
                    <TableCell>
                      <PaymentBadge status={inv.paymentStatus} overdue={inv.isOverdue} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyText>No invoices yet.</EmptyText>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PaymentBadge({
  status,
  overdue,
}: {
  status: DashboardSummary["recentInvoices"][number]["paymentStatus"];
  overdue: boolean;
}) {
  if (status === "CANCELLED") return <Badge variant="outline">Cancelled</Badge>;
  if (status === "PAID") return <Badge variant="success">Paid</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={status === "PARTIAL" ? "warning" : "secondary"}>
        {status === "PARTIAL" ? "Part paid" : "Unpaid"}
      </Badge>
      {overdue ? <Badge variant="danger">Overdue</Badge> : null}
    </span>
  );
}

function AlertLink({
  href,
  count,
  label,
  icon: Icon,
}: {
  href: string;
  count: number;
  label: string;
  icon: typeof BadgeCheck;
}) {
  const active = count > 0;
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active ? "border-saffron/50 bg-saffron/10 hover:bg-saffron/15" : "bg-card hover:bg-accent",
      )}
    >
      <Icon className={cn("size-5", active ? "text-warning" : "text-muted-foreground")} aria-hidden="true" />
      <span className="flex-1 font-medium">{label}</span>
      <Badge variant={active ? "saffron" : "secondary"} aria-label={`${count} ${label.toLowerCase()}`}>
        {count}
      </Badge>
      <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card role="alert" className="items-center gap-3 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </span>
      <p className="font-heading text-lg font-semibold">Could not load the dashboard</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button onClick={onRetry}>
        <RotateCw aria-hidden="true" /> Try again
      </Button>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i} className="gap-3 px-5 py-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-24" />
          </Card>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <div className="grid gap-6 xl:grid-cols-5">
        <Skeleton className="h-80 rounded-xl xl:col-span-3" />
        <Skeleton className="h-80 rounded-xl xl:col-span-2" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
