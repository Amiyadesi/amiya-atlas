import { readonly, writable } from "svelte/store";

type Options = {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
};
type Input = {
  label: string;
  type?: "password" | "text";
  validate?: (value: string) => string;
};
type Request = Options & {
  input?: Input;
  resolve: (value: string | null) => void;
};
const pending: Request[] = [];
const current = writable<Request | null>(null);
export const activeDialog = readonly(current);

function ask(options: Options, input?: Input) {
  return new Promise<string | null>((resolve) => {
    pending.push({ ...options, input, resolve });
    if (pending.length === 1) current.set(pending[0]);
  });
}
export async function confirmDialog(options: Options) {
  return (await ask(options)) !== null;
}
export function promptDialog(options: Options & { input: Input }) {
  return ask(options, options.input);
}
export function finishDialog(value: string | null) {
  const request = pending.shift();
  current.set(pending[0] ?? null);
  request?.resolve(value);
}
export function cancelDialogs() {
  for (const request of pending.splice(0)) request.resolve(null);
  current.set(null);
}
