"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { landingPath, safeNextPath } from "@/lib/auth-cookies";

const REMEMBER_KEY = "godamo.companyCode";

const schema = z.object({
  companyCode: z
    .string()
    .trim()
    .min(2, "Enter your company code")
    .max(20, "Company code is too long")
    .regex(/^[A-Z0-9_-]+$/, "Use letters and numbers only"),
  phone: z
    .string()
    .trim()
    .regex(/^9[78]\d{8}$/, "Enter a 10-digit mobile number starting with 97 or 98"),
  password: z.string().min(1, "Enter your password"),
  remember: z.boolean(),
});
type LoginValues = z.infer<typeof schema>;

export function LoginForm() {
  const ids = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { companyCode: "", phone: "", password: "", remember: false },
  });

  // Only the company code is ever remembered (never the phone or password).
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(REMEMBER_KEY);
    } catch {
      // storage blocked: ignore
    }
    if (saved) {
      setValue("companyCode", saved);
      setValue("remember", true);
      setFocus("phone");
    } else {
      setFocus("companyCode");
    }
  }, [setValue, setFocus]);

  const onSubmit = async (values: LoginValues) => {
    setError(null);
    try {
      if (values.remember) window.localStorage.setItem(REMEMBER_KEY, values.companyCode);
      else window.localStorage.removeItem(REMEMBER_KEY);
    } catch {
      // storage blocked: ignore
    }

    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          companyCode: values.companyCode,
          phone: values.phone,
          password: values.password,
        }),
      });
    } catch {
      setError("Cannot reach Godamo. Check your internet connection and try again.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      user?: { role: string };
    };
    if (!res.ok || !data.user) {
      setError(data.message ?? "Login failed. Please try again.");
      setValue("password", "");
      setFocus("password");
      return;
    }
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    // Full navigation so the app starts with the new session cookies.
    window.location.assign(next ?? landingPath(data.user.role));
  };

  const companyCode = register("companyCode");
  const errorId = `${ids}-error`;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Log in</CardTitle>
        <CardDescription>Use the company code, mobile number and password given by your owner.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-5" aria-describedby={error ? errorId : undefined}>
          {error ? (
            <div
              id={errorId}
              role="alert"
              className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-company`}>Company code</Label>
            <Input
              id={`${ids}-company`}
              autoComplete="organization"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="e.g. DEMO"
              aria-invalid={!!errors.companyCode}
              aria-describedby={errors.companyCode ? `${ids}-company-err` : undefined}
              {...companyCode}
              onChange={(e) => {
                e.target.value = e.target.value.toUpperCase();
                void companyCode.onChange(e);
              }}
            />
            {errors.companyCode ? (
              <p id={`${ids}-company-err`} className="text-sm text-danger">
                {errors.companyCode.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-phone`}>Mobile number</Label>
            <Input
              id={`${ids}-phone`}
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              placeholder="98XXXXXXXX"
              maxLength={10}
              aria-invalid={!!errors.phone}
              aria-describedby={errors.phone ? `${ids}-phone-err` : undefined}
              {...register("phone")}
            />
            {errors.phone ? (
              <p id={`${ids}-phone-err`} className="text-sm text-danger">
                {errors.phone.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-password`}>Password</Label>
            <div className="relative">
              <Input
                id={`${ids}-password`}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="pr-11"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? `${ids}-password-err` : undefined}
                {...register("password")}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-0.5 right-0.5 size-9 text-muted-foreground"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            {errors.password ? (
              <p id={`${ids}-password-err`} className="text-sm text-danger">
                {errors.password.message}
              </p>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 cursor-pointer accent-primary"
              {...register("remember")}
            />
            Remember company code on this device
          </label>

          <Button type="submit" size="lg" disabled={isSubmitting} className="w-full">
            {isSubmitting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" /> Logging in…
              </>
            ) : (
              <>
                <LogIn aria-hidden="true" /> Log in
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
