<script lang="ts">
  import Icon from "./Icon.svelte";
  export let month: string;
  function step(n: number) {
    const [y, m] = month.split("-").map(Number);
    const date = new Date(y, m - 1 + n, 1);
    month =
      date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
</script>

<div class="month-switcher" role="group" aria-label="月份">
  <button aria-label="上个月" on:click={() => step(-1)}
    ><Icon name="Back" /></button
  >
  <label title={month}
    ><span
      >{month.slice(0, 4) === String(new Date().getFullYear())
        ? ""
        : month.slice(0, 4) + "年"}{Number(month.slice(5))}月</span
    >
    <input
      aria-label="选择月份"
      type="month"
      value={month}
      on:input={(e) => {
        if (e.currentTarget.value) month = e.currentTarget.value;
      }}
    />
  </label>
  <button aria-label="下个月" on:click={() => step(1)}
    ><Icon name="Chevron" /></button
  >
</div>

<style>
  .month-switcher {
    display: inline-flex;
    align-items: center;
    background: var(--surface);
    border-radius: 99px;
    color: var(--muted);
    font-size: 13px;
  }
  button,
  label {
    height: 36px;
    display: grid;
    place-items: center;
    background: none;
    color: inherit;
    padding: 0 7px;
  }
  button :global(svg) {
    width: 13px;
    height: 13px;
  }
  label {
    position: relative;
    color: var(--text);
    padding: 0 2px;
    white-space: nowrap;
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
</style>
