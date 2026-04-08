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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (user) {
      router.replace("/");
    }
  }, [router, user]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await login(email, password);
      router.replace("/");
    } catch {
      return;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="panel-surface overflow-hidden p-10">
          <div className="max-w-lg">
            <p className="font-display text-5xl leading-tight text-ink">Maia Axon</p>
            <p className="mt-5 text-base leading-8 text-muted">
              Query multimodal engineering libraries, compare document methods, and open evidence directly
              from inline citations.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                "Group-scoped knowledge",
                "Scanned PDF evidence",
                "Math-aware responses",
                "Clickable source highlights",
              ].map((item) => (
                <div key={item} className="rounded-[24px] border border-line bg-white/55 px-4 py-4 text-sm">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel-surface p-8">
          <p className="font-display text-3xl text-ink">Sign In</p>
          <p className="mt-3 text-sm leading-7 text-muted">
            Internal access only. Use the backend-issued account credentials.
          </p>
          <form className="mt-8 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={isLoading}>
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
