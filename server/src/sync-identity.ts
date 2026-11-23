import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export type SyncTicket = {
  iss: string;
  aud: string;
  serverId: string;
  userId: string;
  exp: number;
  nonce: string;
};
const issuer = "https://atlas.sayori.org";
export function syncSigner(key: Buffer) {
  const seed = createHmac("sha256", key)
    .update("relakeep sync tickets v1")
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    publicKey,
    issue(ticket: Omit<SyncTicket, "iss">) {
      const payload = Buffer.from(
        JSON.stringify({ ...ticket, iss: issuer }),
      ).toString("base64url");
      return (
        payload +
        "." +
        sign(null, Buffer.from(payload), privateKey).toString("base64url")
      );
    },
  };
}
export function verifySyncTicket(
  token: string,
  publicKey: string,
  binding: { url: string; serverId: string; userId: string },
  now = Date.now(),
): SyncTicket {
  if (typeof token !== "string" || token.length > 4096)
    throw new Error("连接授权无效");
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !verify(
      null,
      Buffer.from(parts[0]),
      publicKey,
      Buffer.from(parts[1], "base64url"),
    )
  )
    throw new Error("连接授权无效");
  const ticket = JSON.parse(
    Buffer.from(parts[0], "base64url").toString(),
  ) as SyncTicket;
  if (
    ticket.iss !== issuer ||
    ticket.aud !== binding.url ||
    ticket.serverId !== binding.serverId ||
    ticket.userId !== binding.userId ||
    !Number.isSafeInteger(ticket.exp) ||
    ticket.exp <= now ||
    ticket.exp > now + 120_000 ||
    !/^[a-f0-9]{32}$/.test(ticket.nonce)
  )
    throw new Error("连接授权已失效，请重试");
  return ticket;
}
