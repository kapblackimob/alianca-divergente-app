import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SETTINGS_KEY = "coach_provider";

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
    const adminEmail = Deno.env.get("ADMIN_EMAIL");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Sessão inválida. Faça login novamente." }, 401);

    if (!adminEmail || userData.user.email?.toLowerCase() !== adminEmail.toLowerCase()) {
      return json({ error: "Acesso restrito ao administrador." }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { action, provider } = await req.json();

    if (action === "get") {
      const { data } = await admin.from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
      return json({ provider: data?.value?.provider === "openai" ? "openai" : "claude" });
    }

    if (action === "set") {
      if (provider !== "claude" && provider !== "openai") {
        return json({ error: "Provedor inválido." }, 400);
      }
      await admin.from("app_settings").upsert({ key: SETTINGS_KEY, value: { provider } });
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
