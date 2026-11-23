import { GoogleGenAI } from '@google/genai';
import { logger } from '../../utils/logger';
import * as FileSystem from 'expo-file-system/legacy';

const apiKeys = [
  process.env.EXPO_PUBLIC_GEMINI_API_KEY,
  process.env.EXPO_PUBLIC_GEMINI_API_KEY_2,
  process.env.EXPO_PUBLIC_GEMINI_API_KEY_3,
].filter(Boolean) as string[];

let currentKeyIndex = 0;

/**
 * Creates a new GoogleGenAI instance using the current active API key.
 */
const getActiveClient = (): GoogleGenAI => {
  return new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] || '' });
};

/**
 * Wrapper for Gemini API calls. If an API key is exhausted (ResourceExhausted),
 * it automatically rotates to the next available API key and retries.
 */
const executeWithFallback = async <T>(
  operation: (ai: GoogleGenAI) => Promise<T>,
  retries = apiKeys.length
): Promise<T> => {
  if (apiKeys.length === 0) {
    throw new Error('Gemini API Key is missing. Cannot perform operation.');
  }

  let attempts = 0;
  let lastError: any = null;

  while (attempts < retries) {
    try {
      const ai = getActiveClient();
      return await operation(ai); // If successful, return the result
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      
      // Typical error statuses for limits: 429 (Rate Limit), 403 (Quota/Forbidden)
      if (status === 429 || status === 403 || error?.message?.includes('429') || error?.message?.includes('403')) {
        console.warn(`[Gemini API] Key ${currentKeyIndex + 1}/${apiKeys.length} failed or hit limit. Rotating key...`);
        // Rotate to the next key
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        attempts++;
      } else {
        // If it's a structural error (e.g., bad request 400), don't retry, just throw
        console.error('[Gemini API] Non-retryable error encountered:', error);
        throw error;
      }
    }
  }

  throw new Error(`[Gemini API] All ${apiKeys.length} API keys have been exhausted or failed. Last Error: ${lastError?.message}`);
};

/** Categories a custom card can belong to (mirrors the Child tab bar ids). */
export type ImageTagCategory =
  | 'pronoun'
  | 'verb'
  | 'noun'
  | 'emotion'
  | 'social'
  | 'body'
  | 'number'
  | 'people'
  | 'food'
  | 'place'
  | 'time'
  | 'animal'
  | 'clothing'
  | 'color';

export type ImageTagResult = { id: string; en: string; zh: string; ms: string; category: ImageTagCategory };

const VALID_TAG_CATEGORIES: readonly string[] = [
  'pronoun',
  'verb',
  'noun',
  'emotion',
  'social',
  'body',
  'number',
  'people',
  'food',
  'place',
  'time',
  'animal',
  'clothing',
  'color',
];

/**
 * Returned when the model answer cannot be trusted (parse failure / missing
 * fields). Callers MUST treat this exact tuple as "no confidence" and fall
 * back to the manual form instead of saving it as a real card name.
 */
const NO_CONFIDENCE_TAG: ImageTagResult = { id: 'Benda', en: 'Thing', zh: '东西', ms: 'Barang', category: 'noun' };

export const isNoConfidenceTag = (t: ImageTagResult): boolean =>
  t.id === 'Benda' && t.en === 'Thing' && t.zh === '东西' && t.ms === 'Barang';

export const tagImageWithBilingualNames = async (imageUri: string): Promise<ImageTagResult> => {
  const base64Data = await FileSystem.readAsStringAsync(imageUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return executeWithFallback(async (ai) => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: 'image/jpeg',
              },
            },
            {
              text: 'Identify the main object in this image with a single, simple word suitable for a child. Give the word in Indonesian, English, Mandarin, and Bahasa Melayu (Malay — use proper Malaysian vocabulary, not Indonesian), and classify it into exactly one AAC category. Return ONLY a JSON object in this exact format, with no markdown formatting or backticks: {"id": "word in indonesian", "en": "word in english", "zh": "word in mandarin", "ms": "word in malay", "category": "pronoun|verb|noun|emotion|social|body|number|people|food|place|time|animal|clothing|color"}',
            },
          ],
        },
      ],
    });

    try {
      const result = JSON.parse(response.text || '{}');
      if (result.id && result.zh) {
        return {
          id: result.id,
          en: result.en || result.id,
          zh: result.zh,
          ms: result.ms || result.id,
          category: VALID_TAG_CATEGORIES.includes(result.category)
            ? (result.category as ImageTagCategory)
            : 'noun',
        };
      }
      return NO_CONFIDENCE_TAG;
    } catch (error) {
      console.error('Error parsing Gemini Vision response', error);
      logger.logError(error, { 
        action: 'ai_image_tagging',
      });
      return NO_CONFIDENCE_TAG;
    }
  });
};
