const HOST = 'org.sayori.atlas';
const pageEl = document.getElementById('page');
const identityEl = document.getElementById('identity');
const captureEl = document.getElementById('capture');
const errorEl = document.getElementById('error');
let page;

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendNativeMessage(HOST, message, response => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) reject(new Error('请打开并解锁 Atlas')); else if (!response?.ok) reject(new Error(response?.error || 'Atlas 连接失败')); else resolve(response.data);
  }));
}

async function load() {
  try {
    [page] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!page?.url || !/^https?:\/\//i.test(page.url)) throw new Error('当前页面不支持捕获');
    pageEl.textContent = `${page.title || '未命名网页'}\n${new URL(page.url).origin}`;
    const result = await send({ action: 'prepare_capture', title: page.title || '', url: page.url, favicon: page.favIconUrl });
    page = { ...page, url: result.page?.url || page.url };
    identityEl.replaceChildren();
    for (const identity of result.identities || []) { const option = document.createElement('option'); option.value = identity.id; option.textContent = `${identity.name} · ${identity.category}`; identityEl.append(option); }
    captureEl.disabled = !identityEl.value;
  } catch (error) { errorEl.textContent = error.message; }
}

identityEl.addEventListener('change', () => { captureEl.disabled = !identityEl.value; });
captureEl.addEventListener('click', async () => {
  captureEl.disabled = true; errorEl.textContent = '';
  try { await send({ action: 'commit_capture', title: page.title || '', url: page.url, favicon: page.favIconUrl, identity_id: identityEl.value }); captureEl.textContent = '已加入 Atlas'; }
  catch (error) { errorEl.textContent = error.message; captureEl.disabled = false; }
});
load();
