import { GoogleGenAI, Type } from '@google/genai';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export const WASTE_SEGREGATION_CATEGORIES = [
  'Biodegradable / Wet Waste',
  'Plastic Waste',
  'Paper and Cardboard',
  'Glass Waste',
  'Metal Waste',
  'E-Waste',
  'Hazardous Waste',
  'Mixed Waste',
] as const;

export interface DetectedWasteObject {
  label: string;
  category: string;
  confidence: number | null;
  box2d: [number, number, number, number];
}

export interface WasteCategoryShare {
  category: string;
  percentage: number;
}

export interface CategoryDisposalTip {
  category: string;
  recommendation: string;
}

export interface WasteClassificationResult {
  canClassify: boolean;
  unableToClassify: boolean;
  predictedCategory: string;
  confidence: number | null;
  disposalMethod: string;
  segregationRecommendation: string;
  suggestedComplaintCategory: string;
  detectedObjects: DetectedWasteObject[];
  categoryDistribution: WasteCategoryShare[];
  distributionMethod: string;
  categoryRecommendations: CategoryDisposalTip[];
  reason?: string;
}

const DEFAULT_DISPOSAL_TIPS: Record<string, string> = {
  'Biodegradable / Wet Waste':
    'Deposit in the Green municipal bin or home composter for bio-methanation and organic composting.',
  'Plastic Waste':
    'Rinse/dry plastic bottles, wrappers, and containers; deposit in the Blue dry-waste bin for Material Recovery Facility (MRF) recycling.',
  'Paper and Cardboard':
    'Keep flattened, dry, and unsoiled; place in the Blue dry-waste stream for paper mill recycling.',
  'Glass Waste':
    'Wrap intact or broken glass safely in newspaper/cardboard to prevent crew injury and hand over separately with dry recyclables.',
  'Metal Waste':
    'Separate aluminum cans, tins, and scrap hardware into the dry recyclable bin for scrap recovery.',
  'E-Waste':
    'Never place in household wet or dry bins. Drop batteries, chargers, bulbs, or electronics at an authorized municipal e-waste collection point.',
  'Hazardous Waste':
    'Isolate paint, chemicals, sanitary, or medical waste in sealed marked bags and hand over to municipal hazardous-waste handlers.',
  'Mixed Waste':
    'Manually separate wet organic scraps from dry plastics/paper before collection; alert municipal sanitation crew if dumped in bulk.',
};

function computeBoxAreaDistribution(
  objects: DetectedWasteObject[],
  fallbackCategory: string
): { shares: WasteCategoryShare[]; method: string } {
  if (objects.length === 0) {
    return {
      shares: [{ category: fallbackCategory, percentage: 100 }],
      method: 'Whole-frame primary waste classification (no discrete bounding boxes detected)',
    };
  }

  const areaByCategory: Record<string, number> = {};
  let totalArea = 0;

  for (const obj of objects) {
    const [ymin, xmin, ymax, xmax] = obj.box2d;
    const area = Math.max(1, (ymax - ymin) * (xmax - xmin));
    areaByCategory[obj.category] = (areaByCategory[obj.category] || 0) + area;
    totalArea += area;
  }

  if (totalArea <= 0) {
    return {
      shares: [{ category: fallbackCategory, percentage: 100 }],
      method: 'Object count share fallback',
    };
  }

  const entries = Object.entries(areaByCategory)
    .map(([category, area]) => ({
      category,
      exact: (area / totalArea) * 100,
    }))
    .sort((a, b) => b.exact - a.exact);

  const rounded = entries.map((item) => ({
    category: item.category,
    percentage: Math.floor(item.exact),
    remainder: item.exact - Math.floor(item.exact),
  }));

  let remainderPoints = 100 - rounded.reduce((sum, item) => sum + item.percentage, 0);
  const byRemainder = [...rounded].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRemainder.length && remainderPoints > 0; i++) {
    byRemainder[i].percentage += 1;
    remainderPoints -= 1;
  }

  return {
    shares: rounded
      .filter((r) => r.percentage > 0)
      .map(({ category, percentage }) => ({ category, percentage })),
    method: 'Bounding-Box Pixel Area Share (% of detected waste object bounding-box areas)',
  };
}

