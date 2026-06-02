/**
 * iAudit — Keyword Identification Service (Layer 5 / Section 9)
 *
 * Responsibilities:
 * 1. AI keyword suggestion — for posts with no CMS keyword, call LLM with
 *    post title + first 500 words and return top 3 focus keyword suggestions.
 * 2. Cannibalisation detection — scan all posts for a business and flag any
 *    duplicate focus keywords by setting cannibalization_flag = true.
 */

import { invokeLLM } from "./_core/llm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeywordSuggestion {
  keyword: string;
  rationale: string;
}

export interface KeywordSuggestionResult {
  suggestions: KeywordSuggestion[];
  postId: string;
}

export interface CannibalisationResult {
  flaggedPostIds: string[];
  duplicateGroups: Array<{
    keyword: string;
    postIds: string[];
  }>;
}

// ---------------------------------------------------------------------------
// AI Keyword Suggestion
// ---------------------------------------------------------------------------

/**
 * Extract the first ~500 words from HTML body content.
 * Strips HTML tags before counting words.
 */
export function extractFirst500Words(htmlContent: string): string {
  // Strip HTML tags
  const text = htmlContent
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = text.split(" ");
  return words.slice(0, 500).join(" ");
}

/**
 * Call the LLM to suggest the top 3 focus keywords for a post.
 * Returns structured JSON with keyword + rationale for each suggestion.
 */
export async function suggestKeywordsForPost(
  postTitle: string,
  bodyContent: string
): Promise<KeywordSuggestion[]> {
  const excerpt = extractFirst500Words(bodyContent);

  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an SEO specialist. Your task is to identify the top 3 most likely focus keywords for a blog post based on its title and content excerpt. 

A focus keyword is a specific search phrase (typically 2-5 words) that the post is most likely trying to rank for in Google search results. Choose keywords that:
- Match real search queries people would type into Google
- Are prominent in the content
- Have clear commercial or informational intent
- Are specific enough to rank for (not too broad)

Respond ONLY with valid JSON matching this exact schema:
{
  "suggestions": [
    { "keyword": "string", "rationale": "string (1-2 sentences max)" },
    { "keyword": "string", "rationale": "string (1-2 sentences max)" },
    { "keyword": "string", "rationale": "string (1-2 sentences max)" }
  ]
}`,
      },
      {
        role: "user",
        content: `Post title: ${postTitle}\n\nContent excerpt (first 500 words):\n${excerpt}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "keyword_suggestions",
        strict: true,
        schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  keyword: { type: "string" },
                  rationale: { type: "string" },
                },
                required: ["keyword", "rationale"],
                additionalProperties: false,
              },
            },
          },
          required: ["suggestions"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response for keyword suggestion");
  }

  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content)) as {
    suggestions: KeywordSuggestion[];
  };

  // Ensure we always return exactly 3 suggestions (pad if LLM returns fewer)
  const suggestions = parsed.suggestions.slice(0, 3);
  while (suggestions.length < 3) {
    suggestions.push({
      keyword: `${postTitle.split(" ").slice(0, 3).join(" ").toLowerCase()} guide`,
      rationale: "Fallback suggestion based on post title.",
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Cannibalisation Detection
// ---------------------------------------------------------------------------

/**
 * Detect duplicate focus keywords across all posts for a business.
 * Returns groups of post IDs that share the same keyword (case-insensitive).
 */
export function detectCannibalisation(
  posts: Array<{ id: string; focusKeyword: string | null }>
): CannibalisationResult {
  // Group posts by normalised keyword
  const keywordMap = new Map<string, string[]>();

  for (const post of posts) {
    if (!post.focusKeyword) continue;
    const normalised = post.focusKeyword.toLowerCase().trim();
    if (!normalised) continue;

    const existing = keywordMap.get(normalised) ?? [];
    existing.push(post.id);
    keywordMap.set(normalised, existing);
  }

  // Find duplicates (groups with more than 1 post)
  const duplicateGroups: CannibalisationResult["duplicateGroups"] = [];
  const flaggedPostIds = new Set<string>();

  keywordMap.forEach((postIds, keyword) => {
    if (postIds.length > 1) {
      duplicateGroups.push({ keyword, postIds });
      for (const id of postIds) {
        flaggedPostIds.add(id);
      }
    }
  });

  return {
    flaggedPostIds: Array.from(flaggedPostIds),
    duplicateGroups,
  };
}
