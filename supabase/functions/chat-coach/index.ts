import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_LIMIT = 30;
const CLAUDE_MODEL = "claude-sonnet-5";
const OPENAI_MODEL = "gpt-4o";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Sessão ausente. Faça login novamente." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Sessão inválida. Faça login novamente." }, 401);
    const userId = userData.user.id;

    const { messages, system, provider } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Mensagem vazia." }, 400);
    }
    const useOpenAI = provider === "openai";

    const admin = createClient(supabaseUrl, serviceKey);
    const today = new Date().toISOString().slice(0, 10);

    const { data: usageRow } = await admin
      .from("chat_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", today)
      .maybeSingle();

    const currentCount = usageRow?.count ?? 0;
    if (currentCount >= DAILY_LIMIT) {
      return json({ error: "Limite diário de mensagens do Coach IA atingido. Tente novamente amanhã." }, 429);
    }

    let reply: string;

    if (useOpenAI) {
      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      if (!openaiKey) return json({ error: "Coach IA (OpenAI) não configurado no servidor." }, 500);

      const openaiMsgs = [{ role: "system", content: system }].concat(messages);
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + openaiKey,
        },
        body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: 900, messages: openaiMsgs }),
      });

      if (!openaiRes.ok) {
        const errText = await openaiRes.text();
        return json({ error: "Erro ao contatar a IA: " + errText.slice(0, 300) }, 502);
      }
      const result = await openaiRes.json();
      reply = (result.choices?.[0]?.message?.content || "").trim() || "(sem resposta)";
    } else {
      const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!anthropicKey) return json({ error: "Coach IA (Claude) não configurado no servidor." }, 500);

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 900, system, messages }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return json({ error: "Erro ao contatar a IA: " + errText.slice(0, 300) }, 502);
      }
      const result = await anthropicRes.json();
      reply = (result.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("")
        .trim() || "(sem resposta)";
    }

    await admin.from("chat_usage").upsert(
      { user_id: userId, day: today, count: currentCount + 1 },
      { onConflict: "user_id,day" },
    );

    return json({ reply });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
