import { Client } from "discord.js";
import type { LibrarianClient, InferenceAdapter, ChannelConfigCache, ChatMessage, BootContext } from "@nullsafe/shared";
export declare function startAutonomous(librarian: LibrarianClient, inference: InferenceAdapter, client: Client, configCache: ChannelConfigCache, _channelHistory: Map<string, ChatMessage[]>, bootCtx: BootContext): void;
export declare function stopAutonomous(): void;
