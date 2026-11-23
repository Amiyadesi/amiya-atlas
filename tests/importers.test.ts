import { describe, expect, it } from "vitest";
import { emptySnapshot, type VaultSnapshot } from "../src/lib/types";
import { parseCsv, decodeImportedFile } from "../src/domain/importers/csv";
import { parsePasswords } from "../src/domain/importers/passwords";
import { parseBitwarden } from "../src/domain/importers/bitwarden";
import { parseBills, reviseBillRow } from "../src/domain/importers/bills";
import {
  applyAssetImport,
  applyBillImport,
} from "../src/domain/importers/apply";
import { privateEntity } from "../src/domain/importers/assets";
import { validateLedger } from "../src/domain/ledger";
import { units } from "../src/domain/money";
const all = (p: { rows: { id: string }[] }) => ({
  rows: new Set(p.rows.map((r) => r.id)),
});
const secret = "NEVER_COPY_THIS";
describe("local CSV boundary", () => {
  it("preserves RFC fields, quoted line breaks, escaped quotes, empty tails and BOM", () => {
    expect(parseCsv('\uFEFFa,b,c\r\n"x,y","one\r\ntwo ""hi""",\r\n')).toEqual([
      ["a", "b", "c"],
      ["x,y", 'one\r\ntwo "hi"', ""],
    ]);
    expect(parseCsv('""')).toEqual([[""]]);
    for (const malformed of ['"open', 'a"b', '"a"tail'])
      expect(() => parseCsv(malformed)).toThrow(/引号/);
    expect(
      decodeImportedFile(new TextEncoder().encode("微信账单").buffer),
    ).toBe("微信账单");
  });
});
describe("credential-free asset previews", () => {
  it("links existing hubs, preserves distinct logins, strips secrets from previews AND saves", () => {
    const s = emptySnapshot(),
      mail = privateEntity("Email", "主邮箱", { address: "Me@Example.com" });
    s.entities.push(mail);
    const source = JSON.stringify({
      folders: [{ id: "f", name: "工作" }],
      items: [
        {
          type: 1,
          name: "Cloud",
          folderId: "f",
          favorite: true,
          login: {
            username: "me@example.com",
            password: secret,
            totp: secret,
            uris: [
              {
                uri:
                  "https://user:" +
                  secret +
                  "@EXAMPLE.org:443/private?token=" +
                  secret,
              },
            ],
          },
          notes: secret,
          fields: [{ value: secret }],
        },
        {
          type: 1,
          name: "Cloud",
          login: {
            username: "+1 (415) 555-0102",
            uris: [{ uri: "https://example.org/login" }],
          },
        },
        {
          type: 1,
          name: "Mail service",
          login: { username: "ME@example.com" },
        },
        {
          type: 3,
          name: "Travel",
          card: {
            brand: "Visa",
            number: "4111 1111 1111 1234",
            code: secret,
            cardholderName: secret,
          },
        },
        { type: 2, name: secret, notes: secret },
      ],
    });
    const p = parseBitwarden(source, s);
    expect(p.stripped).toBe(7);
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0].hub?.id).toBe(mail.id);
    expect(p.rows[0].entity.tags).toEqual(["工作", "⭐ 收藏"]);
    expect(p.rows[0].entity.fields.find((f) => f.key === "origin")?.value).toBe(
      "https://example.org",
    );
    const next = applyAssetImport(s, p, all(p));
    expect(s.entities).toHaveLength(1);
    expect(next.entities).toHaveLength(6);
    expect(next.relations).toHaveLength(3);
    expect(next.entities.find((e) => e.category === "Phone / SIM")?.name).toBe(
      "+14155550102",
    );
    expect(
      next.entities
        .find((e) => e.category === "Payment Card")
        ?.fields.map((f) => [f.key, f.value]),
    ).toEqual([
      ["brand", "Visa"],
      ["last4", "1234"],
    ]);
    expect(next.relations.every((r) => r.type === "REGISTERED_WITH")).toBe(
      true,
    );
    expect(JSON.stringify([p, next])).not.toContain(secret);
    expect(JSON.stringify([p, next])).not.toMatch(/4111[ -]?1111[ -]?1111[ -]?1234/);
    const again = parseBitwarden(source, next);
    expect(again.rows.every((r) => r.existing && !r.relation)).toBe(true);
    expect(applyAssetImport(next, again, all(again))).toEqual(next);
  });
  it("skips SECRET matches, enriches public accounts with missing links, only builds selected dependencies", () => {
    const s = emptySnapshot(),
      old = privateEntity("Account", "Original", {
        origin: "https://same.test",
        username: "m@test.org",
      });
    old.fields.push({
      ...old.fields[0],
      id: "secret",
      key: "note",
      value: secret,
      privacy: "SECRET",
    });
    s.entities.push(old, {
      ...privateEntity("Email", "m@test.org"),
      privacy: "SECRET",
    });
    const p = parseBitwarden(
      "folder,favorite,type,name,notes,fields,login_uri,login_username,login_password,login_totp\nWork,1,login,Renamed,note,field,https://same.test/a,m@test.org," +
        secret +
        "," +
        secret +
        "\n,,login,Other,,,https://b.test,other@test.org,,",
      s,
    );
    expect(p.stripped).toBe(4);
    expect(p.rows[0].entity.id).toBe(old.id);
    expect(JSON.stringify(p)).not.toContain(secret);
    const next = applyAssetImport(s, p, { rows: new Set([p.rows[0].id]) });
    expect(next.entities.length).toBe(3);
    expect(next.relations[0].sourceId).toBe(old.id);
    expect(next.entities.at(-1)?.privacy).toBe("PRIVATE");
    expect(next.entities[0].fields.at(-1)?.value).toBe(secret);
  });
  it.each([
    [
      "Chrome / Edge",
      "name,url,username,password,note",
      "A,https://a.test,m@test.org," + secret + "," + secret,
    ],
    [
      "Firefox",
      "url,username,password,httpRealm",
      "https://a.test,m@test.org," + secret + ",",
    ],
    [
      "Apple",
      "Title,URL,Username,Password,Notes,OTPAuth",
      "A,https://a.test,m@test.org," + secret + "," + secret + "," + secret,
    ],
    [
      "1Password",
      "Title,Url,Username,Password,OTPAuth,Tags,Notes",
      "A,https://a.test,m@test.org," +
        secret +
        "," +
        secret +
        ",Work," +
        secret,
    ],
    [
      "KeePass",
      "Account,Login Name,Password,Web Site,Comments",
      "A,m@test.org," + secret + ",https://a.test," + secret,
    ],
  ])(
    "reads %s metadata without retaining passwords or notes",
    (_, header, line) => {
      const p = parsePasswords(header + "\r\n" + line, emptySnapshot());
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].hub?.name).toBe("m@test.org");
      expect(p.rows[0].relation?.type).toBe("REGISTERED_WITH");
      expect(p.stripped).toBeGreaterThan(0);
      expect(JSON.stringify(p)).not.toContain(secret);
    },
  );
  it("enriches a legacy domain match without folding a second login into the first", () => {
    const s = emptySnapshot(),
      legacy = privateEntity("Account", "Example", {
        origin: "https://example.org",
      });
    s.entities.push(legacy);
    const csv =
      "name,url,username,password\nExample,https://example.org,one,secret\nExample,https://example.org,two,secret\nExample,https://unrelated.org,one,secret";
    const p = parsePasswords(csv, s),
      next = applyAssetImport(s, p, all(p));
    expect(next.entities).toHaveLength(3);
    expect(
      next.entities
        .find((e) => e.id === legacy.id)
        ?.fields.find((f) => f.key === "username")?.value,
    ).toBe("one");
    expect(legacy.fields.some((f) => f.key === "username")).toBe(false);
    const again = parsePasswords(csv, next);
    expect(again.rows.every((r) => r.duplicate)).toBe(true);
    expect(applyAssetImport(next, again, all(again))).toEqual(next);
  });
  it("fails closed on encrypted/invalid exports without echoing confidential input", () => {
    expect(() =>
      parseBitwarden('{"encrypted":true,"items":[]}', emptySnapshot()),
    ).toThrow(/未加密/);
    expect(() => parseBitwarden('{"' + secret, emptySnapshot())).toThrow(
      "Bitwarden JSON 格式无效",
    );
    expect(() => parsePasswords("not,my,format", emptySnapshot())).toThrow(
      /列头/,
    );
    expect(() =>
      parseBills(
        "name,url,username,password\nA,a,b," + secret,
        emptySnapshot(),
      ),
    ).toThrow(/密码管理器/);
  });
});
const wxHeader =
  "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号";
