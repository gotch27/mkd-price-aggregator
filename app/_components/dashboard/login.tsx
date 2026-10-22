import { useState, type FormEvent } from "react";
import { ArrowRight, GalleryVerticalEnd, LockKeyhole } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
export function Login({
  error,
  onSubmit,
}: {
  error: string;
  onSubmit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-screen">
      <div className="login-brand">
        <GalleryVerticalEnd className="size-6" />
        <span>MKD Catalog</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>
            Sign in to explore store catalogs, compare products, and follow data
            updates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="login-form"
            onSubmit={async (e) => {
              setBusy(true);
              try {
                await onSubmit(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Unable to sign in</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter>
          <Button className="w-full" form="login-form" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </CardFooter>
      </Card>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LockKeyhole className="size-3" />
        Private workspace · North Macedonia
      </p>
    </main>
  );
}
