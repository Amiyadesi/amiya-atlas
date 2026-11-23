<script lang="ts">
  const paths = {
    connections: "M6.5 7.5l10 3M7 17l9-5M8 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm13 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM8 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    ledger: "M6 3h13v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 0v18m3-12h5m-5 4h4",
    import: "M12 3v11m-4-4 4 4 4-4M4 15v5h16v-5",
    email: "M3 5h18v14H3z m0 1 9 7 9-7",
    sim: "M7 3h8l4 4v14H5V5a2 2 0 0 1 2-2Zm1 8h8v7H8z m4 0v7",
    card: "M3 5h18v14H3z m0 5h18M6 15h4",
    subscription: "M4 10a8 8 0 0 1 14-4l2 2m0-5v5h-5M20 14a8 8 0 0 1-14 4l-2-2m0 5v-5h5",
    lock: "M5 10h14v11H5z m3 0V7a4 4 0 0 1 8 0v3m-4 4v3",
    system: "M3 4h18v13H3z m9 13v4m-5 0h10",
    dark: "M20 15a8.5 8.5 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z",
    light: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  };
  let { name, size = 18 }: { name: keyof typeof paths; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
