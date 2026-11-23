import type { NodeObject, LinkObject } from "3d-force-graph";
import type { Entity, Relation, VaultSnapshot } from "../../lib/types";
import { categoryGroup } from "../../lib/record-labels";
import { entityIcon } from "../../lib/record-tags";

export const graphColors: Record<string, string> = {
  账号: "#89afff",
  通信: "#5cd4c2",
  资金: "#e9b967",
  服务: "#cf9df0",
  设施: "#ee958a",
  项目: "#a7c978",
  其他: "#aab7cc",
};
export interface GraphNode extends NodeObject {
  id: string;
  entity: Entity;
  degree: number;
  icon: string;
  color: string;
  x: number;
  y: number;
  z: number;
}
export interface GraphLink extends LinkObject<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  relation: Relation;
}
export const endpointId = (value: string | GraphNode) =>
  typeof value === "string" ? value : value.id;

export function graphData(snapshot: VaultSnapshot, types?: string[]) {
  const entities = snapshot.entities.filter((e) => e.privacy !== "SECRET");
  const ids = new Set(entities.map((e) => e.id));
  const allRelations = snapshot.relations.filter(
    (r) => r.privacy !== "SECRET" && ids.has(r.sourceId) && ids.has(r.targetId),
  );
  const degrees = new Map<string, number>();
  for (const r of allRelations) {
    degrees.set(r.sourceId, (degrees.get(r.sourceId) ?? 0) + 1);
    degrees.set(r.targetId, (degrees.get(r.targetId) ?? 0) + 1);
  }
  const radius = Math.max(85, Math.cbrt(entities.length) * 34);
  const nodes: GraphNode[] = entities.map((entity, i) => {
    const y = 1 - (2 * (i + 0.5)) / entities.length;
    const ring = Math.sqrt(1 - y * y),
      angle = i * Math.PI * (3 - Math.sqrt(5));
    return {
      id: entity.id,
      entity,
      degree: degrees.get(entity.id) ?? 0,
      icon: entityIcon(entity.tags),
      color: graphColors[categoryGroup(entity.category)],
      x: radius * ring * Math.cos(angle),
      y: radius * y,
      z: radius * ring * Math.sin(angle),
    };
  });
  const links: GraphLink[] = allRelations
    .filter((r) => !types || types.includes(r.type))
    .map((relation) => ({
      source: relation.sourceId,
      target: relation.targetId,
      relation,
    }));
  return { nodes, links };
}

// nodeVal is volume; cube the desired radius so high-degree nodes stay visibly larger.
export const nodeVolume = (degree: number) =>
  (1 + Math.log2(degree + 1) * 0.45) ** 3;

export function relatedIds(links: GraphLink[], focus: string) {
  const ids = new Set([focus]);
  for (const link of links) {
    const source = endpointId(link.source),
      target = endpointId(link.target);
    if (source === focus) ids.add(target);
    if (target === focus) ids.add(source);
  }
  return ids;
}
