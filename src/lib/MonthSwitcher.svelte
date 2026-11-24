<script lang="ts">
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { dateToday } from "../domain/ledger";
  export let month: string;
  let direction: -1 | 0 | 1 = 0;
  let lastMonth = month;
  let todayMonth = dateToday().slice(0, 7);
  let monthInput: HTMLInputElement;
  function refreshToday() {
    todayMonth = dateToday().slice(0, 7);
  }
  onMount(() => {
    const onActive = () => {
      if (!document.hidden) refreshToday();
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  });
  $: isCurrent = month === todayMonth;
  $: if (month !== lastMonth) {
    direction = month > lastMonth ? 1 : -1;
    lastMonth = month;
  }
  $: label =
    (month.slice(0, 4) === String(new Date().getFullYear())
      ? ""
      : month.slice(0, 4) + "年") +
    Number(month.slice(5)) +
    "月";
  function step(n: number) {
    refreshToday();
    direction = n > 0 ? 1 : -1;
    const [y, m] = month.split("-").map(Number);
    const date = new Date(y, m - 1 + n, 1);
    month =
      date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
  async function backToToday() {
    refreshToday();
    direction = todayMonth > month ? 1 : -1;
    month = todayMonth;
    await tick();
    monthInput?.focus();
  }
</script>

<div class="month-switcher" role="group" aria-label="月份">
  <button type="button" aria-label="上个月" on:click={() => step(-1)}
    ><Icon name="Back" /></button
  >
  <label title={month}>
    {#key month}
      <span
        class="month-label"
        class:slide-next={direction === 1}
        class:slide-prev={direction === -1}>{label}</span
      >
    {/key}
    <input
      bind:this={monthInput}
      aria-label="选择月份"
      type="month"
      value={month}
      on:input={(e) => {
        refreshToday();
        if (e.currentTarget.value) month = e.currentTarget.value;
      }}
    />
  </label>
  <button type="button" aria-label="下个月" on:click={() => step(1)}
    ><Icon name="Chevron" /></button
  >
  {#if !isCurrent}
    <button
      type="button"
      class="today-jump"
      aria-label="回到本月"
      on:click={backToToday}>本月</button
    >
  {/if}
</div>

<style>
  .month-switcher {
    display: inline-flex;
    align-items: center;
    background: var(--surface);
    border-radius: 99px;
    color: var(--muted);
    font-size: 13px;
    padding: 0 2px;
    flex-shrink: 0;
  }
  button,
  label {
    height: 36px;
    display: grid;
    place-items: center;
    background: none;
    color: inherit;
    padding: 0 7px;
    border-radius: 99px;
  }
  button:hover {
    color: var(--text);
  }
  button :global(svg) {
    width: 13px;
    height: 13px;
  }
  label {
    position: relative;
    color: var(--text);
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
  }
  .month-label {
    display: inline-block;
    font-weight: 550;
  }
  .today-jump {
    height: 26px;
    padding: 0 9px;
    margin: 0 3px 0 2px;
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .today-jump:hover {
    background: #6947e0;
    border-color: #6947e0;
    color: #ffffff;
  }
  input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    min-width: 0;
    cursor: pointer;
  }
  input::-webkit-calendar-picker-indicator {
    position: absolute;
    inset: 0;
    width: auto;
    height: auto;
    cursor: pointer;
  }
  label:focus-within {
    outline: 2px solid var(--accent);
  }
  @media (prefers-reduced-motion: no-preference) {
    .month-label.slide-next {
      animation: rk-month-next var(--dur-micro, 150ms) var(--ease-out, ease-out)
        backwards;
    }
    .month-label.slide-prev {
      animation: rk-month-prev var(--dur-micro, 150ms) var(--ease-out, ease-out)
        backwards;
    }
    .today-jump {
      animation: rk-pop var(--dur-base, 220ms) var(--ease-spring, ease-out)
        backwards;
    }
  }
  @keyframes rk-month-next {
    from {
      opacity: 0;
      transform: translate3d(8px, 0, 0);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0);
    }
  }
  @keyframes rk-month-prev {
    from {
      opacity: 0;
      transform: translate3d(-8px, 0, 0);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0);
    }
  }
</style>
