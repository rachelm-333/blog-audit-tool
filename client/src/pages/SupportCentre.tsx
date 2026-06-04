/**
 * SupportCentre.tsx — Layer 16
 *
 * Features:
 *  - 15 help articles, written at a 15-year-old reading level
 *  - Real-time search filtering articles by title and body text
 *  - Contact form (name, email, subject, message) → sends via trpc.support.sendContactEmail
 *  - No login wall — visible to all authenticated users
 */
import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Search, ChevronDown, ChevronUp, Mail, CheckCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useIauditAuth } from "@/hooks/useIauditAuth";
import { toast } from "sonner";

// ─── Article data ─────────────────────────────────────────────────────────────

interface Article {
  id: number;
  title: string;
  category: string;
  body: string; // plain text for search matching
  content: React.ReactNode; // rendered JSX
}

const ARTICLES: Article[] = [
  {
    id: 1,
    title: "Getting Started — Set Up Your Account and Connect Your First Website",
    category: "Getting Started",
    body: "account creation email verification adding a business connecting wordpress wix shopify running first audit step by step",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>Welcome to iAudit! This guide walks you through everything you need to do to get started. Follow each step in order and you will have your first audit running in about 10 minutes.</p>
        <h3 className="font-semibold text-base">Step 1 — Create your account</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to the iAudit homepage and click <strong>Get Started</strong>.</li>
          <li>Enter your name, email address, and a password. Choose <strong>Solo</strong> if you manage one website, or <strong>Agency</strong> if you manage several.</li>
          <li>Click <strong>Create Account</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 2 — Verify your email</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Check your inbox for an email from iAudit with the subject "Verify your iAudit email address".</li>
          <li>Click the <strong>Verify Email Address</strong> button in that email.</li>
          <li>You will be taken back to iAudit and logged in automatically.</li>
        </ol>
        <p className="text-muted-foreground text-xs">If you do not see the email within 2 minutes, check your spam folder.</p>
        <h3 className="font-semibold text-base">Step 3 — Add your first business</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>After logging in, you will see a screen asking for your website URL.</li>
          <li>Type in the full address of your website (for example, <em>https://yourwebsite.com.au</em>) and click <strong>Begin</strong>.</li>
          <li>iAudit will scan your website and fill in your business profile automatically. This takes about 30 seconds.</li>
          <li>Check the details it found, fill in anything that is missing, and click <strong>Confirm Profile</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 4 — Connect your CMS</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>After confirming your profile, you will be asked to connect your website platform (WordPress, Wix, or Shopify).</li>
          <li>Choose your platform and follow the instructions on screen. See the separate guides for WordPress, Wix, and Shopify if you need help with this step.</li>
          <li>Once connected, iAudit will import your blog posts automatically.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 5 — Run your first audit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to your <strong>Post List</strong> page. You will see all your imported blog posts.</li>
          <li>Click <strong>Audit All Posts</strong> to score every post at once. Audits are free — they do not use any credits.</li>
          <li>When the audit finishes, each post will show a score and a grade. Click any post to see the full results.</li>
        </ol>
      </div>
    ),
  },
  {
    id: 2,
    title: "How to Run an Audit",
    category: "Auditing",
    body: "audit click progress bar what happens how long takes finishes results score grade",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>An audit checks your blog post against 16 SEO rules and gives it a score out of 16. Audits are completely free — they never use any credits.</p>
        <h3 className="font-semibold text-base">How to start an audit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to your <strong>Post List</strong> page.</li>
          <li>To audit all posts at once, click the <strong>Audit All Posts</strong> button at the top of the page.</li>
          <li>To audit a single post, click the post row and then click <strong>Run Audit</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">What happens during an audit</h3>
        <p>iAudit checks your post in two ways:</p>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li><strong>Mechanical checks</strong> — things like whether your focus keyword appears in the right places, whether your meta title is the right length, and whether your post is long enough.</li>
          <li><strong>AI checks</strong> — things like whether your post answers the reader's question quickly, whether it links to trustworthy sources, and whether it sounds like a real person wrote it.</li>
        </ul>
        <h3 className="font-semibold text-base">How long does it take?</h3>
        <p>A single post audit takes about 10–20 seconds. Auditing all posts at once takes a bit longer — usually 1–3 minutes depending on how many posts you have.</p>
        <h3 className="font-semibold text-base">What you see when it finishes</h3>
        <p>Each post will show a score (for example, 11/16) and a grade badge (Optimised, Strong, Needs Work, Poor, or Critical). Click any post to see exactly which of the 16 checks it passed and which it failed, with a plain-English explanation for each.</p>
      </div>
    ),
  },
  {
    id: 3,
    title: "Understanding Your Score",
    category: "Auditing",
    body: "16 points score grade optimised strong needs work poor critical why low even reads well",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>iAudit scores every blog post out of 16. Each point represents one SEO rule. Here is what each grade means and what the 16 points check.</p>
        <h3 className="font-semibold text-base">The grades</h3>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 pr-4">Grade</th>
              <th className="text-left py-1 pr-4">Score</th>
              <th className="text-left py-1">What it means</th>
            </tr>
          </thead>
          <tbody className="space-y-1">
            {[
              ["Optimised", "14–16", "Your post is doing very well. Minor improvements only."],
              ["Strong", "11–13", "Good post. A few things to fix to reach the top."],
              ["Needs Work", "8–10", "Several issues. A rewrite will make a big difference."],
              ["Poor", "5–7", "Many issues. This post needs significant work."],
              ["Critical", "0–4", "This post is unlikely to rank. A full rewrite is recommended."],
            ].map(([grade, score, meaning]) => (
              <tr key={grade} className="border-b border-border/50">
                <td className="py-1 pr-4 font-medium">{grade}</td>
                <td className="py-1 pr-4 text-muted-foreground">{score}</td>
                <td className="py-1">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="font-semibold text-base">The 16 points</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2 text-xs">
          <li>Focus keyword appears enough times (1–2% of total words)</li>
          <li>Focus keyword is in the main heading (H1)</li>
          <li>Focus keyword is in at least one subheading (H2)</li>
          <li>Focus keyword is in at least one smaller subheading (H3)</li>
          <li>Focus keyword appears in the first 100 words</li>
          <li>Focus keyword is in the page URL</li>
          <li>Meta title is 50–60 characters and includes the keyword</li>
          <li>Meta description is 140–160 characters and includes the keyword</li>
          <li>The post answers the reader's main question in the first paragraph</li>
          <li>The post links to at least one trustworthy external source</li>
          <li>The post includes a clear call to action linking to your website</li>
          <li>The post links to at least one other blog post on your website</li>
          <li>The page has structured data (schema markup) for search engines</li>
          <li>The post shows real experience and expertise (E-E-A-T signals)</li>
          <li>The post sounds like a real person wrote it, not a robot</li>
          <li>The post is the right length for its topic (cornerstone, pillar, or cluster)</li>
        </ol>
        <h3 className="font-semibold text-base">Why might a post score low even if it reads well?</h3>
        <p>A post can be beautifully written but still score low because search engines look for specific signals that are invisible to readers. For example, your post might not have a meta description, or the focus keyword might not appear in the right headings. iAudit checks all of these technical signals automatically.</p>
      </div>
    ),
  },
  {
    id: 4,
    title: "Focus Keywords — What They Are and How to Choose One",
    category: "Keywords",
    body: "focus keyword why every post needs one how to find keyword missing flag what to do",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">What is a focus keyword?</h3>
        <p>A focus keyword is the main phrase that a blog post is trying to rank for in Google. It is the thing someone would type into Google to find your post. For example, a post about hiring a plumber in Brisbane might have the focus keyword <em>plumber Brisbane</em>.</p>
        <h3 className="font-semibold text-base">Why does every post need exactly one?</h3>
        <p>Search engines work best when each page has one clear topic. If a post tries to rank for too many things at once, it usually ranks for nothing. One focus keyword keeps the post focused and tells Google exactly what the page is about.</p>
        <h3 className="font-semibold text-base">How to find your focus keyword</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Think about what question your post answers. What would someone type into Google to find it?</li>
          <li>Try to be specific. <em>Brisbane accountant for small business</em> is better than just <em>accountant</em>.</li>
          <li>If you use a WordPress SEO plugin like Yoast or Rank Math, iAudit will import the keyword you already set there automatically.</li>
          <li>If you are not sure, click the post in iAudit and use the keyword entry field to type your best guess. You can always change it later.</li>
        </ol>
        <h3 className="font-semibold text-base">What to do if iAudit shows "Keyword Missing"</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Click the post in your Post List.</li>
          <li>Look for the <strong>Set Keyword</strong> button next to the post.</li>
          <li>Type in your chosen keyword and click <strong>Save Keyword</strong>.</li>
          <li>Run the audit again — the Keyword Missing warning will disappear.</li>
        </ol>
      </div>
    ),
  },
  {
    id: 5,
    title: "Secondary Keywords — What They Are and How to Add Them",
    category: "Keywords",
    body: "secondary keywords support primary keyword where to find how to add manually",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">What are secondary keywords?</h3>
        <p>Secondary keywords are related phrases that support your main focus keyword. They help your post show up for more searches without confusing the main topic. For example, if your focus keyword is <em>plumber Brisbane</em>, your secondary keywords might be <em>emergency plumber Brisbane</em>, <em>blocked drain Brisbane</em>, and <em>hot water repairs Brisbane</em>.</p>
        <h3 className="font-semibold text-base">Why do they matter?</h3>
        <p>Google does not just look for your exact focus keyword. It also looks for related words and phrases that show your post is genuinely about the topic. Secondary keywords help your post appear in more searches and make the content feel more natural and complete.</p>
        <h3 className="font-semibold text-base">Where to find secondary keywords</h3>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li>Look at the <strong>People Also Ask</strong> box in Google when you search for your focus keyword.</li>
          <li>Look at the <strong>Related Searches</strong> at the bottom of Google search results.</li>
          <li>Think about the different ways people might describe the same thing.</li>
        </ul>
        <h3 className="font-semibold text-base">How to add secondary keywords in iAudit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to your Post List and click the post you want to update.</li>
          <li>Click <strong>Review &amp; Edit</strong> to open the editing screen.</li>
          <li>Find the <strong>Secondary Keywords</strong> field.</li>
          <li>Type your secondary keywords separated by commas (for example: <em>emergency plumber Brisbane, blocked drain Brisbane</em>).</li>
          <li>Click <strong>Save Keyword</strong>. iAudit will use these keywords when it rewrites your post.</li>
        </ol>
      </div>
    ),
  },
  {
    id: 6,
    title: "Cannibalisation Warnings — What They Mean and How to Fix Them",
    category: "Keywords",
    body: "cannibalisation two posts fighting same search term warning why matters how to fix change keyword merge posts",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">What is keyword cannibalisation?</h3>
        <p>Keyword cannibalisation happens when two or more of your blog posts are trying to rank for the same focus keyword. This is a problem because Google gets confused about which page to show in search results. Instead of one strong page ranking well, you end up with two weak pages competing against each other — and often neither ranks at all.</p>
        <h3 className="font-semibold text-base">What the warning looks like</h3>
        <p>When iAudit finds two posts with the same focus keyword, it shows a yellow warning banner on both posts that says something like: <em>"Cannibalisation warning — another post is targeting the same keyword."</em> The warning links to both posts so you can compare them.</p>
        <h3 className="font-semibold text-base">Why it matters</h3>
        <p>If you leave cannibalisation unfixed, both posts will rank lower than they should. Fixing it is one of the quickest ways to improve your search rankings.</p>
        <h3 className="font-semibold text-base">How to fix it — Option 1: Change the keyword on one post</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Decide which post is the stronger one (usually the longer, more detailed one).</li>
          <li>Open the weaker post in iAudit.</li>
          <li>Change its focus keyword to something more specific. For example, if both posts use <em>plumber Brisbane</em>, change the weaker one to <em>emergency plumber Brisbane</em>.</li>
          <li>Run the audit again. The cannibalisation warning will disappear once the keywords are different.</li>
        </ol>
        <h3 className="font-semibold text-base">How to fix it — Option 2: Merge the two posts</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Copy the best content from both posts into one combined post.</li>
          <li>Delete or redirect the weaker post in your CMS.</li>
          <li>Update the remaining post in iAudit with the merged content.</li>
        </ol>
      </div>
    ),
  },
  {
    id: 7,
    title: "Choosing Full Rewrite or Smart Patch — When to Use Each",
    category: "Rewriting",
    body: "full rewrite smart patch when to use rebuilding from scratch writing good seo structure needs fixing what each mode does",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">The two rewrite modes</h3>
        <p>iAudit gives you two ways to fix a post. Both use 1 credit.</p>
        <div className="space-y-3">
          <div className="rounded-lg border border-border p-3">
            <h4 className="font-semibold mb-1">Full Rewrite</h4>
            <p className="text-muted-foreground text-xs mb-2">Best for posts that need rebuilding from scratch</p>
            <p>A Full Rewrite rewrites your entire post from the beginning. It keeps your key facts and your business information, but it rebuilds the structure, headings, and language to fix all 16 SEO points. Use this when your post scores below 8/16, when the writing is hard to follow, or when the post is very short and needs to be expanded.</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <h4 className="font-semibold mb-1">Smart Patch</h4>
            <p className="text-muted-foreground text-xs mb-2">Best for posts where the writing is good but the SEO structure needs fixing</p>
            <p>A Smart Patch makes targeted fixes to your post without changing the overall writing style or voice. It fixes things like missing keywords in headings, short meta descriptions, and missing internal links — but it tries to preserve the way you write. Use this when your post scores 8/16 or above and the writing feels right, but a few technical SEO things are failing.</p>
          </div>
        </div>
        <h3 className="font-semibold text-base">Not sure which to choose?</h3>
        <p>If your post scores below 8, choose Full Rewrite. If it scores 8 or above and you like the way it reads, choose Smart Patch.</p>
      </div>
    ),
  },
  {
    id: 8,
    title: "Running a Rewrite — What Happens and How Long It Takes",
    category: "Rewriting",
    body: "rewrite what happens pass 1 pass 2 how long score when comes back",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">Before the rewrite starts</h3>
        <p>When you click <strong>Fix This Post</strong>, iAudit will ask you to confirm a <strong>People Also Ask question</strong>. This is the main question your post will answer. iAudit suggests one automatically — you can accept it or type your own. This question becomes the opening of your rewritten post.</p>
        <p>iAudit will also ask you to choose between <strong>Full Rewrite</strong> and <strong>Smart Patch</strong>. See the separate guide on choosing between them if you are not sure.</p>
        <h3 className="font-semibold text-base">What happens during the rewrite</h3>
        <p>The rewrite runs in two steps:</p>
        <ul className="list-disc list-inside space-y-2 pl-2">
          <li><strong>Pass 1 — The SEO rewrite.</strong> iAudit rewrites your post to fix all the failing SEO points. It uses your business profile, your focus keyword, your secondary keywords, and the People Also Ask question to write a post that is structured correctly for search engines.</li>
          <li><strong>Pass 2 — The voice scrub.</strong> iAudit goes through the rewritten post a second time to make it sound more natural and less like it was written by a robot. It does not change the SEO structure — it just improves the language.</li>
        </ul>
        <h3 className="font-semibold text-base">How long does it take?</h3>
        <p>A rewrite usually takes 2–4 minutes. The progress bar shows you which step is running. Do not close the page while the rewrite is running.</p>
        <h3 className="font-semibold text-base">What you see when it finishes</h3>
        <p>When the rewrite is done, iAudit shows you the new score and grade. Most rewrites score 13/16 or higher. If the score is below 13, iAudit automatically tries again once. If the second attempt also scores below 13, your credit is refunded and iAudit flags the post for manual review.</p>
      </div>
    ),
  },
  {
    id: 9,
    title: "Reviewing and Editing Your Rewrite",
    category: "Rewriting",
    body: "editing screen what each field does url cannot be changed auto-save how to export post",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">How to open the editing screen</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to your Post List and find the post you want to review.</li>
          <li>Click the post row, then click <strong>Review &amp; Edit</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">What each field does</h3>
        <ul className="list-disc list-inside space-y-2 pl-2">
          <li><strong>Title</strong> — The heading of your post as it appears on your website. You can edit this freely.</li>
          <li><strong>Meta Title</strong> — The title that appears in Google search results. Should be 50–60 characters and include your focus keyword.</li>
          <li><strong>Meta Description</strong> — The short description that appears under your title in Google. Should be 140–160 characters.</li>
          <li><strong>Focus Keyword</strong> — The main keyword this post is targeting. You can change it here and click Save Keyword to update it.</li>
          <li><strong>Secondary Keywords</strong> — Supporting keywords separated by commas.</li>
          <li><strong>Body</strong> — The full content of your post. You can edit this directly.</li>
        </ul>
        <h3 className="font-semibold text-base">Why can't I change the URL?</h3>
        <p>The URL (web address) of your post is set by your CMS (WordPress, Wix, or Shopify) and cannot be changed from inside iAudit. If you need to change the URL, log in to your CMS directly and update it there. Be careful — changing a URL can break links from other websites, so only do this if necessary.</p>
        <h3 className="font-semibold text-base">How auto-save works</h3>
        <p>iAudit saves your edits automatically as you type. You will see a small "Saved" indicator at the top of the page. You do not need to click a Save button for your edits to be kept.</p>
        <h3 className="font-semibold text-base">How to export your post</h3>
        <p>When you are happy with your edits, click the <strong>Export</strong> button. You can export as Plain Text, HTML, or Markdown. See the separate guide on exporting for instructions on where to paste each format.</p>
      </div>
    ),
  },
  {
    id: 10,
    title: "Posting Back to Your Website",
    category: "Publishing",
    body: "post-back how it works what gets preserved author date status url what gets updated content meta title description alt texts what to do if fails",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">What is post-back?</h3>
        <p>Post-back is the feature that sends your rewritten post back to your website automatically. Instead of copying and pasting your content into WordPress, Wix, or Shopify, iAudit does it for you with one click.</p>
        <h3 className="font-semibold text-base">How to post back</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Open the post in the Review &amp; Edit screen.</li>
          <li>When you are happy with the content, click <strong>Post Back to Website</strong>.</li>
          <li>iAudit will update your post on your website within a few seconds.</li>
        </ol>
        <h3 className="font-semibold text-base">What gets preserved (not changed)</h3>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li>Author name and author ID</li>
          <li>Original publish date</li>
          <li>Post status (published, draft, or scheduled)</li>
          <li>Post URL (web address)</li>
          <li>Categories and tags</li>
        </ul>
        <h3 className="font-semibold text-base">What gets updated</h3>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li>Post body (the main content)</li>
          <li>Meta title</li>
          <li>Meta description</li>
          <li>Image alt texts</li>
          <li>Schema markup (structured data for Google)</li>
        </ul>
        <h3 className="font-semibold text-base">What to do if post-back fails</h3>
        <p>If post-back fails, iAudit will show you an error message explaining why. The most common reasons are:</p>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li>Your CMS credentials have expired — go to the CMS Connection settings and reconnect.</li>
          <li>The post was deleted from your CMS — you will need to create a new post manually and paste the content in.</li>
          <li>Your CMS is temporarily unavailable — wait a few minutes and try again.</li>
        </ul>
        <p>If post-back is not available for your platform (for example, Wix has limited API access), iAudit will show you a JSON-LD code block that you can copy and paste into your CMS manually.</p>
      </div>
    ),
  },
  {
    id: 11,
    title: "Exporting Your Post — Plain Text, HTML, and Markdown",
    category: "Publishing",
    body: "export plain text html markdown where to paste wordpress wix shopify",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">When to use export instead of post-back</h3>
        <p>Post-back updates your website automatically. Export is for when you want to copy the content yourself — for example, if you want to review it in a document first, or if your CMS is not connected.</p>
        <h3 className="font-semibold text-base">How to export</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Open the post in the Review &amp; Edit screen.</li>
          <li>Click the <strong>Export</strong> button.</li>
          <li>Choose your format: Plain Text, HTML, or Markdown.</li>
          <li>The content will be copied to your clipboard automatically.</li>
        </ol>
        <h3 className="font-semibold text-base">Which format to use</h3>
        <div className="space-y-2">
          <div className="rounded border border-border p-2">
            <p className="font-medium text-xs">Plain Text</p>
            <p className="text-xs text-muted-foreground">Use this if you want to paste the content into a document or email. All formatting is removed.</p>
          </div>
          <div className="rounded border border-border p-2">
            <p className="font-medium text-xs">HTML</p>
            <p className="text-xs text-muted-foreground">Use this for WordPress (paste into the HTML/Code editor), or for any CMS that accepts HTML. This preserves all headings, bold text, and links.</p>
          </div>
          <div className="rounded border border-border p-2">
            <p className="font-medium text-xs">Markdown</p>
            <p className="text-xs text-muted-foreground">Use this for platforms that accept Markdown formatting, such as Ghost or some Shopify themes. Also useful if you use a Markdown editor.</p>
          </div>
        </div>
        <h3 className="font-semibold text-base">Where to paste in each CMS</h3>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li><strong>WordPress</strong> — Open the post editor, click the three-dot menu (⋯) in the top right, choose <em>Code editor</em>, and paste the HTML there.</li>
          <li><strong>Wix</strong> — Open the post in Wix Blog, click the HTML embed block, and paste the HTML there.</li>
          <li><strong>Shopify</strong> — Open the blog post in Shopify admin, click the <em>HTML</em> button in the editor toolbar, and paste the HTML there.</li>
        </ul>
      </div>
    ),
  },
  {
    id: 12,
    title: "Buying Credits — How They Work and Which Pack to Choose",
    category: "Credits",
    body: "credits how work which pack choose how many posts need fixing what happens run out never expire",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <h3 className="font-semibold text-base">How credits work</h3>
        <p>Each time you rewrite a post (Full Rewrite or Smart Patch), iAudit uses 1 credit. Auditing posts is always free — it never uses credits. Credits never expire, so you can buy a pack now and use them whenever you are ready.</p>
        <h3 className="font-semibold text-base">Which pack to choose</h3>
        <p>Count how many posts in your Post List have a grade of <em>Needs Work</em>, <em>Poor</em>, or <em>Critical</em>. That is roughly how many credits you need. If you are not sure, start with a smaller pack — you can always buy more later.</p>
        <h3 className="font-semibold text-base">What happens when credits run out</h3>
        <p>If you try to rewrite a post and you have no credits left, iAudit will show you a message: <em>"You have no credits remaining. Buy more to continue rewriting posts."</em> You will not be charged anything — the rewrite simply will not start until you buy more credits.</p>
        <h3 className="font-semibold text-base">How to buy credits</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Click <strong>Credits</strong> in the left sidebar.</li>
          <li>Choose the credit pack you want.</li>
          <li>Click <strong>Buy Now</strong>. You will be taken to a secure payment page.</li>
          <li>After payment, your credits will be added to your account immediately.</li>
        </ol>
        <h3 className="font-semibold text-base">Credit refunds</h3>
        <p>If a rewrite fails to reach a score of 13/16 even after a second attempt, iAudit automatically refunds your credit. You will see the refund in your credit history.</p>
      </div>
    ),
  },
  {
    id: 13,
    title: "Connecting WordPress — Step-by-Step Instructions",
    category: "Connecting Your CMS",
    body: "wordpress application password step by step instructions admin settings credentials never been inside wordpress before",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>To connect iAudit to WordPress, you need to create an <strong>Application Password</strong> inside your WordPress admin area. This is a special password just for iAudit — it is not your normal WordPress login password.</p>
        <h3 className="font-semibold text-base">Step 1 — Log in to WordPress admin</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to <em>yourwebsite.com/wp-admin</em> in your browser.</li>
          <li>Log in with your WordPress username and password.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 2 — Go to your user profile</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>In the left sidebar, hover over <strong>Users</strong>.</li>
          <li>Click <strong>Profile</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 3 — Create an Application Password</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Scroll down the Profile page until you see a section called <strong>Application Passwords</strong>.</li>
          <li>In the <em>New Application Password Name</em> field, type <strong>iAudit</strong>.</li>
          <li>Click <strong>Add New Application Password</strong>.</li>
          <li>WordPress will show you a long password made up of letters and numbers with spaces in it (for example: <em>AbCd EfGh IjKl MnOp QrSt UvWx</em>). <strong>Copy this password now</strong> — WordPress will only show it once.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 4 — Enter the details in iAudit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go back to iAudit and open the <strong>CMS Connection</strong> screen.</li>
          <li>Choose <strong>WordPress</strong> as your platform.</li>
          <li>Enter your website URL (for example, <em>https://yourwebsite.com.au</em>).</li>
          <li>Enter your WordPress username (the one you use to log in).</li>
          <li>Paste the Application Password you just copied.</li>
          <li>Click <strong>Connect</strong>.</li>
        </ol>
        <p className="text-muted-foreground text-xs">If you see an error, make sure your website URL does not have a trailing slash, and that your WordPress REST API is not blocked by a security plugin.</p>
      </div>
    ),
  },
  {
    id: 14,
    title: "Connecting Wix — Step-by-Step Instructions",
    category: "Connecting Your CMS",
    body: "wix api key site id step by step instructions find enter into iaudit",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>To connect iAudit to Wix, you need two things: your <strong>Site ID</strong> and a <strong>Wix API Key</strong>. Here is how to find them.</p>
        <h3 className="font-semibold text-base">Step 1 — Find your Wix Site ID</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Log in to your Wix account at <em>manage.wix.com</em>.</li>
          <li>Click on your website to open its dashboard.</li>
          <li>Look at the URL in your browser. It will look something like: <em>manage.wix.com/dashboard/<strong>xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</strong>/home</em></li>
          <li>The long string of letters and numbers between <em>/dashboard/</em> and <em>/home</em> is your Site ID. Copy it.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 2 — Create a Wix API Key</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>In your Wix dashboard, click <strong>Settings</strong> in the left sidebar.</li>
          <li>Scroll down and click <strong>API Keys</strong> (under the <em>Advanced</em> section).</li>
          <li>Click <strong>Generate API Key</strong>.</li>
          <li>Give it a name (for example, <em>iAudit</em>).</li>
          <li>Under <em>Permissions</em>, make sure <strong>Wix Blog</strong> is selected.</li>
          <li>Click <strong>Generate</strong>.</li>
          <li>Copy the API key that appears. <strong>Save it somewhere safe</strong> — Wix will only show it once.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 3 — Enter the details in iAudit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to the <strong>CMS Connection</strong> screen in iAudit.</li>
          <li>Choose <strong>Wix</strong> as your platform.</li>
          <li>Paste your Site ID into the <em>Site ID</em> field.</li>
          <li>Paste your API Key into the <em>API Key</em> field.</li>
          <li>Click <strong>Connect</strong>.</li>
        </ol>
        <p className="text-muted-foreground text-xs">Note: Wix has limited API access for updating posts. iAudit can import your posts and provide rewritten content, but direct post-back to Wix may not be available. iAudit will provide a copy-paste option instead.</p>
      </div>
    ),
  },
  {
    id: 15,
    title: "Connecting Shopify — Step-by-Step Instructions",
    category: "Connecting Your CMS",
    body: "shopify custom app blog read write permissions api key step by step instructions",
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p>To connect iAudit to Shopify, you need to create a <strong>Custom App</strong> in your Shopify admin area and give it permission to read and write your blog posts.</p>
        <h3 className="font-semibold text-base">Step 1 — Go to your Shopify admin</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Log in to your Shopify store at <em>yourstore.myshopify.com/admin</em>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 2 — Create a Custom App</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>In the left sidebar, click <strong>Settings</strong>.</li>
          <li>Click <strong>Apps and sales channels</strong>.</li>
          <li>Click <strong>Develop apps</strong> at the top right of the page.</li>
          <li>If prompted, click <strong>Allow custom app development</strong> to enable it.</li>
          <li>Click <strong>Create an app</strong>.</li>
          <li>Give the app a name (for example, <em>iAudit</em>) and click <strong>Create app</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 3 — Set the permissions</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Click <strong>Configure Admin API scopes</strong>.</li>
          <li>Find <strong>Content</strong> in the list and tick both <strong>read_content</strong> and <strong>write_content</strong>.</li>
          <li>Click <strong>Save</strong>.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 4 — Get your API key</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Click <strong>Install app</strong>.</li>
          <li>Click <strong>Install</strong> to confirm.</li>
          <li>You will see your <strong>Admin API access token</strong>. It starts with <em>shpat_</em>. Copy it now — Shopify will only show it once.</li>
        </ol>
        <h3 className="font-semibold text-base">Step 5 — Enter the details in iAudit</h3>
        <ol className="list-decimal list-inside space-y-1 pl-2">
          <li>Go to the <strong>CMS Connection</strong> screen in iAudit.</li>
          <li>Choose <strong>Shopify</strong> as your platform.</li>
          <li>Enter your store URL (for example, <em>yourstore.myshopify.com</em>).</li>
          <li>Paste your Admin API access token into the <em>Access Token</em> field.</li>
          <li>Click <strong>Connect</strong>.</li>
        </ol>
      </div>
    ),
  },
];

