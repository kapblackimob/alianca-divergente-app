import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_LIMIT = 30;
const CLAUDE_MODEL = "claude-sonnet-5";
const OPENAI_MODEL = "gpt-4o";
const SETTINGS_KEY = "coach_provider";
const MAX_TOKENS = 900;
const MAX_TOKENS_STRUCTURED = 1200; // texto + sugestões em JSON

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

// Resposta estruturada: o texto para o Aliado e as sugestões que o app mostra
// como cartões com Aplicar/Ignorar. Campos que não se aplicam vêm nulos.
const texto = { type: ["string", "null"] };
const opcoes = (valores: string[]) => ({ type: ["string", "null"], enum: [...valores, null] });
const CAMPOS_SUGESTAO: Record<string, unknown> = {
  tipo: { type: "string", enum: ["nucleo", "marca_passos"] },
  acao: { type: "string", enum: ["alterar", "adicionar", "criar", "atualizar"] },
  nucleo: opcoes(["interno", "externo"]),
  nome: texto,
  vinculo: texto,
  quadrante: opcoes(["Vítima Natural", "Vítima Intencional", "Vingador", "Narcisista"]),
  nivel: { type: ["integer", "null"] },
  padrao: texto,
  tipo_padrao: opcoes(["Acontecimento", "Comportamento", "Relacionamento"]),
  pilar: opcoes(["Geral", "Financeiro", "Saúde", "Relacionamento"]),
  perceber: texto,
  decidir: texto,
  agir: texto,
  prazo: texto,
  degrau: opcoes(["Reclamar/Justificar", "Questionar", "Propor/Aplicar"]),
  status: opcoes(["Não iniciado", "Em andamento", "Concluído", "Travado"]),
  motivo: { type: "string" },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  // A ordem importa: o modelo escreve primeiro a leitura, depois as sugestões e por
  // último a resposta, então compara o relato com o mapa antes de conversar.
  required: ["leitura", "sugestoes", "resposta"],
  properties: {
    leitura: {
      type: "string",
      description: "Uma ou duas frases, não mostradas ao Aliado: compare o que ele acabou de contar com o que está no resumo das ferramentas (padrão e nível das pessoas citadas, itens do Marca Passos) e diga se algo deveria mudar.",
    },
    sugestoes: {
      type: "array",
      description: "Mudanças propostas no Núcleo Emocional ou no Marca Passos, que o Aliado aplica com um clique. Lista vazia quando não houver.",
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(CAMPOS_SUGESTAO),
        properties: CAMPOS_SUGESTAO,
      },
    },
    resposta: { type: "string", description: "Texto da resposta ao Aliado, em prosa. Se houver sugestões, diga em uma frase o que sugeriu e que aparece logo abaixo." },
  },
};

type Chamada = { ok: true; text: string } | { ok: false; status: number; error: string };

async function chamarOpenAI(key: string, system: string, messages: unknown[], structured: boolean): Promise<Chamada> {
  const body: Record<string, unknown> = {
    model: OPENAI_MODEL,
    max_tokens: structured ? MAX_TOKENS_STRUCTURED : MAX_TOKENS,
    messages: [{ role: "system", content: system }].concat(messages as { role: string; content: string }[]),
  };
  if (structured) {
    body.response_format = { type: "json_schema", json_schema: { name: "coach_resposta", strict: true, schema: SCHEMA } };
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + key },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
  const result = await res.json();
  const msg = result.choices?.[0]?.message ?? {};
  return { ok: true, text: (msg.content || msg.refusal || "").trim() };
}

async function chamarClaude(key: string, system: string, messages: unknown[], structured: boolean): Promise<Chamada> {
  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: structured ? MAX_TOKENS_STRUCTURED : MAX_TOKENS,
    system,
    messages,
  };
  if (structured) body.output_config = { format: { type: "json_schema", schema: SCHEMA } };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
  const result = await res.json();
  const text = (result.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  return { ok: true, text };
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

    // structured: só a versão nova do app pede; versões em cache seguem recebendo só o texto
    const { messages, system, structured } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Mensagem vazia." }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: settingsRow } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();
    const useOpenAI = settingsRow?.value?.provider === "openai";

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

    const key = Deno.env.get(useOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    if (!key) return json({ error: "Coach IA (" + (useOpenAI ? "OpenAI" : "Claude") + ") não configurado no servidor." }, 500);
    const chamar = useOpenAI ? chamarOpenAI : chamarClaude;

    let reply = "";
    let sugestoes: unknown[] | undefined;

    let resultado = await chamar(key, system, messages, structured === true);
    if (!resultado.ok && structured === true && resultado.status === 400) {
      // o provedor recusou o formato estruturado: responde em texto para o Coach não parar
      console.error("Formato estruturado recusado, voltando para texto:", resultado.error);
      resultado = await chamar(key, system, messages, false);
    } else if (resultado.ok && structured === true) {
      try {
        const parsed = JSON.parse(resultado.text);
        reply = String(parsed.resposta ?? "").trim();
        sugestoes = Array.isArray(parsed.sugestoes) ? parsed.sugestoes : [];
      } catch (_) {
        // resposta cortada ou fora do formato: aproveita o texto se der
        const m = resultado.text.match(/"resposta"\s*:\s*"((?:[^"\\]|\\.)*)/);
        reply = resultado.text;
        if (m) {
          try { reply = JSON.parse('"' + m[1] + '"'); } catch (_) { reply = m[1]; }
        }
      }
    }
    if (!resultado.ok) {
      return json({ error: "Erro ao contatar a IA: " + resultado.error }, 502);
    }
    if (!reply) reply = sugestoes === undefined ? resultado.text : "";
    reply = reply || "(sem resposta)";

    await admin.from("chat_usage").upsert(
      { user_id: userId, day: today, count: currentCount + 1 },
      { onConflict: "user_id,day" },
    );

    // modo: "estruturado" quando o formato foi aceito; "texto" quando não houve ou caiu no plano B
    return json(sugestoes === undefined ? { reply, modo: "texto" } : { reply, sugestoes, modo: "estruturado" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
