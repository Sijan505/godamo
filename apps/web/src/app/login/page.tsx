import type { Metadata } from "next";
import { GodamoLogo } from "@/components/brand/godamo-logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Brand panel */}
      <section
        aria-label="Godamo"
        className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        <GodamoLogo className="text-white" markClassName="size-10" />
        <div className="max-w-md">
          <p lang="ne" className="font-sans text-5xl font-semibold text-saffron">
            गोदामो
          </p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight">
            Wholesale &amp; Distribution Management
          </h1>
          <p className="mt-4 text-base text-white/80">
            Stock, billing, credit and collections for Nepali distributors, all in one place.
          </p>
        </div>
        <p className="text-sm text-white/70">© Cezvora Technology</p>
        <svg
          aria-hidden="true"
          viewBox="0 0 120 120"
          className="pointer-events-none absolute -right-16 -bottom-16 size-80 text-white/5"
        >
          <path d="M12 52 L60 18 L108 52" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M24 60 V101 M96 60 V101 M18 101 H102" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </section>

      {/* Form */}
      <section className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="mb-8 flex flex-col items-center gap-2 text-primary lg:hidden">
          <GodamoLogo markClassName="size-10" />
          <p className="text-sm text-muted-foreground">Wholesale &amp; Distribution Management</p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
