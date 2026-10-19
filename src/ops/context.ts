import type { EmbeddingRecovery } from "./embedding-recovery.mjs";
import type { OllamaReadiness } from "./provider-readiness.mjs";
export const operationalState: { providerReadiness?: OllamaReadiness | null; embeddingRecovery?: EmbeddingRecovery | null } = {};
