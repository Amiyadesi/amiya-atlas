<script lang="ts">
  import { activeDialog, finishDialog } from "./dialog";
  import { animateDialogClose, backdropDismiss } from "./motion";
  let dialogEl: HTMLDialogElement | undefined;
  function modal(node: HTMLDialogElement) {
    dialogEl = node;
    node.showModal();
    const input = node.querySelector<HTMLInputElement>("input");
    if (input) {
      input.focus();
    } else if ($activeDialog?.danger) {
      // Destructive confirmations focus Cancel so reflex Enter cannot destroy data.
      node.querySelector<HTMLButtonElement>('button[data-cancel="1"]')?.focus();
    } else {
      node.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
    }
    return {
      destroy: () => {
        if (node.open) node.close();
        if (dialogEl === node) dialogEl = undefined;
      },
    };
  }
  function dismiss() {
    animateDialogClose(dialogEl, () => finishDialog(null), 160);
  }
  function submit(event: SubmitEvent) {
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem(
      "response",
    ) as HTMLInputElement | null;
    if (input) {
      input.setCustomValidity(
        $activeDialog?.input?.validate?.(input.value) ?? "",
      );
      if (!input.reportValidity()) return;
    }
    const result = input?.value ?? "";
    animateDialogClose(dialogEl, () => finishDialog(result), 160);
  }
</script>

{#if $activeDialog}
  {#key $activeDialog}
    <dialog
      use:modal
      use:backdropDismiss={{ onDismiss: dismiss }}
      class="app-dialog"
      aria-labelledby="confirmation-title"
      aria-describedby={$activeDialog.description
        ? "confirmation-description"
        : undefined}
      on:cancel|preventDefault={dismiss}
    >
      <form on:submit|preventDefault={submit}>
        <h2 id="confirmation-title">{$activeDialog.title}</h2>
        {#if $activeDialog.description}<p id="confirmation-description">
            {$activeDialog.description}
          </p>{/if}
        {#if $activeDialog.input}
          <label
            >{$activeDialog.input.label}
            <input
              name="response"
              type={$activeDialog.input.type ?? "text"}
              required
              autocomplete={$activeDialog.input.type === "password"
                ? "current-password"
                : "off"}
              on:input={(e) => e.currentTarget.setCustomValidity("")}
            />
          </label>
        {/if}
        <footer>
          <button
            class="secondary"
            type="button"
            data-cancel="1"
            on:click={dismiss}>取消</button
          >
          <button
            class="primary"
            class:destructive={$activeDialog.danger}
            type="submit">{$activeDialog.confirmLabel ?? "确认"}</button
          >
        </footer>
      </form>
    </dialog>
  {/key}
{/if}

<style>
  dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 24px;
    border-radius: 18px;
  }
  h2 {
    margin-bottom: 10px;
    font-size: 19px;
  }
  p {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.7;
  }
  label {
    margin-top: 18px;
    font-size: 13px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 24px;
  }
  .destructive {
    background: var(--expense);
    border-color: var(--expense);
    color: var(--on-semantic);
  }
  .destructive:hover:not(:disabled) {
    background: color-mix(in srgb, var(--expense) 85%, var(--text));
  }
</style>
