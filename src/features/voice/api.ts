import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../lib/api";
import { wavBase64 } from "./recorder";
export interface VoiceStatus {
  supported: boolean;
  ready: boolean;
  model: string;
  prerequisite: string | null;
}
export async function voiceStatus(): Promise<VoiceStatus> {
  return isTauri
    ? invoke("voice_status")
    : {
        supported: false,
        ready: false,
        model: "Whisper Small Q5_1",
        prerequisite: null,
      };
}
export async function prepareVoice(): Promise<void> {
  await invoke("prepare_voice_model");
}
export async function transcribeVoice(
  wav: Uint8Array,
  language: string,
): Promise<string> {
  try {
    return await invoke("transcribe_voice", {
      wavBase64: wavBase64(wav),
      language,
    });
  } finally {
    wav.fill(0);
  }
}
export async function cancelVoice(): Promise<void> {
  if (isTauri) await invoke("cancel_voice_transcription");
}
