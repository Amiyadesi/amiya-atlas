export const emailDomains = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "qq.com", "foxmail.com", "163.com", "126.com",
  "yahoo.com", "proton.me", "protonmail.com",
];

export function allowsEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && parts[0].length > 0 && emailDomains.includes(parts[1]);
}
