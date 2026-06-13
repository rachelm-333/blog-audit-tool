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
// Multi-zone Focus Keyword Extraction (fast, no AI)
// ---------------------------------------------------------------------------

// Common English stop words to exclude from n-gram candidates
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","up","about","into","through","during","before","after",
  "above","below","between","out","off","over","under","again","then",
  "once","here","there","when","where","why","how","all","both","each",
  "few","more","most","other","some","such","no","not","only","own",
  "same","so","than","too","very","can","will","just","should","now",
  "is","are","was","were","be","been","being","have","has","had",
  "do","does","did","this","that","these","those","it","its","you",
  "your","we","our","they","their","he","she","his","her","what",
  "which","who","whom","as","if","while","because","although","though",
  "get","make","use","need","want","help","work","also","like","new",
]);

/**
 * Tokenise a plain-text string into lowercase words, stripping punctuation.
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Extract all 2-gram and 3-gram phrases from a word array.
 * Skips n-grams that start or end with a stop word.
 */
function extractNgrams(words: string[], n: 2 | 3): string[] {
  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n);
    // Skip if first or last word is a stop word
    if (STOP_WORDS.has(gram[0]) || STOP_WORDS.has(gram[gram.length - 1])) continue;
    ngrams.push(gram.join(" "));
  }
  return ngrams;
}

/**
 * Extract H1 and H2 text from HTML.
 */
function extractHeadings(html: string): string {
  const matches = html.match(/<h[12][^>]*>([^<]*)<\/h[12]>/gi) ?? [];
  return matches
    .map((m) => m.replace(/<[^>]+>/g, " "))
    .join(" ");
}

/**
 * Extract the first ~100 words of plain text from HTML.
 */
function extractFirst100Words(html: string): string {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(" ").slice(0, 100).join(" ");
}

/**
 * Find the focus keyword for a post using a 5-zone scoring system:
 *
 *   PRIMARY SIGNALS (strongest — you wrote these to target the keyword):
 *   1. Meta title  — +5 if a phrase from the H1 title also appears here
 *   2. Meta description — +4 if a phrase from the H1 title also appears here
 *
 *   SECONDARY SIGNALS (cross-zone confirmation):
 *   3. H1 post title — +3 (all candidates come from here)
 *   4. H1/H2 headings — +2 if phrase also appears in body headings
 *   5. First 100 words — +1 if phrase also appears in opening paragraph
 *
 * The phrase with the highest total score wins. This means a phrase that
 * appears in the meta title AND meta description AND headings scores 5+4+3+2 = 14
 * and will always beat a title-only phrase scoring 3.
 *
 * Falls back to first 3 meaningful words from title if nothing scores.
 */
export function extractKeywordFromTitle(
  title: string,
  bodyHtml: string = "",
  metaTitle: string = "",
  metaDescription: string = ""
): string {
  if (!title?.trim()) return "";

  const titleWords = tokenise(title);
  const headingsText = extractHeadings(bodyHtml);
  const first100Text = extractFirst100Words(bodyHtml);
  const metaTitleLower = metaTitle.toLowerCase();
  const metaDescLower = metaDescription.toLowerCase();

  // Build candidate n-grams from the H1 title (2-grams and 3-grams)
  const candidates = new Map<string, number>();

  const titleBigrams = extractNgrams(titleWords, 2);
  const titleTrigrams = extractNgrams(titleWords, 3);
  const allTitleGrams = [...titleTrigrams, ...titleBigrams];

  for (const gram of allTitleGrams) {
    if (!candidates.has(gram)) candidates.set(gram, 0);

    // +3 for being in the H1 title (always true — candidates come from title)
    candidates.set(gram, (candidates.get(gram) ?? 0) + 3);

    // +5 if the phrase also appears in the meta title (strongest SEO signal)
    if (metaTitleLower && metaTitleLower.includes(gram)) {
      candidates.set(gram, (candidates.get(gram) ?? 0) + 5);
    }

    // +4 if the phrase also appears in the meta description
    if (metaDescLower && metaDescLower.includes(gram)) {
      candidates.set(gram, (candidates.get(gram) ?? 0) + 4);
    }

    // +2 if the phrase appears in H2 headings
    if (headingsText.toLowerCase().includes(gram)) {
      candidates.set(gram, (candidates.get(gram) ?? 0) + 2);
    }

    // +1 if the phrase appears in the first 100 words
    if (first100Text.toLowerCase().includes(gram)) {
      candidates.set(gram, (candidates.get(gram) ?? 0) + 1);
    }
  }

  if (candidates.size === 0) {
    // Fallback: return first 3 non-stop words from title
    const meaningful = titleWords.filter((w) => !STOP_WORDS.has(w));
    return meaningful.slice(0, 3).join(" ") || title.trim().split(" ").slice(0, 3).join(" ").toLowerCase();
  }

  // Sort by score descending, then prefer 3-grams over 2-grams on a tie
  // (longer phrase = more specific keyword)
  const sorted = Array.from(candidates.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]; // higher score first
    return b[0].split(" ").length - a[0].split(" ").length; // longer phrase on tie
  });

  return sorted[0][0];
}

// ---------------------------------------------------------------------------
// Keyword Validation (applies to all CMS importers)
// ---------------------------------------------------------------------------

/**
 * Validate a detected keyword before saving to the database.
 * Rules (from spec):
 *   - Must be at least 2 words
 *   - Must not consist only of stop words
 *   - Must be between 2 and 5 words total
 *   - Must not start AND end with a stop word
 *
 * Returns true if valid, false if the keyword should be discarded.
 */
export function validateKeyword(keyword: string | null | undefined): boolean {
  if (!keyword?.trim()) return false;

  const words = tokenise(keyword);

  // Must be 2–5 words
  if (words.length < 2 || words.length > 5) return false;

  // Must not consist entirely of stop words
  if (words.every((w) => STOP_WORDS.has(w))) return false;

  // Must not start AND end with a stop word
  if (STOP_WORDS.has(words[0]) && STOP_WORDS.has(words[words.length - 1])) return false;

  return true;
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
