import { test, expect } from "vitest";
import { graphData, relatedIds, nodeVolume } from "../src/features/graph/layout";
import { demoSnapshot } from "../src/lib/demo";

test("all 1200 assets stay in 3D, including disconnected ones; secret data stays out", () => {
  const s = demoSnapshot();
  s.entities = Array.from({ length: 1200 }, (_, i) => ({
    ...s.entities[0],
    id: `asset-${i}`,
    name: `Asset ${i}`,
  }));
  s.entities.push({ ...s.entities[0], id: "secret", privacy: "SECRET" });
  s.relations = [
    { ...s.relations[0], sourceId: "asset-0", targetId: "asset-1" },
    {
      ...s.relations[0],
      id: "private",
      sourceId: "asset-0",
      targetId: "secret",
    },
  ];
  const full = graphData(s);
  expect(full.nodes).toHaveLength(1200);
  expect(full.links).toHaveLength(1);
  expect(new Set(full.nodes.map((n) => n.z)).size).toBeGreaterThan(1100);
  expect(full.nodes.every((n) => Number.isFinite(n.x + n.y + n.z))).toBe(true);
  expect(relatedIds(full.links, "asset-0")).toEqual(
    new Set(["asset-0", "asset-1"]),
  );
  expect(full.nodes.at(-1)?.id).toBe("asset-1199");
  expect(graphData(s, ["PAID_BY"]).nodes).toHaveLength(1200);
});

test("node size grows beyond twenty edges and remains stable under a relation filter",()=>{
  const s=demoSnapshot();
  s.entities[0].tags=["⭐ 收藏"];
  const full=graphData(s),filtered=graphData(s,["PAID_BY"]);
  expect(full.nodes[0].icon).toBe("⭐");
  expect(filtered.nodes[0].degree).toBe(full.nodes[0].degree);
  const radii=[0,1,20,100,1000].map(n=>Math.cbrt(nodeVolume(n)));
  expect(radii.every((r,i)=>i===0||r>radii[i-1])).toBe(true);
  expect(radii[3]).toBeGreaterThan(radii[0]*3);
});
