<script lang="ts">
  let { en = false } = $props<{ en?: boolean }>();
  const t = (zh: string, english: string) => en ? english : zh;
  let selected = $state('google');
  const records = [
    { id: 'email', name: ['主邮箱', 'Primary email'], type: ['邮箱', 'Email'], icon: '@', x: 13, y: 12, tint: 'blue', detail: ['hello@example.invalid', 'hello@example.invalid'] },
    { id: 'google', name: ['Google 主账号', 'Google account'], type: ['网站账号', 'Account'], icon: 'G', x: 46, y: 32, tint: 'violet', detail: ['2024 年 9 月注册', 'Created September 2024'] },
    { id: 'sim', name: ['备用号码', 'Backup SIM'], type: ['电话卡', 'SIM'], icon: 'S', x: 9, y: 57, tint: 'yellow', detail: ['号码尾号 0826', 'Number ending in 0826'] },
    { id: 'subscription', name: ['Google One', 'Google One'], type: ['订阅', 'Subscription'], icon: 'O', x: 60, y: 67, tint: 'pink', detail: ['2027 年 9 月续费', 'Renews September 2027'] },
    { id: 'card', name: ['日常付款卡', 'Everyday card'], type: ['付款卡', 'Payment card'], icon: 'C', x: 63, y: 5, tint: 'mint', detail: ['尾号 1234', 'Ending in 1234'] },
  ];
  const edges = [
    { source: 'email', target: 'google', d: 'M150 127 C150 235 390 135 390 251', label: ['注册邮箱', 'Registration email'] },
    { source: 'sim', target: 'google', d: 'M126 388 C240 388 179 251 288 251', label: ['找回号码', 'Recovery number'] },
    { source: 'google', target: 'subscription', d: 'M390 293 C390 349 485 353 485 428', label: ['关联订阅', 'Subscription'] },
    { source: 'card', target: 'subscription', d: 'M499 93 C657 93 574 484 486 484', label: ['支付订阅', 'Payment'] },
  ];
  const label = (value: string[]) => value[en ? 1 : 0];
  let record = $derived(records.find(r => r.id === selected)!);
  let relations = $derived(edges.filter(e => e.source === selected || e.target === selected));
</script>

<div class="relation-atlas">
  <div class="atlas-drawing">
    <svg class="thread-map" viewBox="0 0 620 560" fill="none" aria-hidden="true">
      <path class="loose-thread" d="M-10 183 C67 183 2 289 88 281 C158 274 181 472 266 504 C308 520 290 565 254 566" />
      <path class="loose-thread" d="M604-14 C561 11 619 74 575 147" />
      <circle cx="575" cy="147" r="5" fill="#b2b5d3"/>
      {#each edges as edge}<path class="asset-thread" class:lit={edge.source === selected || edge.target === selected} d={edge.d}/>{/each}
      <path class="pencil-loop" d="M261 246 C251 175 419 154 480 201 C525 236 468 327 370 326 C276 325 238 277 259 231"/>
      <path d="m535 320 10 4-3 13m-7-13 19-12" stroke="#8486ab" stroke-width="1.5"/>
    </svg>
    {#each records as item}
      <button class="asset-slip {item.tint}" class:chosen={selected === item.id} style:left="{item.x}%" style:top="{item.y}%" aria-pressed={selected === item.id} onclick={() => selected = item.id}>
        <span class="slip-pin" aria-hidden="true"></span>
        <span class="slip-type">{label(item.type)}</span>
        <span class="slip-name"><span class="slip-icon" aria-hidden="true">{item.icon}</span><strong>{label(item.name)}</strong></span>
        <span class="slip-detail">{label(item.detail)}</span>
      </button>
    {/each}
    <span class="drawing-caption">{t('点一张笺，看看它连着什么', 'Pick a note. Follow its connections.')}</span>
  </div>
  <div class="atlas-inspector" aria-live="polite">
    <span class="inspector-name">{label(record.name)}</span>
    <div>{#each relations as relation}{@const target = records.find(r => r.id === (relation.source === selected ? relation.target : relation.source))!}
      <button onclick={() => selected = target.id}><span>{label(relation.label)}</span><strong>{label(target.name)}</strong></button>
    {/each}</div>
    <small>{t('虚构示例', 'Illustrative data')}</small>
  </div>
</div>
