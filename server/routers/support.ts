/**
 * support.ts — Support Centre tRPC router
 *
 * Procedures:
 *  - sendContactEmail: sends a support message to rachel.m@noize.com.au via Resend
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Resend } from "resend";
import { router, publicProcedure } from "../_core/trpc";

function getResendClient(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY environment variable is not set");
  return new Resend(key);
}

function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL ?? "noreply@iaudit.com.au";
}

export const supportRouter = router({
  /**
   * sendContactEmail
   * Sends a support contact form submission to rachel.m@noize.com.au.
   * Pre-filled name and email come from the frontend (from the user's session).
   */
  sendContactEmail: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "Name is required"),
        email: z.string().email("Valid email is required"),
        subject: z.string().min(1, "Subject is required").max(200),
        message: z
          .string()
          .min(20, "Message must be at least 20 characters")
          .max(5000),
      })
    )
    .mutation(async ({ input }) => {
      const { name, email, subject, message } = input;

      try {
        const resend = getResendClient();
        await resend.emails.send({
          from: getFromEmail(),
          to: "rachel.m@noize.com.au",
          replyTo: email,
          subject: `iAudit Support: ${subject}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #1A7A4A;">New Support Message — iAudit</h2>
              <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr>
                  <td style="padding: 8px; font-weight: bold; width: 100px; color: #555;">From:</td>
                  <td style="padding: 8px;">${name}</td>
                </tr>
                <tr style="background: #f9f9f9;">
                  <td style="padding: 8px; font-weight: bold; color: #555;">Email:</td>
                  <td style="padding: 8px;"><a href="mailto:${email}">${email}</a></td>
                </tr>
                <tr>
                  <td style="padding: 8px; font-weight: bold; color: #555;">Subject:</td>
                  <td style="padding: 8px;">${subject}</td>
                </tr>
              </table>
              <div style="background: #f5f5f5; padding: 16px; border-radius: 6px; border-left: 4px solid #1A7A4A;">
                <p style="margin: 0; white-space: pre-wrap;">${message}</p>
              </div>
              <p style="color: #999; font-size: 12px; margin-top: 20px;">
                Sent via iAudit Support Centre
              </p>
            </div>
          `,
        });

        return { success: true };
      } catch (err) {
        console.error("[Support] Failed to send contact email:", err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to send your message. Please try again or email us directly.",
        });
      }
    }),
});
