import { Suspense } from "react";
import { ShieldCheck } from "lucide-react";
import { signInAction } from "./actions";

const ERRORS: Record<string, string> = {
  missing: "Email and password are required.",
  invalid: "Invalid credentials, or this email is not an admin yet.",
  denied: "Access denied — this account is not on the admin allowlist.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; denied?: string }>;
}) {
  const params = await searchParams;
  const errorKey = params.denied ? "denied" : params.error;
  const errorMsg = errorKey ? ERRORS[errorKey] ?? "Something went wrong." : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="glass-card w-full max-w-sm p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-soft text-teal">
            <ShieldCheck size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-50">
              Sensoria Admin
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              aacsensoria.id control plane
            </p>
          </div>
        </div>

        {errorMsg ? (
          <p className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {errorMsg}
          </p>
        ) : null}

        <form action={signInAction} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="admin@aacsensoria.id"
              className="glass-input"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="glass-input"
            />
          </div>
          <button type="submit" className="btn-teal w-full justify-center">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
