import { mount } from "svelte";
import ExploreCanvas from "../src/features/graph/ExploreCanvas.svelte";
import "../src/styles.css";
import { largeGraphFixture } from "./graph-1200";

document.body.style.cssText="margin:0;padding:24px;font-family:system-ui,sans-serif;background:#f2f4f8";
const target=document.getElementById("fixture")!;
const heading=document.createElement("h1");
heading.textContent="络笺 · 1,200 资产脱敏预览";
heading.style.cssText="font-size:20px;margin:0 0 18px;font-weight:600";
document.body.prepend(heading);
mount(ExploreCanvas,{target,props:{snapshot:largeGraphFixture(),onOpen:(id:string)=>alert(`示例资产 ${id}`)}});