describe("bill imports", () => {
  it("parses native WeChat, skips duplicate orders and leaves excluded rows toggleable", () => {
    const s = emptySnapshot(),
      text =
        "微信支付账单明细\n微信昵称：测试\n" +
        wxHeader +
        '\n2026-10-03 11:30:00,商户消费,OpenAI,ChatGPT Plus,支出,"￥1,200.00",零钱,支付成功,000042\t\n2026-10-05 11:30:00,退款,OpenAI,退回,收入,¥2.00,零钱,已退款,043';
    const p = parseBills(
      decodeImportedFile(new TextEncoder().encode(text).buffer),
      s,
    );
    expect(p.format).toBe("wechat");
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0].transaction.idempotencyKey).toBe("import:wechat:000042");
    expect(p.rows[0].value.amount).toBe("1200.00");
    expect(p.rows[1].excluded).toBe("退款");
    expect(p.subscriptions).toHaveLength(1);
    const next = applyBillImport(s, p, {
      rows: new Set([p.rows[0].id]),
      subscriptions: new Set([p.subscriptions[0].entity.id]),
    });
    expect(next.transactions).toHaveLength(1);
    expect(next.entities[0].fields.map((f) => f.value)).toEqual([
      { amount: "1200.00", asset: "CNY" },
      "monthly",
    ]);
    validateLedger(next, s);
    expect(
      next.transactions![0].legs.reduce((n, l) => n + units(l.money), 0n),
    ).toBe(0n);
    const again = parseBills(text, next);
    expect(again.duplicateCount).toBe(1);
    expect(again.subscriptions).toHaveLength(0);
    const withRefund = applyBillImport(next, again, all(again));
    expect(withRefund.transactions).toHaveLength(2);
    validateLedger(withRefund, next);
  });
  it("decodes a real GB18030 byte sequence before reading Alipay headers; skips footer", () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        "1qe4trGmvbvS18P3z7gKvbvS18qxvOQsvbvS17fWwOAsvbvS17bUt70syczGt8u1w/csytUv1qcsvfC27izK1S+4tr/ut73KvSy9u9LX17TMrCy9u9LXtqm1pbrFCjIwMjYtMTAtMDMgMTI6MDA6MDAsss3S+yzQobPUteoszue3uSzWp7P2LDIyLjUwLNPgtu4svbvS17PJuaYsMDAwMQoyMDI2LTEwLTA0IDEyOjAwOjAwLM/7t9Esycy7pyzOtLi2v+4ssru8xsrV1qcsMTAuMDAs0+C27iy9u9LXudix1SwwMDAyCrmyvMYysco=",
        "base64",
      ),
    );
    const p = parseBills(decodeImportedFile(bytes.buffer), emptySnapshot());
    expect(p.format).toBe("alipay");
    expect(p.warnings).toEqual([]);
    expect(p.rows[0].transaction.payee).toBe("小吃店");
    expect(p.rows[0].transaction.idempotencyKey).toBe("import:alipay:0001");
    expect(p.rows[1].excluded).toBe("交易关闭");
  });
  it("supports custom mapping, exact decimals, overlap-safe occurrence keys and monthly discovery", () => {
    const s = emptySnapshot(),
      header = "when,amt,dir,shop,details,bucket,fund,ccy";
    const old = "2026/09/08,-19.99,debit,Book Club,monthly,阅读,Card,USD";
    const now = "2026/10/08,-19.99,debit,Book Club,monthly,阅读,Card,USD";
    const mapping = {
      date: "when",
      amount: "amt",
      direction: "dir",
      payee: "shop",
      note: "details",
      category: "bucket",
      account: "fund",
      asset: "ccy",
    };
    const p = parseBills([header, old, now, now].join("\n"), s, mapping);
    expect(new Set(p.rows.map((r) => r.transaction.idempotencyKey)).size).toBe(
      3,
    );
    expect(p.subscriptions[0].entity.name).toBe("Book Club");
    expect(p.accounts.map((a) => a.name)).toEqual(["Card", "阅读"]);
    const next = applyBillImport(s, p, all(p));
    expect(next.entities).toHaveLength(0);
    validateLedger(next);
    const overlap = parseBills([header, now, now].join("\n"), next, mapping);
    expect(overlap.duplicateCount).toBe(2);
    expect(applyBillImport(next, overlap, all(overlap))).toEqual(next);
    expect(() => applyBillImport({ ...next, revision: 1 }, p, all(p))).toThrow(
      /重新预览/,
    );
  });
  it("discovers recurring merchants across separate monthly imports", () => {
    const s = emptySnapshot(),
      header = "date,amount,payee";
    const p = parseBills(header + "\n2026-09-08,-8.50,Reading Club", s);
    const next = applyBillImport(s, p, all(p));
    expect(p.subscriptions).toHaveLength(0);
    expect(
      parseBills(
        header + "\n2026-10-08,-8.50,Reading Club",
        next,
      ).subscriptions.map((c) => c.entity.name),
    ).toEqual(["Reading Club"]);
  });
  it("requires a date order for ambiguous bank dates and keeps source currency/sign conventions", () => {
    const s = emptySnapshot(),
      csv = "date,amount,payee\n10/08/2026,($10.50),Client";
    expect(parseBills(csv, s).rows).toHaveLength(0);
    const [row] = parseBills(
      csv,
      s,
      {},
      { dateOrder: "mdy", currency: "USD", positiveExpense: true },
    ).rows;
    expect(row.value).toEqual({ amount: "10.50", asset: "USD" });
    expect(row.transaction).toMatchObject({
      kind: "INCOME",
      occurredAt: "2026-10-08",
    });
  });
  it("prefers a successful order over an earlier failed copy within the file", () => {
    const p = parseBills(
      wxHeader +
        "\n2026-01-10,消费,Store,书,支出,5,零钱,支付失败,001\n2026-01-10,消费,Store,书,支出,5,零钱,支付成功,001",
      emptySnapshot(),
    );
    expect(p.rows.map((r) => r.duplicate)).toEqual([true, false]);
    expect(p.duplicateCount).toBe(1);
  });
  it("rejects malformed amounts, impossible dates and excess precision without inventing transactions", () => {
    const p = parseBills(
      'date,amount,payee\n2026-02-30,-1,test\n2026-05-01,-1.001,test\n2026-05-01,"-1,2",test\n2026-05-01,0,test',
      emptySnapshot(),
    );
    expect(p.rows).toEqual([]);
    expect(p.warnings).toHaveLength(4);
  });
  it("handles split debit/credit columns and excludes internal transfers", () => {
    const s: VaultSnapshot = emptySnapshot(),
      p = parseBills(
        "Date,Outflow,Inflow,Payee,Type\n2026-01-10,0,5,Client,income\n2026-01-11,2,0,Vendor,expense\n2026-01-12,3,0,Bank,transfer",
        s,
      );
    expect(p.rows.map((r) => r.transaction.kind)).toEqual([
      "INCOME",
      "SPEND",
      "TRANSFER",
    ]);
    expect(p.rows[2].excluded).toBeTruthy();
    expect(() => applyBillImport(s, p, all(p))).toThrow(/转入账户/);
    const fixed = reviseBillRow(
      s,
      p,
      p.rows[2].id,
      "TRANSFER",
      "Bank A",
      "Bank B",
    );
    validateLedger(applyBillImport(s, fixed, all(fixed)), s);
  });
});
