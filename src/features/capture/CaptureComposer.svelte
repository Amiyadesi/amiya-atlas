<script lang="ts">
  export let text = "";
  export let busy = false;
  export let recording = false;
  export let voiceBusy = false;
  export let voiceReady = false;
  export let voiceLabel = "正在本机转写…";
  export let seconds = 0;
  export let level = 0;
  export let input: HTMLTextAreaElement | undefined = undefined;
  export let id = "capture";
  export let compact = false;
  export let submit: () => void;
  export let save: () => void;
  export let paste: () => void;
  export let microphone: () => void;
  export let cancelRecording: () => void;
  const keydown = (event: KeyboardEvent) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (!recording && !voiceBusy) submit();
    }
  };
</script>

<form class="capture-card" class:compact on:submit|preventDefault={submit}>
  <label class="sr-only" for={id}>告诉络笺一件事</label>
  <textarea
    {id}
    bind:this={input}
    bind:value={text}
    on:keydown={keydown}
    maxlength="10000"
    rows={compact ? 3 : 4}
    placeholder="比如：今天给 Google One 换了付款卡，用尾号 1234 的那张。"
    disabled={busy || recording || voiceBusy}></textarea>
  <div class="voice-status-slot">
  {#if recording || voiceBusy}
    <div class="voice-strip" role="status">
      <span class="recording-dot" class:pulsing={recording}></span>
      {#if recording}<span>正在听 · {seconds}s / 60s</span><meter
          min="0"
          max="1"
          value={Math.min(1, level * 16)}
          aria-label="麦克风音量"
        ></meter>
      {:else}<span>{voiceLabel}</span>{/if}
      <button class="text-button" type="button" on:click={cancelRecording}
        >取消</button
      >
    </div>
  {/if}
  </div>
  <div class="capture-footer">
    <div class="capture-tools">
      <button
        class="capture-tool"
        type="button"
        on:click={paste}
        disabled={busy || recording || voiceBusy}
        title="读取剪贴板文字">↙ <span>粘贴</span></button
      >
      <button
        class="capture-tool"
        class:recording
        type="button"
        on:click={microphone}
        disabled={busy || voiceBusy}
        title={voiceReady ? "本地语音转写" : "前往设置准备语音模型"}
        >{recording ? "■ 停止并转写" : "◉ 语音"}</button
      >
    </div>
    <div class="capture-actions">
      <button
        class="text-button"
        type="button"
        on:click={save}
        disabled={busy || recording || voiceBusy || !text.trim()}
        >先存原文</button
      >
      <button
        class="primary"
        type="submit"
        disabled={busy || recording || voiceBusy || !text.trim()}
        >{busy ? "正在处理…" : "整理预览"}</button
      >
    </div>
  </div>
</form>
