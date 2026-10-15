<script lang="ts">
  export let name: "Ledger" | "Home" | "Memory" | "Explore" | "Inbox" | "Settings" | "Account" | "Lock";
  const paths = {
    Ledger: "M4 3h16v18H4V3zm4 5h8m-8 5h2m4 0h2m-8 4h2m4 0h2",
    Home: "m3 10 9-7 9 7v10H3V10zm6 10v-7h6v7",
    Memory: "M5 4h14v16H5V4zm4 4h6m-6 4h6m-6 4h4",
    Explore: "M6 6h.01M18 6h.01M12 18h.01M6 6l12 0m0 0-6 12M6 6l6 12",
    Inbox: "M4 4h16v16H4V4zm0 10h5l2 3h2l2-3h5",
    Settings: "M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10M9 3v6m4 0V3m0 6h4v6h-4V9zM6 15h4v6H6v-6z",
    Account: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21v-2a8 8 0 0 1 16 0v2",
    Lock: "M5 10h14v11H5V10zm3 0V7a4 4 0 0 1 8 0v3",
  };
</script>

<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
