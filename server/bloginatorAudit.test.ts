import { describe, it, expect } from "vitest";
import { auditHtml, AUDIT_RULES, AUDIT_MAX_POINTS } from "./bloginatorAudit";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SCHEMA_BLOCK = `
<script type="application/ld+json">
[
  {"@context":"https://schema.org","@type":"Article","headline":"Brand Strategy Guide for Australian SMEs","author":{"@type":"Person","name":"Jane Smith"},"publisher":{"@type":"Organization","name":"Acme Co"}},
  {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is a brand strategy?","acceptedAnswer":{"@type":"Answer","text":"A brand strategy defines positioning."}}]},
  {"@context":"https://schema.org","@type":"Person","name":"Jane Smith","jobTitle":"Brand Consultant"}
]
</script>`;

const GOOD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Brand Strategy Guide for Australian SMEs</title>
  <meta name="description" content="A practical brand strategy guide for Australian SMEs — covering positioning, messaging, and rollout.">
  ${SCHEMA_BLOCK}
</head>
<body>
<h1>Brand Strategy Guide for Australian SMEs</h1>
<p>Brand strategy decides how customers remember you. This guide gives you a plan.</p>

<h2>What is a brand strategy?</h2>
<p>A brand strategy is the plan that defines your positioning, audience, and message. It aligns every touchpoint so customers recognise you fast and choose you over cheaper rivals.</p>
<p>In our experience, teams that skip this step drift within months.</p>

<h2>How much does a brand strategy cost in Australia?</h2>
<p>Most SMEs spend between 3,000 and 15,000 dollars. A common mistake is paying for a logo alone; that is design, not strategy, and it rarely moves revenue.</p>
<p>We tested three pricing tiers across 40 local businesses and found the mid-range option consistently outperformed the others.</p>

<h3>Set your positioning first</h3>
<blockquote>"Positioning beats budget every time." — Jane Smith</blockquote>

<ul>
  <li><strong>Positioning:</strong> Where you sit in the market.</li>
  <li><strong>Messaging:</strong> How you communicate that position.</li>
  <li><strong>Visual identity:</strong> How it looks on screen and in print.</li>
</ul>

<p>For more on measuring brand performance, see our <a href="/blog/brand-strategy">brand strategy</a> overview and the <a href="/blog/brand-audit-checklist">brand audit checklist</a>.</p>
<p>External reading: <a href="https://business.gov.au/marketing/branding">business.gov.au branding</a> and <a href="https://en.wikipedia.org/wiki/Brand">Wikipedia — Brand</a>.</p>
</body>
</html>`;

const BAD_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Everything You Could Ever Possibly Want To Know About Building A Great Brand Today</title>
</head>
<body>
<h1>Our thoughts</h1>
<h1>More thoughts</h1>
<h2>Some background</h2>
<p>In today's fast-paced digital landscape we must delve into the multifaceted tapestry of brand building. Results are achieved by teams. Moreover, value is created by effort. Outcomes are driven by process. Success is defined by many things. Everything is considered by everyone in the organization. The work is done by people who do work. The plan is written by managers so that work can happen in a seamless and leveraging way that is transformative for all stakeholders. A great brand is a testament to the hard work and dedication of every individual contributor who brings their unique synergies and holistic perspectives to the table each and every day without exception or caveat.</p>
</body>
</html>`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AUDIT_RULES and AUDIT_MAX_POINTS", () => {
  it("has 29 rules", () => expect(AUDIT_RULES).toHaveLength(29));
  it("sums to 100 points", () => expect(AUDIT_MAX_POINTS).toBe(100));
});

describe("GOOD_HTML — fully optimised post", () => {
  const result = auditHtml({
    html: GOOD_HTML,
    primaryKeyword: "brand strategy",
    url: "https://example.com/blog/brand-strategy-guide",
    hubKeyword: "brand strategy",
    isHub: true,
    liveChecks: { coreWebVitalsPass: true, llmsTxtPresent: true },
  });

  it("scores ≥ 90 / 100", () => {
    expect(result.normalized_score).toBeGreaterThanOrEqual(90);
  });

  const checkMap = Object.fromEntries(result.checks.map(c => [c.id, c]));

  it("MIC-03 passes (question H2s)", () => expect(checkMap["MIC-03"].passed).toBe(true));
  it("MIC-05 passes (direct answer ≤ 60 words)", () => expect(checkMap["MIC-05"].passed).toBe(true));
  it("MAC-06 passes (FAQPage schema)", () => expect(checkMap["MAC-06"].passed).toBe(true));
  it("MAC-08 passes (Person schema)", () => expect(checkMap["MAC-08"].passed).toBe(true));
  it("MAC-09 passes (hub keyword in anchor)", () => expect(checkMap["MAC-09"].passed).toBe(true));
  it("EAT-05 passes (.gov link)", () => expect(checkMap["EAT-05"].passed).toBe(true));
  it("EAT-06 passes (two external domains)", () => expect(checkMap["EAT-06"].passed).toBe(true));
  it("MAC-13 passes (llmsTxt live check)", () => expect(checkMap["MAC-13"].passed).toBe(true));
});

describe("BAD_HTML — weak post", () => {
  const result = auditHtml({
    html: BAD_HTML,
    primaryKeyword: "brand strategy",
    url: "https://example.com/2019/06/post",
  });

  it("scores ≤ 35 / 100", () => {
    expect(result.normalized_score).toBeLessThanOrEqual(35);
  });

  const checkMap = Object.fromEntries(result.checks.map(c => [c.id, c]));

  it("MIC-01 fails (two H1s)", () => expect(checkMap["MIC-01"].passed).toBe(false));
  it("MIC-03 fails (no question H2s)", () => expect(checkMap["MIC-03"].passed).toBe(false));
  it("MIC-08 fails (paragraph too long)", () => expect(checkMap["MIC-08"].passed).toBe(false));
  it("EAT-08 fails (AI buzzwords)", () => expect(checkMap["EAT-08"].passed).toBe(false));
  it("MAC-05 fails (no schema)", () => expect(checkMap["MAC-05"].passed).toBe(false));
});
