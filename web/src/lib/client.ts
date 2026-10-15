import { createAuthClient } from "better-auth/client";
import {
  emailOTPClient,
  deviceAuthorizationClient,
} from "better-auth/client/plugins";
export const auth = createAuthClient({
  baseURL:
    typeof window === "undefined"
      ? "https://atlas.sayori.org"
      : window.location.origin,
  plugins: [emailOTPClient(), deviceAuthorizationClient()],
});
export type Balance = {
  monthly: number;
  topup: number;
  total: number;
  blocked: boolean;
  unlimited: boolean;
  internalBalanceUsd: number;
  canChooseModels: boolean;
  selectedModel: string;
  models: Array<{ id: string; name: string }>;
  subscription: {
    status: string;
    ends_at: number | null;
    cancels: number;
  } | null;
};
export type Features = {
  email: boolean;
  emailDomains: string[];
  github: boolean;
  google: boolean;
  cloud: boolean;
  billing: boolean;
  downloadUrl: string | null;
  version: string;
};
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await res.json();
  if (!res.ok)
    throw Object.assign(
      new Error(value.message || "服务暂时不可用，请稍后重试"),
      { code: value.code },
    );
  return value as T;
}
