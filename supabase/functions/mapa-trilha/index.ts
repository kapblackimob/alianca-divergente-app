// Entrega a trilha do Mapa do Impossível para o app.
// O conteúdo do curso mora na linha coach_mapa de app_settings (nunca no repositório)
// e só sai daqui para o dono do app: qualquer outro usuário recebe 403.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAPA_KEY = "coach_mapa";

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

// O dono usa apelidos do proprio e-mail (katio.almeida+testapp@gmail.com) para
// testar e demonstrar. Para o Mapa, que e material de estudo pessoal, esses
// apelidos contam como a mesma conta. O provedor de IA continua so no e-mail exato.
function mesmaConta(email: string | undefined, dono: string | undefined): boolean {
  if (!email || !dono) return false;
  const base = (e: string) => {
    const [nome, dominio] = e.toLowerCase().trim().split("@");
    return nome && dominio ? nome.split("+")[0] + "@" + dominio : e.toLowerCase().trim();
  };
  return base(email) === base(dono);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Sessão ausente. Faça login novamente." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Sessão inválida. Faça login novamente." }, 401);

    const adminEmail = Deno.env.get("ADMIN_EMAIL");
    if (!mesmaConta(userData.user.email, adminEmail)) {
      return json({ error: "Conteúdo restrito." }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: row } = await admin.from("app_settings").select("value").eq("key", MAPA_KEY).maybeSingle();
    const valor = (row?.value ?? {}) as { trilha?: unknown; conceitos?: unknown; etapas?: unknown; diario?: unknown };
    const trilha = Array.isArray(valor.trilha) ? valor.trilha : [];
    if (!trilha.length) return json({ error: "A trilha ainda não foi carregada no banco." }, 404);
    const conceitos = Array.isArray(valor.conceitos) ? valor.conceitos : [];
    const etapas = Array.isArray(valor.etapas) ? valor.etapas : [];

    const diario = valor.diario && typeof valor.diario === "object" ? valor.diario : null;

    return json({ trilha, conceitos, etapas, diario });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
