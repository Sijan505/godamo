"use client";

import { LogOut, Smartphone } from "lucide-react";
import { GodamoLogo } from "@/components/brand/godamo-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ROLE_LABELS } from "@/lib/navigation";
import { logout, type Me } from "@/lib/session";

/** Salesmen and drivers work in the mobile Field app, not the office web app. */
export function FieldAppNotice({ me }: { me: Me }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-5 py-4">
          <GodamoLogo className="text-primary" markClassName="size-10" />
          <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-primary">
            <Smartphone className="size-7" aria-hidden="true" />
          </span>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">Namaste, {me.name}!</h1>
            <p className="text-muted-foreground">
              You are logged in as <strong>{ROLE_LABELS[me.role]}</strong>. Please use the{" "}
              <strong>Godamo Field app</strong> on your phone for orders, deliveries and
              collections.
            </p>
            <p lang="ne" className="text-nepali">
              कृपया अर्डर, डेलिभरी र सङ्कलनका लागि फोनमा गोदामो फिल्ड एप प्रयोग गर्नुहोस्।
            </p>
          </div>
          <Button variant="outline" onClick={() => void logout()}>
            <LogOut aria-hidden="true" /> Log out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
