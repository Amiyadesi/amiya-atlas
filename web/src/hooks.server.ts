import type { Handle } from "@sveltejs/kit";

export const handle: Handle = ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace("%relakeep.lang%", event.params.lang === "en" ? "en" : "zh-CN"),
  });
