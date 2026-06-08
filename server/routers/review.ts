/**
 * iAudit — Review & Edit tRPC Router (Layer 8 / Section 12)
 *
 * Procedures:
 *   review.getPost          — Fetch the post for the review screen
 *   review.saveEdits        — Save approved body, meta, alt texts; run re-score
 *   review.approveForPostBack — Mark post as approved and ready for post-back (Layer 9)
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessById } from "../businesses.db";
import {
  getPostForReview,
  saveApprovedContent,
  setPostBackStatus,
} from "../review.db";
import { runFullAudit, scoreToGrade } from "../audit.service";
import { invokeLLM } from "../_core/llm";

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------
async function assertPostOwnership(postId: string, iauditUserId: string) {
  const post = await getPostForReview(postId);
  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Post not found." });
  }
  const business = await getBusinessById(post.businessId);
  if (!business || business.userId !== iauditUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this post.",
    });
  }
  return { post, business };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const reviewRouter = router({
  /**
   * review.getPost
   * Fetch the full post for the review screen.
   */
  getPost: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );
      return post;
    }),

  /**
   * review.saveEdits
   * Save the user's edits to body_approved, meta_title_rewritten,
   * meta_description_rewritten, and body_image_alts.
   * Runs a re-score against the saved content and returns updated score/grade/points.
   * If a previously-passing point now fails, the response includes a warning array.
   */
  saveEdits: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
        bodyApproved: z.string().min(1),
        metaTitleRewritten: z.string(),
        metaDescriptionRewritten: z.string(),
        bodyImageAlts: z.array(z.string()),
      })
    )
    .mutation(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      if (!post.focusKeyword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This post has no focus keyword. Assign a keyword before saving edits.",
        });
      }

      // Detect whether the user actually changed anything
      const prevBody = post.bodyApproved ?? post.bodyRewritten ?? "";
      const prevMetaTitle = post.metaTitleRewritten ?? "";
      const prevMetaDesc = post.metaDescriptionRewritten ?? "";
      const contentChanged =
        input.bodyApproved !== prevBody ||
        input.metaTitleRewritten !== prevMetaTitle ||
        input.metaDescriptionRewritten !== prevMetaDesc;

      // If nothing changed, skip re-score and return the stored audit results
      if (!contentChanged) {
        await saveApprovedContent(input.postId, {
          bodyApproved: input.bodyApproved,
          metaTitleRewritten: input.metaTitleRewritten,
          metaDescriptionRewritten: input.metaDescriptionRewritten,
          bodyImageAlts: input.bodyImageAlts,
          // Do NOT update score/grade/auditResults — nothing changed
        });
        const storedResults = post.auditResults as
          | { points: Array<{ point: string; status: string; note?: string }>; potentialScore?: number }
          | null;
        return {
          score: post.rewriteScore ?? 0,
          grade: post.rewriteGrade ?? "poor",
          points: storedResults?.points ?? [],
          warnings: [],
        };
      }

      // Load business context for accurate CTA link scoring
      const business = await getBusinessById(post.businessId);
      const primaryCtaUrl = business?.primaryCtaUrl ?? null;

      // Inject schemaJson into body before re-scoring so P13 can detect it
      let bodyForScoring = input.bodyApproved;
      if (post.schemaJson && !bodyForScoring.includes('application/ld+json')) {
        bodyForScoring = `<script type="application/ld+json">${post.schemaJson}</script>\n${bodyForScoring}`;
      }

      // Run re-score against the saved content
      const auditResult = await runFullAudit({
        title: post.title,
        bodyHtml: bodyForScoring,
        focusKeyword: post.focusKeyword,
        url: post.url,
        metaTitle: input.metaTitleRewritten,
        metaDescription: input.metaDescriptionRewritten,
        primaryCtaUrl,
      });

      // Count pass + na (na = not applicable, treated as passing)
      const newScore = auditResult.points.filter(
        (p) => p.status === "pass" || p.status === "na"
      ).length;
      const newGrade = scoreToGrade(newScore);

      // Detect regressions — points that previously passed but now fail
      const warnings: string[] = [];
      const prevResults = post.auditResults as
        | { points: Array<{ point: string; status: string; note?: string }> }
        | null;
      if (prevResults?.points) {
        for (const prevPoint of prevResults.points) {
          if (prevPoint.status !== "pass") continue;
          const newPoint = auditResult.points.find(
            (p) => p.point === prevPoint.point
          );
          if (newPoint && newPoint.status === "fail") {
            warnings.push(
              `Your edit has caused ${newPoint.point} to fail — ${newPoint.note ?? "see details below."}`
            );
          }
        }
      }

      // Persist the approved content and updated score
      await saveApprovedContent(input.postId, {
        bodyApproved: input.bodyApproved,
        metaTitleRewritten: input.metaTitleRewritten,
        metaDescriptionRewritten: input.metaDescriptionRewritten,
        bodyImageAlts: input.bodyImageAlts,
        rewriteScore: newScore,
        rewriteGrade: newGrade,
        auditResults: {
          points: auditResult.points,
          potentialScore: auditResult.potentialScore,
        },
      });

      return {
        score: newScore,
        grade: newGrade,
        points: auditResult.points,
        warnings,
      };
    }),

  /**
   * review.applyAiEdit
   * Apply a targeted AI edit to the article body.
   * The user types a plain-English instruction (e.g. "restore the original FAQ section").
   * The AI modifies only the relevant part of the body and returns the updated HTML.
   * The edit is NOT auto-saved — the frontend receives the new HTML and the user
   * can review it before clicking Save.
   */
  applyAiEdit: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
        currentBody: z.string().min(1),
        instruction: z.string().min(1).max(1000),
      })
    )
    .mutation(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      const systemPrompt = `You are an expert blog editor. You will receive an HTML blog article and a targeted editing instruction from the user. Apply ONLY the change described in the instruction — do not change anything else. Preserve all HTML tags, headings, links, images, schema scripts, and SEO structure. Return ONLY the updated HTML with no commentary, no markdown fences, and no explanations. Write in Australian English (use 's' not 'z' in words like optimise, recognise, etc.).`;

      const userPrompt = `INSTRUCTION: ${input.instruction}

CURRENT ARTICLE HTML:
${input.currentBody}`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const rawContent = (response.choices?.[0]?.message?.content ?? "") as string;
      // Strip any accidental markdown code fences the model may add
      const updatedBody = rawContent
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (!updatedBody) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "AI did not return updated content. Please try again.",
        });
      }

      return { updatedBody, postId: post.id };
    }),

  /**
   * review.approveForPostBack
   * Mark the post as approved and ready for post-back (Layer 9).
   * Sets post_back_status = 'pending'.
   */
  approveForPostBack: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      // Must have approved content before post-back
      if (!post.bodyApproved) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No approved content found. Save your edits before approving for post-back.",
        });
      }

      await setPostBackStatus(input.postId, "pending");

      return { success: true, postId: input.postId };
    }),
});
