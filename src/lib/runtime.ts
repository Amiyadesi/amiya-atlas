import { invoke as nativeInvoke } from "@tauri-apps/api/core";
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isHttpHost = typeof document !== "undefined" && document.documentElement.hasAttribute("data-relakeep-host");
export const isSelfhost = typeof document !== "undefined" && document.documentElement.hasAttribute("data-relakeep-selfhost");
export const isPersistent = isTauri || isHttpHost;
export const isMobile = isTauri && /Android/i.test(navigator.userAgent);
export const isWindows = isTauri && /Windows/i.test(navigator.userAgent);

const fragment = typeof window !== "undefined" ? new URLSearchParams(window.location.hash.slice(1)) : new URLSearchParams();
if (isHttpHost && fragment.has("access")) {
  sessionStorage.setItem("relakeep-access", fragment.get("access")!);
  history.replaceState(null, "", location.pathname);
}
export async function hasWebAccess() {
  if (isSelfhost) { const response = await fetch("/api/auth/get-session"); if (!response.ok) throw new Error("无法连接登录服务"); return !!(await response.json())?.user; }
  return !isHttpHost || !!sessionStorage.getItem("relakeep-access");
}
export function setWebAccess(token: string) { sessionStorage.setItem("relakeep-access", token.trim()); }
export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) return nativeInvoke<T>(command, args);
  if (!isHttpHost) throw new Error("此操作需要应用或本机网页入口");
  const response = await fetch("/api/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(!isSelfhost ? { "Authorization": `Bearer ${sessionStorage.getItem("relakeep-access") ?? ""}` } : {}) },
    body: JSON.stringify({ command, args }),
  });
  if (response.status === 401) { sessionStorage.removeItem("relakeep-access"); throw new Error(isSelfhost ? "登录已过期，请重新登录" : "访问口令无效"); }
  if (!response.ok) throw new Error(`网页服务返回 ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}
