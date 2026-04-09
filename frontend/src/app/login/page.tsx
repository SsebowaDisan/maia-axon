"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/authStore";

export default function LoginPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const login = useAuthStore((state) => state.login);
  const isLoading = useAuthStore((state) => state.isLoading);
  const error = useAuthStore((state) => state.error);
  const [identifier, setIdentifier] = useState("admin");
  const [password, setPassword] = useState("admin");

  useEffect(() => {
    if (user) {
      router.replace("/");
    }
  }, [router, user]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await login(identifier, password);
      router.replace("/");
    } catch {
      return;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-10">
      <div className="w-full max-w-md rounded-[32px] border border-white/70 bg-white/82 p-8 shadow-[0_32px_80px_rgba(15,23,42,0.12)] backdrop-blur-xl">
        <div className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-[0.22em] text-muted/80">Maia Axon</p>
          <p className="font-display text-4xl font-semibold tracking-[-0.04em] text-ink">Sign In</p>
          <p className="text-sm leading-6 text-muted">
            Default access is ready. Use <span className="font-semibold text-ink">admin</span> for the
            username and <span className="font-semibold text-ink">admin</span> for the password.
          </p>
        </div>

        <form className="mt-8 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <Input
            type="text"
            placeholder="Username"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button
            type="submit"
            className="h-12 w-full rounded-full bg-ink text-white shadow-[0_20px_40px_rgba(19,33,52,0.18)] hover:bg-ink/92"
            disabled={isLoading}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
        <p className="mt-5 text-center text-xs tracking-[0.08em] text-muted/80">
          Username: <span className="text-ink">admin</span> | Password: <span className="text-ink">admin</span>
        </p>
      </div>
    </div>
  );
}
