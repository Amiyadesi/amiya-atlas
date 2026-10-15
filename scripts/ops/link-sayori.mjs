import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const contentRoot = resolve('../sayori-articles');
const origin = 'https://atlas.sayori.org/';
const changes = [];
for (const lang of ['zh', 'en']) {
  const zh = lang === 'zh';
  const href = origin + (zh ? '' : 'en/');
  const file = resolve(contentRoot, 'home/surface.' + lang + '.json');
  const home = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(home.services?.items)) throw new Error('Home services contract missing');
  if (!home.services.items.some(item => item.href === href)) home.services.items.unshift({
    index: 'RELAKEEP', title: zh ? '络笺 Relakeep' : 'Relakeep',
    desc: zh ? '本地加密地记录账号、邮箱、电话卡、订阅和付款卡，以及它们之间的关系。' : 'An encrypted local memory for accounts, email, SIMs, subscriptions, payment cards and their connections.',
    href,
  });
  changes.push([file, home]);
  const navFile = resolve(contentRoot, 'nav/nav.' + lang + '.json');
  const nav = JSON.parse(readFileSync(navFile, 'utf8'));
  const category = nav.categories.find(item => item.id === 'webmaster');
  if (!category) throw new Error('Navigation category missing');
  if (!category.entries.some(item => item.url === href)) category.entries.push({
    category: 'webmaster', name: zh ? '络笺 Relakeep' : 'Relakeep', url: href,
    desc: zh ? '账号、邮箱、电话卡、订阅和付款卡的本地加密关系管理工具。' : 'A local encrypted memory for digital assets and their relationships.',
    usage: zh ? '下载 Windows 版；先录入几项常用资产，再补关联。本地模型与自带 API Key 免费。' : 'Download the Windows app. Start with a few assets and add their connections. Local models and BYOK are free.',
    license: zh ? '本地功能免费；托管云 AI 验收完成后单独收费。' : 'Local features are free; hosted cloud AI will be billed separately after acceptance testing.',
    added: '2026-10-13',
  });
  changes.push([navFile, nav]);
}
const file = resolve(contentRoot, 'site/navigation.json');
const navigation = JSON.parse(readFileSync(file, 'utf8'));
const menu = navigation.links.find(item => item.name === '更多');
if (!menu?.children) throw new Error('Blog menu missing');
if (!menu.children.some(item => item.url === origin)) menu.children.push({
  name: '络笺 Relakeep', url: origin, external: true, icon: 'material-symbols:account-tree',
});
changes.push([file, navigation]);
for (const [file, value] of changes) writeFileSync(file, JSON.stringify(value, null, file.endsWith('navigation.json') ? 2 : '\t') + '\n');
console.log('Relakeep links added to public Home, Navigation and Blog content');
