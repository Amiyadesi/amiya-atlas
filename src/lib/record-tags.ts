export const TAG_ICONS = ["", "⭐", "📌", "❤️", "🔒", "💼", "🔔", "⚡"];
const leadingIcon = (tag: string) => /^(\S+)\s+/.exec(tag)?.[1] ?? "";
const hasIcon = (value: string) => /\p{Extended_Pictographic}/u.test(value);
export function tagName(tag: string): string {
  const icon = leadingIcon(tag);
  return (hasIcon(icon) ? tag.slice(icon.length) : tag).trim();
}
export const isFavorite = (tag: string) =>
  /^(收藏|favorite|favourite)$/i.test(tagName(tag));
export function tagIcon(tag: string): string {
  const icon = leadingIcon(tag);
  return hasIcon(icon) ? icon : isFavorite(tag) ? "⭐" : "";
}
export const withTagIcon = (tag: string, icon: string) =>
  [icon, tagName(tag)].filter(Boolean).join(" ");
export const entityIcon = (tags: string[]) =>
  tags.map(tagIcon).find(Boolean) ?? "";
