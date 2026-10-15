import {
  createProvider,
  type ChatRequest,
  type Transport,
} from "../../src/ai/provider";
import {
  assertNoSecrets,
  cloudInputSchema,
  cloudSnapshot,
  type CloudInput,
} from "../../src/ai/cloud-contract";
import {parseFinance,parseFinanceQuery} from '../../src/ai/finance';
export const MODEL = "qwen3.7-flash-2026-07-15";
export const MODEL_ORIGIN =
  "https://dashscope-intl.ap-southeast-1.aliyuncs.com/compatible-mode/v1";
export function cloudModel(key: string, transport?: Transport, baseUrl = MODEL_ORIGIN, model = MODEL) {
  const send: Transport =
    transport ??
    (async ({ messages, schema }: ChatRequest) => {
      const response = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(55000),
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0.1,
          max_tokens: 4096,
          enable_thinking: false,
          response_format: {
            type: "json_schema",
            json_schema: { name: "relakeep_result", strict: false, schema },
          },
        }),
      });
      if (!response.ok) throw new Error("MODEL_UNAVAILABLE");
      const responseText = await response.text();
      if (responseText.length > 200000)
        throw new Error("MODEL_OUTPUT_TOO_LARGE");
      const value = JSON.parse(responseText);
      const result = value.choices?.[0]?.message?.content;
      if (typeof result !== "string") throw new Error("MODEL_INVALID_OUTPUT");
      return result;
    });
  const provider = createProvider(
    {
      kind: "openai-compatible",
      baseUrl,
      model,
      apiKey: key,
      responseFormat: "json_schema",
    },
    send,
  );
  return async (raw: CloudInput) => {
    const input = cloudInputSchema.parse(raw);
    assertNoSecrets(input.text);
    const snapshot = cloudSnapshot(input);
    const config={kind:'openai-compatible' as const,baseUrl,model,apiKey:key,responseFormat:'json_schema' as const};
    if(input.kind==='ledger')return parseFinance(config,input.text,snapshot,send,input.now);
    if(input.kind==='ledger-query')return parseFinanceQuery(config,input.text,snapshot,send,input.now);
    return input.kind === "capture"
      ? provider.parseCapture(input.text, { snapshot, now: input.now })
      : provider.parseQuery(input.text);
  };
}
