import type { ChatService } from "./chats";
import type { MizitoClient } from "./client";
import { ChatLogUnsupportedMedia, type ChatLogMediaProvider } from "./chat-log";
import { fetchImageMedia, fetchVoiceMedia } from "./download";
import { ConfigError, DownloadDisabled, UnsupportedAudio } from "./errors";

/** Reuses the connector's validated, bounded media path; never writes temporary files. */
export function createChatLogMediaProvider(chats: ChatService, client: MizitoClient, allowed: boolean): ChatLogMediaProvider {
  return async (chat, message, { maxBytes, signal }) => {
    if (!allowed) throw new DownloadDisabled();
    if (message.chatId !== chat.id || message.deleted || message.service) throw new ConfigError("Media source is unavailable");
    const kind = message.attachment?.kind;
    if (kind === "photo") {
      const media = await fetchImageMedia(chats, client, chat.id, message.id, allowed, maxBytes, { signal });
      return { bytes: media.data, mime: media.mime, kind };
    }
    if (kind === "audio") {
      try {
        const media = await fetchVoiceMedia(chats, client, chat.id, message.id, allowed, maxBytes, { signal });
        return { bytes: media.data, mime: media.mime, kind };
      } catch (error) {
        if (error instanceof UnsupportedAudio) throw new ChatLogUnsupportedMedia();
        throw error;
      }
    }
    throw new ConfigError("Unsupported media kind");
  };
}
