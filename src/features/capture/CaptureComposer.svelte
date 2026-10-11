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
  <label class="sr-only" for={id}>告诉 Atlas 一件事</label>
  <textarea
    {id}
    bind:this={input}
    bind:value={text}
    on:keydown={keydown}
    maxlength="10000"
    rows={compact ? 3 : 4}
    placeholder="比如：Saily 是我的美国备用号码，每个月六块多，暂时保留。"
    disabled={busy || recording || voiceBusy}></textarea>
  {#if recording || voiceBusy}
    <div class="voice-strip" role="status">
      <span class="recording-dot" class:pulsing={recording}></span>
      {#if recording}<span>正在听 · {seconds}s / 60s</span><meter
          min="0"
          max="0.2"
          value={level}
          aria-label="麦克风音量"
        ></meter>
      {:else}<span>{voiceLabel}</span>{/if}
      <button class="text-button" type="button" on:click={cancelRecording}
        >取消</button
      >
    </div>
  {/if}
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
    <button
      class="primary"
      type="submit"
      disabled={busy || recording || voiceBusy || !text.trim()}
      >{busy ? "正在理解…" : "帮我记住"} <span>↗</span></button
    >
  </div>
  <div class="capture-hint">
    <span>✦ 自动整理，等你确认</span><span
      ><kbd>Ctrl ↵</kbd> 整理 · <kbd>Esc</kbd> 取消录音</span
    >
  </div>
</form>
