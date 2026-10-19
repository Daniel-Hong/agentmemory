import { createHash } from "node:crypto";
import type { IIIClient } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { CONSOLIDATION_LAST_RUN_KEY } from "./consolidation-status.js";
import { getConsolidationDecayDays, isConsolidationEnabled } from "../config.js";
import { logger } from "../logger.js";
import { isReflectEnabled } from "./slots.js";

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
    lastDecayedAt?: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const lastAccessTime = new Date(lastAccess).getTime();
    const lastDecayedTime = item.lastDecayedAt
      ? new Date(item.lastDecayedAt).getTime()
      : -Infinity;
    const anchor = Math.max(lastAccessTime, lastDecayedTime);
    const daysSince = (now - anchor) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
      item.lastDecayedAt = new Date(now).toISOString();
    }
  }
}

const DECAY_STRENGTH_EPSILON = 1e-9;

function strengthChanged(before: number, after: number): boolean {
  return Math.abs(after - before) > DECAY_STRENGTH_EPSILON;
}

async function decayAndWriteChanged<
  T extends {
    id: string;
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
    lastDecayedAt?: string;
  },
>(
  kv: StateKV,
  scope: string,
  items: T[],
  decayDays: number,
): Promise<{ scanned: number; written: number }> {
  const before = items.map((item) => item.strength);
  applyDecay(items, decayDays);
  const dirty = items.filter((item, i) => strengthChanged(before[i], item.strength));
  for (const item of dirty) {
    await kv.set(scope, item.id, item);
  }
  return { scanned: items.length, written: dirty.length };
}

const SEMANTIC_GROUNDING_STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "into", "can",
	"are", "was", "were", "has", "have", "had", "its", "their", "they",
	"them", "then", "than", "but", "not", "all", "any", "some", "one",
	"two", "each", "other", "using", "used", "use", "via", "within",
	"between", "across", "allows", "allow", "includes", "include",
	"system"
]);

function semanticGroundingTokens(value: unknown) {
	const expanded = String(value ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase();

	const raw =
		expanded.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];

	return [...new Set(
		raw.filter((token) =>
			token.length >= 3 &&
			!SEMANTIC_GROUNDING_STOPWORDS.has(token) &&
			!/^\d+$/.test(token)
		)
	)];
}

function semanticFactSupportedBySummary(fact: string, summary: SessionSummary) {
	const factTokens = semanticGroundingTokens(fact);

	// Very short/generated facts are too ambiguous to promote safely.
	if (factTokens.length < 3) return false;

	const summaryText = [
		summary.title ?? "",
		summary.narrative ?? "",
		Array.isArray(summary.concepts)
			? summary.concepts.join(" ")
			: ""
	].join("\n");

	const summaryTokens =
		new Set(semanticGroundingTokens(summaryText));

	let matched = 0;

	for (const token of factTokens) {
		if (summaryTokens.has(token)) matched++;
	}

	const coverage = matched / factTokens.length;

	// Conservative by design: false negatives are preferable to
	// promoting a one-session hallucination into semantic memory.
	const minimumMatches =
		factTokens.length <= 5 ? 2 : 3;

	return (
		matched >= minimumMatches &&
		coverage >= 0.5
	);
}