// ─── Article component ────────────────────────────────────────────────────────

function ArticleCard({ article }: { article: Article }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between p-4 text-left hover:bg-accent/50 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="flex items-start gap-3 min-w-0">
          <Badge variant="outline" className="shrink-0 text-xs">
            {article.category}
          </Badge>
          <span className="font-medium text-sm leading-snug">{article.title}</span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 ml-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 ml-3 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-0 border-t border-border bg-background/50">
          <div className="pt-4">{article.content}</div>
        </div>
      )}
    </div>
  );
}

// ─── Contact form ─────────────────────────────────────────────────────────────

function ContactForm() {
  const { user } = useIauditAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  const sendMutation = trpc.support.sendContactEmail.useMutation({
    onSuccess: () => {
      setSent(true);
      setSubject("");
      setMessage("");
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to send message. Please try again.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.length < 20) {
      toast.error("Your message must be at least 20 characters.");
      return;
    }
    sendMutation.mutate({ name, email, subject, message });
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
        <p className="font-semibold">Your message has been sent.</p>
        <p className="text-muted-foreground text-sm">
          We will get back to you within 1 business day.
        </p>
        <Button variant="outline" size="sm" onClick={() => setSent(false)} className="mt-2">
          Send another message
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Email</label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Subject</label>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="What do you need help with?"
          required
          maxLength={200}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Message</label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe your question or issue in detail (minimum 20 characters)..."
          rows={5}
          required
          minLength={20}
          maxLength={5000}
        />
        <p className="text-xs text-muted-foreground text-right">{message.length}/5000</p>
      </div>
      <Button
        type="submit"
        disabled={sendMutation.isPending || message.length < 20}
        className="w-full sm:w-auto"
      >
        {sendMutation.isPending ? "Sending..." : "Send Message"}
      </Button>
    </form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SupportCentre() {
  const [search, setSearch] = useState("");

  const filteredArticles = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ARTICLES;
    return ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
    );
  }, [search]);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Support Centre</h1>
        <p className="text-muted-foreground">
          Find answers to common questions, or send us a message and we will get back to you within 1 business day.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search help articles..."
          className="pl-9"
          aria-label="Search help articles"
        />
      </div>

      {/* Articles */}
      <div className="space-y-3">
        {filteredArticles.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No articles found for that search. Contact us below and we will help.
          </div>
        ) : (
          filteredArticles.map((article) => (
            <ArticleCard key={article.id} article={article} />
          ))
        )}
      </div>

      <Separator />

      {/* Contact form */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Contact Us</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Can't find what you're looking for? Send us a message and we will get back to you within 1 business day.
        </p>
        <ContactForm />
      </div>
    </div>
  );
}
