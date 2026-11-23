export function decodeImportedFile(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
  }
}

// Preserve field contents; callers decide which columns can be trimmed.
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') value += c;
      else if (text[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === "," || c === "\r" || c === "\n") {
      row.push(value);
      value = "";
      closed = false;
      if (c !== ",") {
        rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (c === '"' && !value && !closed) quoted = true;
    else {
      if (closed || c === '"')
        throw new Error("CSV 引号格式错误（第 " + (rows.length + 1) + " 行）");
      value += c;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  if (row.length || value || closed) rows.push([...row, value]);
  return rows;
}
