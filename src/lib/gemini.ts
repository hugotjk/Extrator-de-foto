/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";

// Safe access to process.env to prevent crashes on Vercel/Production
const getApiKey = () => {
  try {
    // Priority: system env -> fallback to vite prefix for standalone deployments
    return process.env.GEMINI_API_KEY || (import.meta as any).env.VITE_GEMINI_API_KEY || "";
  } catch (e) {
    try {
      return (import.meta as any).env.VITE_GEMINI_API_KEY || "";
    } catch (inner) {
      return "";
    }
  }
};

const apiKey = getApiKey();
const ai = new GoogleGenAI({ apiKey });

export interface ProductExtraction {
  reference: string;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0-1000
}

async function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function extractProductsFromPage(base64Image: string, retryCount = 0): Promise<ProductExtraction[]> {
  if (!apiKey) {
    throw new Error("API Key do Gemini não configurada. Verifique as variáveis de ambiente.");
  }

  const model = "gemini-3.1-flash-lite-preview";
  const MAX_RETRIES = 5;
  
  const prompt = `Analise esta página de catálogo com inteligência visual apurada.
Sua tarefa é extrair apenas IMAGENS DE PRODUTOS individuais que possuam um código de referência associado.

INSTRUÇÕES DE IDENTIFICAÇÃO:
1. FOCO EM PRODUTOS: Identifique apenas objetos/produtos do catálogo (ex: calçados, roupas, acessórios). IGNORE imagens institucionais, logos de marcas, fotos de modelos sem referência direta ou elementos decorativos.
2. LOCALIZAÇÃO DA REFERÊNCIA: O código de referência (que pode conter letras, números ou hífens) está sempre LOCALIZADO PRÓXIMO ao produto. Pode estar acima, abaixo ou nas laterais.
3. VÍNCULO ÚNICO: Garanta que cada referência seja associada à foto correspondente.

REGRAS DE EXTRAÇÃO:
- "reference": O código de identificação exato (remova textos extras como cores ou preços, pegue apenas o código base).
- "box_2d": A caixa delimitadora [ymin, xmin, ymax, xmax] da FOTO do produto. Tente não incluir o texto dentro do recorte.
- Coordenadas normalizadas de 0 a 1000.

REGRAS CRÍTICAS:
- Se não houver produtos com referências claras na página, retorne [].
- Retorne APENAS o JSON no formato solicitado.`;

  try {
    const result = await ai.models.generateContent({
      model,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image.split(",")[1] || base64Image,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              reference: { type: Type.STRING },
              box_2d: {
                type: Type.ARRAY,
                items: { type: Type.NUMBER },
                minItems: 4,
                maxItems: 4,
              },
            },
            required: ["reference", "box_2d"],
          },
        },
      },
    });

    const text = result.text;
    if (!text) return [];
    return JSON.parse(text);
  } catch (error: any) {
    // Handle quota exceeded error (429)
    if (error?.message?.includes('429') || error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('quota')) {
      if (retryCount < MAX_RETRIES) {
        // Base delay is 5 seconds now, with exponential growth
        const delay = Math.pow(2, retryCount) * 5000;
        console.warn(`Quota excedida. Tentando novamente em ${delay/1000}s... (Tentativa ${retryCount + 1}/${MAX_RETRIES})`);
        await wait(delay);
        return extractProductsFromPage(base64Image, retryCount + 1);
      }
      throw new Error("Limite de cota da IA excedido. O Google limita o uso gratuito. Por favor, aguarde 1 minuto e tente novamente.");
    }
    
    console.error("Error extracting products:", error);
    return [];
  }
}