export async function classifyWasteImage(
  base64Image: string,
  mimeType: string
): Promise<WasteClassificationResult> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Configure it in Settings > Secrets to enable AI waste analysis.');
  }

  const cleanBase64 = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: cleanBase64,
          },
        },
        {
          text:
            'Inspect this image carefully for municipal waste / garbage object detection and segregation in Belagavi, India.\n' +
            '1. First determine if the image actually shows identifiable waste, litter, bins, or sanitation debris (`canClassify: true` or `false`). If the image is blank, pitch dark, severely blurred, or non-waste with no garbage visible, set `canClassify: false` and explain why in `reason`.\n' +
            '2. Identify the primary waste category strictly from this exact list: ' +
            '"Biodegradable / Wet Waste", "Plastic Waste", "Paper and Cardboard", "Glass Waste", "Metal Waste", "E-Waste", "Hazardous Waste", "Mixed Waste".\n' +
            '3. Detect every clearly visible individual waste object (`detectedObjects`), providing for each: `label` (concise item name like "PET plastic bottle", "food scraps", "cardboard carton", "broken glass bottle", "soda can", "battery/charger"), `category` (from the 8 categories above), `confidence` (integer 1-100 ONLY if you have genuine visual certainty, otherwise omit or null), and `box2d` as [ymin, xmin, ymax, xmax] normalized integers in 0..1000 coordinates tightly enclosing that object.\n' +
            '4. Provide `categoryRecommendations` with practical municipal disposal guidance for each detected category, plus `disposalMethod`, `segregationRecommendation`, and `suggestedComplaintCategory` from: ' +
            '"Uncollected garbage", "Overflowing dustbin", "Roadside garbage", "Public place sanitation", "Drainage waste", "Waste burning", "Irregular garbage collection", "Other sanitation problems".',
        },
      ],
    },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          canClassify: { type: Type.BOOLEAN },
          predictedCategory: { type: Type.STRING },
          confidence: { type: Type.NUMBER, nullable: true },
          disposalMethod: { type: Type.STRING },
          segregationRecommendation: { type: Type.STRING },
          suggestedComplaintCategory: { type: Type.STRING },
          reason: { type: Type.STRING },
          detectedObjects: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                category: { type: Type.STRING },
                confidence: { type: Type.NUMBER, nullable: true },
                box2d: {
                  type: Type.ARRAY,
                  items: { type: Type.INTEGER },
                },
              },
              required: ['label', 'category', 'box2d'],
            },
          },
          categoryRecommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                recommendation: { type: Type.STRING },
              },
              required: ['category', 'recommendation'],
            },
          },
        },
        required: [
          'canClassify',
          'predictedCategory',
          'disposalMethod',
          'segregationRecommendation',
          'suggestedComplaintCategory',
          'detectedObjects',
          'categoryRecommendations',
        ],
      },
    },
  });

  const text = (response.text ?? '{}').trim();
  const parsed = JSON.parse(text) as {
    canClassify?: boolean;
    predictedCategory?: string;
    confidence?: number | null;
    disposalMethod?: string;
    segregationRecommendation?: string;
    suggestedComplaintCategory?: string;
    reason?: string;
    detectedObjects?: Array<{
      label?: string;
      category?: string;
      confidence?: number | null;
      box2d?: number[];
    }>;
    categoryRecommendations?: Array<{ category?: string; recommendation?: string }>;
  };

  const rawConfidence: number | null =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) && parsed.confidence > 0
      ? Math.min(100, Math.max(1, Math.round(parsed.confidence)))
      : null;

  const unableToClassify = parsed.canClassify === false || (rawConfidence !== null && rawConfidence < 45);

  if (unableToClassify) {
    return {
      canClassify: false,
      unableToClassify: true,
      predictedCategory: 'Unable to classify – Manual verification required.',
      confidence: rawConfidence,
      disposalMethod: 'Unable to classify – Manual verification required. Please select the waste category manually or recapture a clearer photograph.',
      segregationRecommendation: 'Hold waste until visually verified by citizen or ward sanitation supervisor.',
      suggestedComplaintCategory: 'Uncollected garbage',
      detectedObjects: [],
      categoryDistribution: [],
      distributionMethod: 'Not computed (no verifiable waste objects detected)',
      categoryRecommendations: [],
      reason: parsed.reason || 'No identifiable garbage items detected or image clarity is insufficient.',
    };
  }

  const validCategory = WASTE_SEGREGATION_CATEGORIES.find(
    (c) => c.toLowerCase() === (parsed.predictedCategory || '').toLowerCase()
  ) || 'Mixed Waste';

  const detectedObjects: DetectedWasteObject[] = (parsed.detectedObjects || [])
    .filter((obj) => obj && obj.label && Array.isArray(obj.box2d) && obj.box2d.length === 4)
    .map((obj) => {
      const ymin = Math.max(0, Math.min(1000, Math.round(Number(obj.box2d![0]) || 0)));
      const xmin = Math.max(0, Math.min(1000, Math.round(Number(obj.box2d![1]) || 0)));
      const ymax = Math.max(ymin + 10, Math.min(1000, Math.round(Number(obj.box2d![2]) || 1000)));
      const xmax = Math.max(xmin + 10, Math.min(1000, Math.round(Number(obj.box2d![3]) || 1000)));
      const matchedCat =
        WASTE_SEGREGATION_CATEGORIES.find(
          (c) => c.toLowerCase() === (obj.category || '').toLowerCase()
        ) || validCategory;
      const objConfidence: number | null =
        typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) && obj.confidence > 0
          ? Math.min(100, Math.max(1, Math.round(obj.confidence)))
          : null;
      return {
        label: String(obj.label).trim(),
        category: matchedCat,
        confidence: objConfidence,
        box2d: [ymin, xmin, ymax, xmax] as [number, number, number, number],
      };
    });

  const { shares: categoryDistribution, method: distributionMethod } = computeBoxAreaDistribution(
    detectedObjects,
    validCategory
  );

  const categoryRecommendations: CategoryDisposalTip[] = (parsed.categoryRecommendations || [])
    .filter((r) => r && r.category && r.recommendation)
    .map((r) => ({
      category:
        WASTE_SEGREGATION_CATEGORIES.find(
          (c) => c.toLowerCase() === (r.category || '').toLowerCase()
        ) || String(r.category),
      recommendation: String(r.recommendation),
    }));

  // Ensure every category found in detectedObjects has disposal instructions
  const coveredCats = new Set(categoryRecommendations.map((r) => r.category));
  for (const share of categoryDistribution) {
    if (!coveredCats.has(share.category)) {
      categoryRecommendations.push({
        category: share.category,
        recommendation: DEFAULT_DISPOSAL_TIPS[share.category] || DEFAULT_DISPOSAL_TIPS['Mixed Waste'],
      });
      coveredCats.add(share.category);
    }
  }

  if (categoryRecommendations.length === 0) {
    categoryRecommendations.push({
      category: validCategory,
      recommendation: DEFAULT_DISPOSAL_TIPS[validCategory] || DEFAULT_DISPOSAL_TIPS['Mixed Waste'],
    });
  }

  return {
    canClassify: true,
    unableToClassify: false,
    predictedCategory: validCategory,
    confidence: rawConfidence,
    disposalMethod:
      parsed.disposalMethod || DEFAULT_DISPOSAL_TIPS[validCategory] || DEFAULT_DISPOSAL_TIPS['Mixed Waste'],
    segregationRecommendation:
      parsed.segregationRecommendation ||
      'Separate wet biodegradable waste (green bin) from dry recyclables (blue bin) and hazardous/e-waste.',
    suggestedComplaintCategory: parsed.suggestedComplaintCategory || 'Uncollected garbage',
    detectedObjects,
    categoryDistribution,
    distributionMethod,
    categoryRecommendations,
    reason: parsed.reason,
  };
}

