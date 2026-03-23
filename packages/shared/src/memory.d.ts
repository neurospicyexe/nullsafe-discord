import type { InferenceAdapter } from "./inference.js";
export declare function meetsNoteThreshold(text: string): boolean;
export declare function judgeNote(userMessage: string, assistantResponse: string, inference: InferenceAdapter): Promise<string | null>;
