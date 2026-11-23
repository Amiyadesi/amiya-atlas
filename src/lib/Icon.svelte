<script lang="ts" context="module">
  const paths = {
    Home:"M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 3v4m8-4v4M4 10h16m-12 5h3",
    Memory:"m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
    Ledger:"M4 4v14a2 2 0 0 0 2 2h15M8 15v-4m5 4V7m5 8v-6",
    Explore:"M8 7a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm12-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm-3 14a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM8 6.5l7-1M7 9l6 8m3-10-1 9",
    Settings:"M14 3h-4l-.5 2.4-2 .9-2.1-.9-2 3.4 1.8 1.6v2.9L3.4 15l2 3.4 2.2-.7 2 1 .5 2.3h3.8l.6-2.3 2-.9 2.1.7 2-3.4-1.7-1.8v-2.7l1.7-1.8-2-3.4-2.1.8-2-.9L14 3Zm1.3 9a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0Z",
    Account:"M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM4.5 20a7.5 7.5 0 0 1 15 0",
    Inbox:"m3 14 3-9h12l3 9v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4Zm0 0h5l2 3h4l2-3h5",
    Plus:"M12 5v14M5 12h14",Close:"m6 6 12 12M18 6 6 18",
    Search:"M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 5.5 5.5",
    More:"M5 12h.2m6.7 0h.2m6.7 0h.2",Chevron:"m9 5 7 7-7 7",Back:"m15 5-7 7 7 7",
    Theme:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18",
    Sync:"M20 7a8 8 0 0 0-14-1L3 9m0-5v5h5m-4 8a8 8 0 0 0 14 1l3-3m-5 0h5v5",
    Shield:"M12 3c3 2 6 3 8 3v6c0 5-4 8-8 10-4-2-8-5-8-10V6c2 0 5-1 8-3Zm-3 9 2 2 4-4",
    Download:"M12 3v12m-5-5 5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
    Upload:"M12 16V4m-5 5 5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
    Wallet:"M20 8V6a2 2 0 0 0-2-2L5 6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2H6m15 4h-4a2 2 0 0 0 0 4h4",
    Voice:"M15 6v6a3 3 0 0 1-6 0V6a3 3 0 0 1 6 0Zm-10 6a7 7 0 0 0 14 0m-7 7v3m-3 0h6",
    Lock:"M7 10V7a5 5 0 1 1 10 0v3M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1Zm6 4v3",
    Page:"M6 3h8l4 4v14H6V3Zm7 1v5h5M9 13h6m-6 4h5",
    Action:"m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z",
    List:"M4 6h.1M8 6h12M4 12h.1M8 12h12M4 18h.1M8 18h12",
    Grid:"M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    Link:"m10 13 4-4m-5 7-2 2a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2-1 2-2a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0"
  };
  export type IconName=keyof typeof paths;
</script>
<script lang="ts">export let name:IconName;</script>
<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>
