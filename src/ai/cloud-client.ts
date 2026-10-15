import { invoke } from "../lib/runtime";
import type { CloudInput } from "./cloud-contract";
import { assertNoSecrets, cloudInputSchema } from "./cloud-contract";
const retries = new Map<string, CloudInput>();
export function clearCloudRetries() {
  retries.clear();
}
export async function cloudResult(
  payload: Omit<CloudInput, "requestId">,
): Promise<unknown> {
  assertNoSecrets(payload.text);
  const key = JSON.stringify({ ...payload, now: "" });
  const input =
    retries.get(key) ??
    cloudInputSchema.parse({ ...payload, requestId: crypto.randomUUID() });
  retries.set(key, input);
  try {
    const value = await invoke<{ result: unknown }>("cloud_request", {
      path: "/api/account/ai",
      body: input,
    });
    retries.delete(key);
    return value.result;
  } catch (error) {
    throw new Error(typeof error === "string" ? error : "云请求失败，请重试。");
  }
}
