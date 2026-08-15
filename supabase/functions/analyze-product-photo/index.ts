const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProductDetails = {
  product_name?: string;
  brand?: string;
  size?: string;
  category?: string;
  description?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { barcode, imageDataUrl } = await req.json();
    if (!barcode || typeof barcode !== "string") {
      return json({ error: "Missing barcode" }, 400);
    }

    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return json({ error: "Missing product photo" }, 400);
    }

    const details = await analyzeProductPhoto(barcode, imageDataUrl);
    const item = await updateInventoryItem(barcode, details);

    return json({ item });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

async function analyzeProductPhoto(barcode: string, imageDataUrl: string): Promise<ProductDetails> {
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiKey) {
    throw new Error("OPENAI_API_KEY is not set in Supabase Edge Function secrets.");
  }

  const prompt = [
    "Analyze this product/package photo for an inventory barcode scanner.",
    "Read visible label text and infer only details that are reasonably supported by the image.",
    "If a field is uncertain or not visible, return an empty string for that field.",
    "Return only valid JSON with these string fields: product_name, brand, size, category, description.",
    `Barcode: ${barcode}`,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") || "gpt-5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl, detail: "high" },
          ],
        },
      ],
      max_output_tokens: 500,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const result = await response.json();
  const text = extractOutputText(result);
  return sanitizeDetails(parseJsonDetails(text));
}

async function updateInventoryItem(barcode: string, details: ProductDetails) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseServiceKey();
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase service credentials are not available to the Edge Function.");
  }

  const now = new Date().toISOString();
  const patch: Record<string, string> = {
    ai_status: "complete",
    ai_analyzed_at: now,
    updated_at: now,
  };

  if (details.product_name) patch.product_name = details.product_name;
  if (details.brand) patch.brand = details.brand;
  if (details.size) patch.size = details.size;
  if (details.category) patch.category = details.category;
  if (details.description) patch.description = details.description;

  let response = await fetch(`${supabaseUrl}/rest/v1/inventory_items?barcode=eq.${encodeURIComponent(barcode)}`, {
    method: "PATCH",
    headers: supabaseHeaders(serviceKey, "return=representation"),
    body: JSON.stringify(patch),
  });

  let rows = response.ok ? await response.json() : [];
  if (response.ok && rows[0]) return rows[0];

  response = await fetch(`${supabaseUrl}/rest/v1/inventory_items`, {
    method: "POST",
    headers: supabaseHeaders(serviceKey, "return=representation"),
    body: JSON.stringify({ barcode, count: 0, ...patch }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase update failed: ${response.status} ${text}`);
  }

  rows = await response.json();
  return rows[0];
}

function getSupabaseServiceKey() {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeys) return "";

  const parsed = JSON.parse(secretKeys);
  return parsed.default || "";
}

function supabaseHeaders(serviceKey: string, prefer: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: prefer,
  };
}

function extractOutputText(result: any) {
  if (typeof result.output_text === "string") return result.output_text;

  const parts: string[] = [];
  for (const item of result.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonDetails(text: string): ProductDetails {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

function sanitizeDetails(details: ProductDetails): ProductDetails {
  return {
    product_name: clean(details.product_name, 120),
    brand: clean(details.brand, 80),
    size: clean(details.size, 60),
    category: clean(details.category, 80),
    description: clean(details.description, 260),
  };
}

function clean(value: unknown, maxLength: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
