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
  
  const prompt = `Analise esta página de catálogo de produtos com precisão cirúrgica.
Sua tarefa é extrair cada produto individual e associá-lo ao seu código de referência correto.

INSTRUÇÕES DE LOCALIZAÇÃO:
- O código de referência pode estar ACIMA, ABAIXO, à ESQUERDA ou à DIREITA da foto do produto.
- Geralmente é um código alfanumérico (ex: 1900022102-3, REF-123, 456.789).
- Se houver múltiplos códigos, escolha o que parece ser o identificador principal do produto.

REGRAS DE EXTRAÇÃO:
1. "reference": O texto exato do código de referência. Remova espaços extras.
2. "box_2d": A caixa delimitadora [ymin, xmin, ymax, xmax] da FOTO do produto (apenas a imagem do produto, sem o texto da referência).
3. Use coordenadas normalizadas de 0 a 1000.

REGRAS CRÍTICAS:
- Se a página for uma capa, índice ou não contiver produtos claros com referências, retorne uma lista vazia: [].
- Garanta que a caixa (box_2d) englobe todo o produto, mas evite incluir o texto da referência dentro da imagem recortada.
- Retorne APENAS o JSON.`;

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
        const delay = Math.pow(2, retryCount) * 2000;
        console.warn(`Quota exceeded. Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await wait(delay);
        return extractProductsFromPage(base64Image, retryCount + 1);
      }
      throw new Error("Limite de cota da IA excedido. O Google limita o uso gratuito. Por favor, aguarde 1 minuto e tente novamente.");
    }
    
    console.error("Error extracting products:", error);
    return [];
  }
}
