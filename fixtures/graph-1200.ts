import type { Entity, Relation, VaultSnapshot } from "../src/lib/types";

export function largeGraphFixture(): VaultSnapshot {
  const createdAt = "2026-10-01T00:00:00Z";
  const types = ["Account", "Email", "SIM", "Payment Card", "Subscription", "Server", "Domain", "Project", "Repository", "Account"];
  const names = ["GitHub 工作", "联络邮箱", "备用号码", "付款卡", "软件订阅", "计算节点", "网站域名", "个人项目", "代码仓库", "Google 个人"];
  const entities: Entity[] = Array.from({ length: 1200 }, (_, i) => ({
    id: `fixture-${i}`, name: `${names[i % 10]} ${String(Math.floor(i/10)+1).padStart(3,"0")}`,
    category: types[i % 10], status: "ACTIVE", privacy: "PRIVATE", tags: ["脱敏示例"], fields: [], createdAt, updatedAt: createdAt,
  }));
  const relations: Relation[] = [];
  const link = (source:number, target:number, type:string) => relations.push({
    id: `fixture-rel-${relations.length}`, sourceId: entities[source].id,
    targetId: entities[target].id, type, privacy: "PRIVATE", createdAt,
  });
  // Forty disconnected assets exercise full-library display without inventing links.
  for (let i=0;i<1160;i++) {
    const group=Math.floor(i/30)*30, kind=i%10;
    if(kind===0||kind===9) link(i,group+1,"REGISTERED_WITH");
    else if(kind===4) link(i,group+3,"PAID_BY");
    else if(kind===6) link(i,group+5,"HOSTED_ON");
    else if(kind===8) link(i,group+7,"SOURCE_IN");
    else if(kind===2) link(group+1,i,"RECOVERS_WITH");
    else if(kind===7) link(i,group+5,"DEPENDS_ON");
    if(i%31===0&&i+31<1160) link(i,i+31,"RELATED_TO");
  }
  return {revision:0,entities,relations,events:[]};
}