export interface VoiceAssistantReply {
  replyText: string;
  intent:
    | 'report_complaint'
    | 'track_complaint'
    | 'find_vehicles'
    | 'find_collection_point'
    | 'find_hotspots'
    | 'segregation_help'
    | 'navigate'
    | 'general';
  requiresConfirmation: boolean;
  confirmationPrompt?: string;
  suggestedRoute?: string;
  extractedWard?: number;
  extractedCategory?: string;
  extractedComplaintCode?: string;
}

export async function processVoiceAssistant(
  transcript: string,
  language: string,
  liveContextSummary: string
): Promise<VoiceAssistantReply> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const langNames: Record<string, string> = {
    en: 'English',
    kn: 'Kannada (ಕನ್ನಡ)',
    hi: 'Hindi (हिन्दी)',
    mr: 'Marathi (मराठी)',
    ta: 'Tamil (தமிழ்)',
    te: 'Telugu (తెలుగు)',
  };

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `User spoken/text query: "${transcript}"\nTarget response language: ${langNames[language] || 'English'}\n\nLIVE DATABASE & SYSTEM CONTEXT:\n${liveContextSummary}`,
    config: {
      systemInstruction:
        'You are the SANITRACK Multilingual Civic Sanitation Voice Assistant for Belagavi Municipal Corporation. ' +
        'CRITICAL RULES:\n' +
        '1. Reply ONLY in the requested target language, clearly and concisely (2-4 short spoken-friendly sentences).\n' +
        '2. Base all factual answers strictly on the LIVE DATABASE & SYSTEM CONTEXT provided. NEVER invent or guess complaint statuses, vehicle locations, or collection points that are not in the context.\n' +
        '3. Distinguish clearly if any vehicle telemetry shown is DEMO SIMULATION vs actual LIVE GPS.\n' +
        '4. Classify `intent` as one of: "report_complaint", "track_complaint", "find_vehicles", "find_collection_point", "find_hotspots", "segregation_help", "navigate", "general".\n' +
        '5. If the user asks to report garbage, check the live map/vehicles, or track a complaint screen, set `requiresConfirmation: true`, provide `confirmationPrompt`, and set `suggestedRoute` to "/report", "/track", "/map", "/awareness", or "/dashboard" (otherwise empty string).',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          replyText: { type: Type.STRING },
          intent: { type: Type.STRING },
          requiresConfirmation: { type: Type.BOOLEAN },
          confirmationPrompt: { type: Type.STRING },
          suggestedRoute: { type: Type.STRING },
          extractedWard: { type: Type.INTEGER },
          extractedCategory: { type: Type.STRING },
          extractedComplaintCode: { type: Type.STRING },
        },
        required: ['replyText', 'intent', 'requiresConfirmation'],
      },
    },
  });

  const text = (response.text ?? '{}').trim();
  const parsed = JSON.parse(text) as Partial<VoiceAssistantReply>;
  const validIntents = [
    'report_complaint',
    'track_complaint',
    'find_vehicles',
    'find_collection_point',
    'find_hotspots',
    'segregation_help',
    'navigate',
    'general',
  ];

  return {
    replyText: parsed.replyText || 'How can I assist you with Belagavi sanitation services?',
    intent: (validIntents.includes(parsed.intent || '') ? parsed.intent : 'general') as VoiceAssistantReply['intent'],
    requiresConfirmation: Boolean(parsed.requiresConfirmation),
    confirmationPrompt: parsed.confirmationPrompt || undefined,
    suggestedRoute: parsed.suggestedRoute || undefined,
    extractedWard: typeof parsed.extractedWard === 'number' ? parsed.extractedWard : undefined,
    extractedCategory: parsed.extractedCategory || undefined,
    extractedComplaintCode: parsed.extractedComplaintCode || undefined,
  };
}
