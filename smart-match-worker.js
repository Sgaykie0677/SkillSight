// Cloudflare Worker: Smart Match scoring backend for SkillSight.
//
// Setup:
//   1. wrangler secret put ANTHROPIC_API_KEY
//   2. wrangler deploy
//   3. Copy the deployed URL into CONFIG.API_ENDPOINT in smart-match.html
//
// This worker exists so the Anthropic API key never touches the browser.
// The frontend sends resume + job text; this worker builds the prompt,
// calls Anthropic, and returns only the structured score.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { resume, job_title, duties, soft_requirements } = body;

    if (!resume || !job_title) {
      return new Response(JSON.stringify({ error: "resume and job_title are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const prompt = `You are scoring how well a candidate's resume matches a job's soft requirements. Do not consider protected characteristics (race, age, sex, disability, national origin, etc.) in any way; score only on stated skills and experience.

JOB: ${job_title}
DUTIES: ${duties || "Not specified"}
SOFT REQUIREMENTS: ${soft_requirements || "Not specified"}

RESUME:
${resume}

Return ONLY valid JSON, no markdown fences, no preamble, in exactly this shape:
{"match_score":0,"why_match":"short phrase under 16 words","why_not":"short phrase under 16 words","flagged_for_review":false}

Set flagged_for_review to true if match_score is between 40 and 60 inclusive.`;

    try {
      const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }]
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return new Response(JSON.stringify({ error: `Anthropic API error: ${errText.slice(0, 200)}` }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const data = await anthropicResponse.json();
      const textBlock = (data.content || []).find(c => c.type === "text");
      if (!textBlock) throw new Error("No text in model response");

      let raw = textBlock.text.trim().replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object in model response");
      raw = raw.slice(firstBrace, lastBrace + 1);

      const parsed = JSON.parse(raw);

      return new Response(JSON.stringify(parsed), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