function parseSemanticFacts(response: string): Array<{confidence:number;fact:string}> {
  let facts: Array<{confidence:number;fact:string}>;
  if(response.trim().startsWith('{')) {
    const parsed=JSON.parse(response);
    if(!parsed || Object.keys(parsed).some(k=>k!=='facts') || !Array.isArray(parsed.facts) || parsed.facts.length>2) throw Error('semantic_merge_invalid_json');
    facts=parsed.facts;
  } else {
    const body=response.trim().match(/^<facts\s*>([\s\S]*)<\/facts>$/)?.[1];
    if(body===undefined)throw Error('semantic_merge_invalid_xml');
    const regex=/<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
    facts=[...body.matchAll(regex)].map(m=>({confidence:Number(m[1]),fact:m[2].trim().replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')}));
    if(body.replace(regex,'').trim())throw Error('semantic_merge_invalid_xml');
  }
  if(facts.some(f=>!f || Object.keys(f).some(k=>!['confidence','fact'].includes(k)) || typeof f.fact!=='string' || !f.fact.trim() || f.fact.length>120 || !Number.isFinite(f.confidence) || f.confidence<0 || f.confidence>1))throw Error('semantic_merge_invalid_fact');
  return facts;
}

export function registerConsolidationPipelineFunction(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY, or AGENTMEMORY_ALLOW_AGENT_SDK=true). OPENAI_BASE_URL alone only points an OpenAI key at another server; it is not a provider." };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const fingerprintKey="consolidation:semanticFingerprint:v2";
          const fingerprint=createHash("sha256").update("semantic-grounded-v2|"+JSON.stringify(recentSummaries.map(s=>({sessionId:s.sessionId,title:s.title,narrative:s.narrative,concepts:s.concepts})))).digest("hex");
          const previous=await kv.get<{hash:string}>(KV.config,fingerprintKey);
          if(previous?.hash===fingerprint) {
            results.semantic={skipped:true,reason:"summaries unchanged",totalSummaries:summaries.length};
          } else {
          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );

          try {
            const response = await provider.summarize(
              SEMANTIC_MERGE_SYSTEM,
              prompt,
            );

            const facts=parseSemanticFacts(response);
            let newFacts = 0;
            const now = new Date().toISOString();
            for (const {confidence,fact} of facts) {
              const supporting=recentSummaries.filter(summary=>semanticFactSupportedBySummary(fact,summary));
              if(supporting.length<2)continue;
              const sourceSessionIds=[...new Set(supporting.map(s=>s.sessionId))];
              const existing = existingSemantic.find(
                (s) => s.fact.toLowerCase() === fact.toLowerCase(),
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                existing.sourceSessionIds=[...new Set([...(existing.sourceSessionIds??[]),...sourceSessionIds])];
                await kv.set(KV.semantic, existing.id, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds,
                  sourceMemoryIds: [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                newFacts++;
              }
            }
            await kv.set(KV.config,fingerprintKey,{hash:fingerprint,at:now,summaryCount:summaries.length});
            results.semantic = { newFacts, totalSummaries: summaries.length };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            results.semantic = { error: msg };
          }
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        if(!isReflectEnabled())results.reflect={skipped:true,reason:"reflection disabled"};
        else try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((m) => ({
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2)
          .sort((a, b) => a.content.localeCompare(b.content) || a.frequency - b.frequency);

        if (patterns.length >= 2) {
          const fingerprintKey = "consolidation:proceduralFingerprint:v1";
          const fingerprint = createHash("sha256")
            .update("procedural-patterns-v1|" + JSON.stringify(patterns)).digest("hex");
          const previous = await kv.get<{ hash: string }>(KV.config, fingerprintKey).catch(() => null);
          if (previous?.hash === fingerprint) {
            results.procedural = { skipped: true, reason: "patterns unchanged", patternsAnalyzed: patterns.length };
          } else {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );
            if (!/<procedures\b[^>]*>[\s\S]*<\/procedures>/.test(response)) {
              throw new Error("procedural_extraction_invalid_xml");
            }

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            await kv.set(KV.config, fingerprintKey, { hash: fingerprint, at: now, patternCount: patterns.length });
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        const procedural = await kv.list<ProceduralMemory>(KV.procedural);

        const semanticResult = await decayAndWriteChanged(
          kv,
          KV.semantic,
          semantic,
          decayDays,
        );
        const proceduralResult = await decayAndWriteChanged(
          kv,
          KV.procedural,
          procedural,
          decayDays,
        );

        results.decay = {
          semantic: semanticResult,
          procedural: proceduralResult,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      await kv
        .set(KV.config, CONSOLIDATION_LAST_RUN_KEY, { at: new Date().toISOString(), tier, results })
        .catch(() => {});

      logger.info("Consolidation pipeline complete", { tier, results });
      const success=!Object.values(results).some(result=>result && typeof result==="object" && ("error" in result || ("success" in result && result.success===false)));
      return { success, results };
    },
  );
}
