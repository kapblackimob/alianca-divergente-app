import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DAILY_LIMIT = 30;
const CLAUDE_MODEL = "claude-sonnet-5";
const OPENAI_MODEL = "gpt-4o";
const SETTINGS_KEY = "coach_provider";
const MAPA_KEY = "coach_mapa"; // base de estudo do Mapa do Impossível (só para o administrador)
const MAPA_CORTES = 12; // trechos de vídeo enviados por mensagem, escolhidos pelo assunto
const MAPA_MAX = 16000; // teto de caracteres do bloco, para o prompt não crescer sem controle
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
  tipo: { type: "string", enum: ["nucleo", "marca_passos", "teia"] },
  acao: { type: "string", enum: ["alterar", "adicionar", "criar", "atualizar", "registrar", "iluminar"] },
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
  texto: texto, // Teia: o acontecimento
  relacionamento: texto,
  ponta_solta: texto,
  tipo_evento: opcoes(["Acontecimento", "Comportamento", "Relacionamento"]),
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
      description: "Uma ou duas frases, não mostradas ao Aliado: compare o que ele acabou de contar com o que está no resumo das ferramentas (padrão e nível das pessoas citadas, itens do Marca Passos, acontecimentos da Teia) e diga se algo deveria mudar.",
    },
    sugestoes: {
      type: "array",
      description: "Mudanças propostas no Núcleo Emocional, no Marca Passos ou na Teia dos Acontecimentos, que o Aliado aplica com um clique. Lista vazia quando não houver.",
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

// Remove caracteres de controle (menos quebra de linha e tab) de todo texto vindo da IA.
function limparTexto(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  if (Array.isArray(v)) return v.map(limparTexto);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limparTexto(x)]));
  return v;
}

/* ============================================================
   MAPA DO IMPOSSÍVEL (base de estudo pessoal do administrador)
   O conteúdo fica numa linha de app_settings, nunca no código, e só entra no
   prompt quando quem conversa é o dono do app (ADMIN_EMAIL). Cada mensagem
   leva os conceitos inteiros e só os trechos de vídeo ligados ao que o Aliado
   acabou de escrever.
============================================================ */
type Corte = { dia: number; ini: string; tema: string; titulo: string; ideia?: string; resumo?: string; url: string };
type Conceito = { nome: string; sub?: string; def: string; link: string };
type Etapa = { n: number; nome: string; pergunta: string; resumo?: string };
type Mapa = { instrucoes?: string; etapas?: Etapa[]; conceitos?: Conceito[]; cortes?: Corte[] };

const PARADAS = new Set(["para", "pela", "pelo", "como", "mais", "meu", "minha", "isso", "esse", "essa", "quando", "porque", "estou", "tenho", "fazer", "muito", "sobre", "cada", "todo", "toda", "aqui", "agora", "ainda", "mesmo", "pode", "quer", "vou", "nao", "sim", "gente", "coisa", "coisas", "vida"]);
export function palavras(s: string): string[] {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter((p) => p.length > 3 && !PARADAS.has(p));
}
export function blocoMapa(mapa: Mapa, ultima: string): string {
  const conceitos = mapa.conceitos ?? [], cortes = mapa.cortes ?? [], etapas = mapa.etapas ?? [];
  if (!conceitos.length && !cortes.length) return "";
  const termos = new Set(palavras(ultima));
  const nota = (c: Corte) =>
    palavras([c.titulo, c.ideia, c.resumo, c.tema].join(" ")).reduce((n, p) => n + (termos.has(p) ? 1 : 0), 0);
  let escolhidos = cortes.map((c) => ({ c, n: nota(c) })).filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.c.dia - b.c.dia).slice(0, MAPA_CORTES).map((x) => x.c);
  if (!escolhidos.length) {
    // nada casou: manda um trecho de cada assunto, para o Coach ter de onde partir
    const vistos = new Set<string>();
    escolhidos = cortes.filter((c) => !vistos.has(c.tema) && vistos.add(c.tema)).slice(0, 8);
  }
  const linhas = [
    "",
    "=== MAPA DO IMPOSSÍVEL — semana do dinheiro (material de estudo do Aliado) ===",
    mapa.instrucoes ?? "",
    etapas.length ? "\nA engrenagem, em 7 passos:" : "",
    ...etapas.map((e) => `${e.n}. ${e.nome} — ${e.pergunta}`),
    conceitos.length ? "\nConceitos do método:" : "",
    ...conceitos.map((c) => `- ${c.nome}${c.sub ? ` (${c.sub})` : ""}: ${c.def} [${c.link}]`),
    escolhidos.length ? "\nTrechos de vídeo ligados ao que ele acabou de escrever:" : "",
    ...escolhidos.map((c) => `- Dia ${c.dia}, ${c.ini} — ${c.titulo}${c.ideia ? `: ${c.ideia}` : ""} [${c.url}]`),
  ].filter(Boolean);
  return linhas.join("\n").slice(0, MAPA_MAX);
}

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

    // Base do Mapa do Impossível: só para o dono do app, e só se a linha existir
    let systemFinal = String(system ?? "");
    let comMapa = false;
    const adminEmail = Deno.env.get("ADMIN_EMAIL");
    if (adminEmail && userData.user.email === adminEmail) {
      const { data: mapaRow } = await admin
        .from("app_settings")
        .select("value")
        .eq("key", MAPA_KEY)
        .maybeSingle();
      const ultima = [...(messages as { role: string; content: string }[])].reverse()
        .find((m) => m.role === "user")?.content ?? "";
      const bloco = mapaRow?.value ? blocoMapa(mapaRow.value as Mapa, ultima) : "";
      if (bloco) { systemFinal += bloco; comMapa = true; }
    }

    const key = Deno.env.get(useOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    if (!key) return json({ error: "Coach IA (" + (useOpenAI ? "OpenAI" : "Claude") + ") não configurado no servidor." }, 500);
    const chamar = useOpenAI ? chamarOpenAI : chamarClaude;

    let reply = "";
    let sugestoes: unknown[] | undefined;

    let resultado = await chamar(key, systemFinal, messages, structured === true);
    if (!resultado.ok && structured === true && resultado.status === 400) {
      // o provedor recusou o formato estruturado: responde em texto para o Coach não parar
      console.error("Formato estruturado recusado, voltando para texto:", resultado.error);
      resultado = await chamar(key, systemFinal, messages, false);
    } else if (resultado.ok && structured === true) {
      try {
        // o gpt-4o às vezes quebra o escape de letra acentuada: "í" (\u00ed) sai como \u0000 seguido de "ed"
        const reparado = resultado.text.replace(/\\u0000([0-9a-fA-F]{2})/g, "\\u00$1");
        const parsed = limparTexto(JSON.parse(reparado)) as { resposta?: unknown; sugestoes?: unknown };
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
    reply = String(limparTexto(reply)) || "(sem resposta)";

    await admin.from("chat_usage").upsert(
      { user_id: userId, day: today, count: currentCount + 1 },
      { onConflict: "user_id,day" },
    );

    // modo: "estruturado" quando o formato foi aceito; "texto" quando não houve ou caiu no plano B
    const resposta = sugestoes === undefined ? { reply, modo: "texto" } : { reply, sugestoes, modo: "estruturado" };
    return json(comMapa ? { ...resposta, mapa: true } : resposta);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
