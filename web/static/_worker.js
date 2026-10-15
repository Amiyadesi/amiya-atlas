export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if(!env.BACKEND_URL||!env.PROXY_SECRET) return Response.json({message:'云服务配置中，本地功能可继续使用。'},{status:503,headers:{'cache-control':'no-store'}});
  const target=new URL(env.BACKEND_URL+url.pathname+url.search);
  if(target.protocol!=='https:') return new Response('Invalid origin',{status:503});
  const headers=new Headers(request.headers);
  headers.delete('host');headers.delete('x-relakeep-proxy');headers.set('x-relakeep-proxy',env.PROXY_SECRET);
  headers.set('x-forwarded-host',url.host);headers.set('x-forwarded-proto','https');
  if(request.headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip',request.headers.get('cf-connecting-ip'));
  const response=await fetch(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(url.pathname==='/api/account/ai'?145000:30000)}).catch(()=>null);
  if(!response) return Response.json({message:'云连接中断。请稍后用原请求重试，重复请求不会再次扣费。'},{status:502,headers:{'cache-control':'no-store'}});
  const out=new Headers(response.headers);out.set('cache-control','no-store');
  out.delete('access-control-allow-origin');out.delete('access-control-allow-credentials');
  return new Response(response.body,{status:response.status,headers:out});
 }
};
