import { error } from '@sveltejs/kit';
export const prerender = true;
export const entries = () => ['', 'pricing', 'download', 'guide', 'login', 'account', 'device', 'success', 'privacy', 'refunds'].flatMap(page => [{ ...(page ? { page } : {}) }, { lang: 'en', ...(page ? { page } : {}) }]);
export const load = ({ params }: { params: { lang?: string; page?: string } }) => {
  const page = params.page || 'home';
  if (!['home', 'pricing', 'download', 'guide', 'login', 'account', 'device', 'success', 'privacy', 'refunds'].includes(page)) error(404, '页面不存在');
  return { page, en: params.lang === 'en' };
};
