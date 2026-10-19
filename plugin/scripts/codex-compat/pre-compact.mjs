#!/usr/bin/env node
import { hookMain } from "./long-session-hook-client.mjs";
hookMain("PreCompact").catch(() => { console.error("[AgentMemory] hook record remains pending or capture failed"); process.exitCode = 1; });
