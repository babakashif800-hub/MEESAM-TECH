import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MODES = new Set([
  'auto_edit',
  'auto_cut',
  'auto_captions',
  'smart_filters',
  'custom_prompt',
]);

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_MIMES = new Set(['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg']);
const ALLOWED_RATIOS = new Set(['original', '9:16', '16:9', '1:1', '4:5']);
const ALLOWED_FITS = new Set(['contain', 'cover']);
const ALLOWED_POSITIONS = new Set(['top', 'center', 'bottom']);
const ALLOWED_STYLES = new Set(['clean', 'outline', 'boxed', 'subtitle-bar', 'pop']);
const ALLOWED_SIZES = new Set(['sm', 'md', 'lg']);
// Strictly FIVE languages (with Chinese Simplified zh-Hans and Traditional zh-Hant):
const ALLOWED_TARGET_LANGUAGES = new Set(['sd', 'ur', 'hi', 'en', 'zh-Hans', 'zh-Hant']);
const ALLOWED_LANGUAGES = new Set(['auto', 'sd', 'ur', 'hi', 'en', 'zh-Hans', 'zh-Hant']);
const ALLOWED_TTS_VOICES = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr']);

const LANGUAGE_DIRECTIVES: Record<string, string> = {
  sd: 'Sindhi (سنڌي) using full, standard Sindhi Arabic Unicode script (e.g. سنڌي، وڊيو، آواز)',
  ur: 'Urdu (اردو) using standard Urdu Arabic-Persian script',
  hi: 'Hindi (हिन्दी) using standard Devanagari script',
  en: 'English',
  'zh-Hans': 'Simplified Chinese (简体中文)',
  'zh-Hant': 'Traditional Chinese (繁體中文)',
};

const SELFIE_SEGMENTER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
let cachedSegmenterBuffer: Buffer | null = null;

function isSilentWavBase64(b64: string): boolean {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 48 || buf.toString('ascii', 0, 4) !== 'RIFF') return false;
    let offset = 12;
    let bitsPerSample = 16;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ' && offset + 24 <= buf.length) {
        bitsPerSample = buf.readUInt16LE(offset + 22);
      } else if (id === 'data') {
        if (bitsPerSample !== 16) return false;
        const dataStart = offset + 8;
        const dataEnd = Math.min(buf.length, dataStart + size);
        let peak = 0;
        for (let p = dataStart; p + 1 < dataEnd; p += 16) {
          const sample = Math.abs(buf.readInt16LE(p));
          if (sample > peak) peak = sample;
        }
        return peak < 15; // < 0.00046 of full scale 16-bit PCM
      }
      offset += 8 + size + (size % 2);
    }
  } catch {
    return false;
  }
  return false;
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DEADLINE_EXCEEDED: ${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  timeoutMs = 22000
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await withTimeout(
        ai.models.generateContent(params),
        timeoutMs,
        String(params.model)
      );
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('DEADLINE_EXCEEDED');
      if (!isTransient || attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function handleAiError(res: Response, err: unknown, fallbackMessage: string) {
  const msg = err instanceof Error ? err.message : fallbackMessage;
  console.error('[MEESAM AI Error]', msg);
  if (msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
    res.status(403).json({
      error:
        'Gemini API key could not be authorized. Please check your key in Settings > Secrets.',
    });
    return;
  }
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
    res.status(429).json({
      error: 'AI quota limit reached briefly. Please wait a moment and try again.',
    });
    return;
  }
  if (msg.includes('NOT_FOUND') || msg.includes('404')) {
    res.status(404).json({
      error: `Requested AI model is unavailable: ${fallbackMessage}`,
    });
    return;
  }
  if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
    res.status(503).json({
      error: `AI model is temporarily busy (${fallbackMessage}). Please try again in a moment.`,
    });
    return;
  }
  if (msg.includes('INVALID_ARGUMENT') || msg.includes('400')) {
    res.status(400).json({
      error: `${fallbackMessage} (${msg.slice(0, 140)})`,
    });
    return;
  }
  res.status(500).json({ error: `${fallbackMessage} (${msg.slice(0, 120)})` });
}

const aiEditResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'Short 1-2 sentence explanation of the suggested CapCut-style edit.',
    },
    detectedLanguage: {
      type: Type.STRING,
      description: 'Detected language code from: sd, ur, hi, en, zh-Hans, zh-Hant.',
    },
    recommendedFilterId: {
      type: Type.STRING,
      description: 'Exact filter preset ID selected from the provided availableFilters list.',
    },
    filterIntensity: {
      type: Type.NUMBER,
      description: 'Recommended filter strength percentage between 40 and 100.',
    },
    brightness: {
      type: Type.NUMBER,
      description: 'Brightness percentage between 75 and 125 (100 is neutral).',
    },
    contrast: {
      type: Type.NUMBER,
      description: 'Contrast percentage between 80 and 130 (100 is neutral).',
    },
    saturation: {
      type: Type.NUMBER,
      description: 'Saturation percentage between 50 and 150 (100 is neutral).',
    },
    aspectRatio: {
      type: Type.STRING,
      description: 'One of: original, 9:16, 16:9, 1:1, 4:5',
    },
    frameFit: {
      type: Type.STRING,
      description: 'One of: contain, cover',
    },
    slowMoRanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          speed: { type: Type.NUMBER },
          smoothSlowMo: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
        },
      },
      description:
        'Optional 0 to 2 highlight windows for slow motion (speed 0.25 to 0.75) or speed-up (1.25 to 2.0).',
    },
    keepRanges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          reason: { type: Type.STRING },
          score: { type: Type.NUMBER },
        },
      },
      description:
        'Selected best video highlight windows to KEEP during AI Auto Cut (non-highlight filler gaps outside these ranges will be trimmed out).',
    },
    captions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          position: { type: Type.STRING },
          style: { type: Type.STRING },
          color: { type: Type.STRING },
          size: { type: Type.STRING },
          lang: { type: Type.STRING },
        },
      },
      description: 'Timed text marks or spoken captions on the video.',
    },
    filterRecommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          filterId: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
      },
      description: 'Top 3 filter IDs from availableFilters with short reasons.',
    },
  },
  required: ['summary'],
};

const autoCaptionsResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'Short 1 sentence summary of detected speech.',
    },
    detectedLanguage: {
      type: Type.STRING,
      description: 'One of: sd, ur, hi, en, zh-Hans, zh-Hant.',
    },
    captions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
          lang: { type: Type.STRING },
        },
        required: ['text', 'startTime', 'endTime'],
      },
      description: 'Timed spoken subtitle segments covering the dialogue.',
    },
  },
  required: ['summary', 'captions'],
};

const translationResponseSchema = {
  type: Type.OBJECT,
  properties: {
    translations: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Translated lines in the exact same order and count as the input texts.',
    },
  },
  required: ['translations'],
};

function splitTranscriptIntoTimedCaptions(
  transcript: string,
  duration: number,
  lang: string | undefined,
  style: string,
  color: string
) {
  const cleaned = transcript.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const sentences = cleaned
    .split(/(?<=[.!?\u06D4\u0964\u3002\uff01\uff1f])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const sentence of sentences.length > 0 ? sentences : [cleaned]) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= 8) {
      chunks.push(sentence.slice(0, 120));
    } else {
      for (let i = 0; i < words.length; i += 7) {
        chunks.push(words.slice(i, i + 7).join(' ').slice(0, 120));
      }
    }
  }

  const bounded = chunks.slice(0, 24);
  if (bounded.length === 0) return [];
  const totalWeights = bounded.reduce((sum, c) => sum + Math.max(4, c.length), 0);
  const usableStart = Math.min(0.1, duration * 0.02);
  const usableEnd = Math.max(usableStart + 0.3, duration - 0.05);
  const usableSpan = usableEnd - usableStart;

  let cursor = usableStart;
  return bounded.map((text, idx) => {
    const share = (Math.max(4, text.length) / totalWeights) * usableSpan;
    const startTime = Number(cursor.toFixed(2));
    const endTime =
      idx === bounded.length - 1
        ? Number(usableEnd.toFixed(2))
        : Number(Math.min(usableEnd, cursor + Math.max(0.4, share)).toFixed(2));
    cursor = endTime;
    return {
      text,
      startTime,
      endTime: Math.max(Number((startTime + 0.3).toFixed(2)), endTime),
      position: 'bottom',
      style,
      color,
      size: 'md',
      lang,
    };
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '14mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, aiReady: Boolean(getAiClient()) });
  });

  app.get('/api/models/selfie-segmenter.tflite', async (_req: Request, res: Response) => {
    try {
      if (!cachedSegmenterBuffer) {
        const upstream = await fetch(SELFIE_SEGMENTER_MODEL_URL);
        if (!upstream.ok) {
          res.status(502).json({ error: 'Unable to fetch AI background model.' });
          return;
        }
        const arrBuf = await upstream.arrayBuffer();
        cachedSegmenterBuffer = Buffer.from(arrBuf);
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cachedSegmenterBuffer);
    } catch {
      res.status(502).json({ error: 'Unable to load AI background model right now.' });
    }
  });

  app.post('/api/ai-edit', async (req: Request, res: Response) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const mode = typeof body.mode === 'string' ? body.mode : '';
      if (!ALLOWED_MODES.has(mode)) {
        res.status(400).json({ error: 'Invalid AI edit mode.' });
        return;
      }

      const duration = clampNum(body.duration, 0.2, 3600, 10);
      const width = clampNum(body.width, 64, 4096, 1280);
      const height = clampNum(body.height, 64, 4096, 720);
      const userPrompt =
        typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';

      const rawFilters = Array.isArray(body.availableFilters) ? body.availableFilters : [];
      const availableFilters = rawFilters
        .slice(0, 300)
        .filter(
          (f: unknown): f is { id: string; label: string; category: string } =>
            Boolean(
              f &&
                typeof f === 'object' &&
                typeof (f as { id?: unknown }).id === 'string' &&
                typeof (f as { label?: unknown }).label === 'string'
            )
        )
        .map((f: { id: string; label: string; category: string }) => ({
          id: f.id.slice(0, 40),
          label: f.label.slice(0, 40),
          category: typeof f.category === 'string' ? f.category.slice(0, 30) : 'general',
        }));

      const validFilterIds = new Set(
        availableFilters.map((f: { id: string }) => f.id)
      );

      const rawFrames = Array.isArray(body.frames) ? body.frames : [];
      const parts: Array<
        | { text: string }
        | { inlineData: { mimeType: string; data: string } }
      > = [];

      let frameCount = 0;
      for (const frame of rawFrames.slice(0, 6)) {
        if (!frame || typeof frame !== 'object') continue;
        const mimeType = (frame as { mimeType?: unknown }).mimeType;
        const data = (frame as { data?: unknown }).data;
        const ts = clampNum((frame as { timestampSec?: unknown }).timestampSec, 0, duration, 0);
        if (
          typeof mimeType === 'string' &&
          ALLOWED_IMAGE_MIMES.has(mimeType) &&
          typeof data === 'string' &&
          data.length > 0 &&
          data.length <= 500_000
        ) {
          parts.push({ text: `Video frame at ${ts.toFixed(1)}s:` });
          parts.push({ inlineData: { mimeType, data } });
          frameCount += 1;
        }
      }

      let audioInlinePart: { inlineData: { mimeType: string; data: string } } | null = null;
      if (body.audio && typeof body.audio === 'object') {
        const audioMime = (body.audio as { mimeType?: unknown }).mimeType;
        const audioData = (body.audio as { data?: unknown }).data;
        if (
          typeof audioMime === 'string' &&
          ALLOWED_AUDIO_MIMES.has(audioMime) &&
          typeof audioData === 'string' &&
          audioData.length > 0 &&
          audioData.length <= 5_500_000
        ) {
          audioInlinePart = { inlineData: { mimeType: audioMime, data: audioData } };
          parts.push({ text: 'Video audio track (listen for spoken words/captions):' });
          parts.push(audioInlinePart);
        }
      }

      if (mode === 'auto_captions') {
        if (!audioInlinePart) {
          res.status(422).json({
            error:
              'No spoken audio track was extracted from this video. Please upload a video with clear audio.',
          });
          return;
        }
        if (
          audioInlinePart.inlineData.mimeType === 'audio/wav' &&
          isSilentWavBase64(audioInlinePart.inlineData.data)
        ) {
          res.status(422).json({
            error:
              'No spoken dialogue was detected in this video (audio track is silent).',
          });
          return;
        }
      }

      if (frameCount === 0 && parts.length === 0) {
        res.status(400).json({ error: 'No video frames or audio provided for AI analysis.' });
        return;
      }

      const reqLang =
        typeof body.language === 'string' && ALLOWED_LANGUAGES.has(body.language)
          ? body.language
          : 'auto';
      const reqCaptionStyle =
        typeof body.captionStyle === 'string' && ALLOWED_STYLES.has(body.captionStyle)
          ? body.captionStyle
          : 'subtitle-bar';
      const reqCaptionColor =
        typeof body.captionColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.captionColor.trim())
          ? body.captionColor.trim()
          : '#ffffff';

      let verbatimTranscript = '';
      if (mode === 'auto_captions') {
        if (!audioInlinePart) {
          res.status(422).json({
            error:
              'No spoken audio track was extracted from this video. Please upload a video with clear audio.',
          });
          return;
        }

        try {
          const transcribeResp = await generateWithRetry(
            ai,
            {
              model: 'gemini-3.5-transcribe',
              contents: {
                parts: [
                  audioInlinePart,
                  {
                    text: 'Transcribe all spoken dialogue in this audio accurately in its spoken language (Sindhi, Urdu, Hindi, English, or Chinese). Return plain spoken text only with native script punctuation. If there is no human speech, return an empty string.',
                  },
                ],
              },
            },
            18000
          );
          verbatimTranscript = (transcribeResp.text ?? '').trim().slice(0, 3500);
        } catch (err) {
          console.warn('[MEESAM STT warning]', err instanceof Error ? err.message : err);
        }
      }

      if (mode === 'auto_captions') {
        const langInstruction =
          reqLang !== 'auto' && LANGUAGE_DIRECTIVES[reqLang]
            ? `Every caption MUST be written in ${LANGUAGE_DIRECTIVES[reqLang]} (translate naturally into ${LANGUAGE_DIRECTIVES[reqLang]} if spoken in another language). Set detectedLanguage="${reqLang}" and each caption lang="${reqLang}".`
            : 'Detect the spoken language from [sd, ur, hi, en, zh-Hans, zh-Hant], set detectedLanguage and each caption lang accordingly, and write captions in that native script.';

        const captionPrompt = [
          `You are MEESAM TECH Auto Captions.`,
          `Audio/video duration: ${duration.toFixed(2)} seconds.`,
          verbatimTranscript
            ? `Exact spoken transcript from STT: "${verbatimTranscript}".`
            : `Listen directly to the audio track and transcribe every spoken phrase.`,
          `Task: Split the spoken dialogue into 1 to 24 crisp, synchronized subtitle segments with accurate startTime and endTime inside [0, ${duration.toFixed(
            2
          )}].`,
          langInstruction,
          `If there is genuinely NO spoken human dialogue in the audio, return captions: [].`,
        ].join('\n');

        let parsedCaps: Record<string, unknown> = {};
        try {
          const capResp = await generateWithRetry(
            ai,
            {
              model: 'gemini-3.1-flash-lite',
              contents: {
                parts: [
                  ...(audioInlinePart ? [audioInlinePart] : []),
                  ...parts.filter((p) => 'inlineData' in p && p !== audioInlinePart).slice(0, 2),
                  { text: captionPrompt },
                ],
              },
              config: {
                responseMimeType: 'application/json',
                responseSchema: autoCaptionsResponseSchema,
              },
            },
            20000
          );
          parsedCaps = JSON.parse((capResp.text ?? '{}').trim()) as Record<string, unknown>;
        } catch (err) {
          console.warn('[MEESAM Caption align warning]', err instanceof Error ? err.message : err);
        }

        const safeDetectedLang =
          typeof parsedCaps.detectedLanguage === 'string' &&
          ALLOWED_TARGET_LANGUAGES.has(parsedCaps.detectedLanguage)
            ? parsedCaps.detectedLanguage
            : reqLang !== 'auto'
            ? reqLang
            : 'en';

        const rawCaptions = Array.isArray(parsedCaps.captions) ? parsedCaps.captions : [];
        let captions = rawCaptions
          .slice(0, 24)
          .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
          .map((c) => {
            const text = typeof c.text === 'string' ? c.text.trim().slice(0, 120) : '';
            const startTime = clampNum(c.startTime, 0, Math.max(0, duration - 0.3), 0);
            const endTime = clampNum(c.endTime, startTime + 0.3, duration, duration);
            const cLang =
              reqLang !== 'auto'
                ? reqLang
                : typeof c.lang === 'string' && ALLOWED_TARGET_LANGUAGES.has(c.lang)
                ? c.lang
                : safeDetectedLang;
            return {
              text,
              startTime: Number(startTime.toFixed(2)),
              endTime: Number(endTime.toFixed(2)),
              position: 'bottom',
              style: reqCaptionStyle,
              color: reqCaptionColor,
              size: 'md',
              lang: cLang,
            };
          })
          .filter((c) => c.text.length > 0 && c.endTime - c.startTime >= 0.2);

        if (captions.length === 0 && verbatimTranscript.length > 0) {
          captions = splitTranscriptIntoTimedCaptions(
            verbatimTranscript,
            duration,
            safeDetectedLang,
            reqCaptionStyle,
            reqCaptionColor
          );
        }

        if (captions.length === 0) {
          res.status(422).json({
            error:
              'No spoken dialogue was detected in this video. Make sure the video contains clear speech.',
          });
          return;
        }

        res.json({
          summary:
            typeof parsedCaps.summary === 'string' && parsedCaps.summary.trim()
              ? parsedCaps.summary.trim().slice(0, 200)
              : `Generated ${captions.length} captions.`,
          transcript: verbatimTranscript || captions.map((c) => c.text).join(' '),
          detectedLanguage: safeDetectedLang,
          slowMoRanges: [],
          keepRanges: [],
          captions,
          filterRecommendations: [],
        });
        return;
      }

      const filterCatalogText = availableFilters
        .map((f: { id: string; category: string }) => `${f.id} (${f.category})`)
        .join(', ');

      const langDirective =
        reqLang !== 'auto' && LANGUAGE_DIRECTIVES[reqLang]
          ? `Write every caption strictly in ${LANGUAGE_DIRECTIVES[reqLang]}. Set detectedLanguage and caption lang="${reqLang}".`
          : 'Identify which of the 5 supported languages is spoken (sd=Sindhi, ur=Urdu, hi=Hindi, en=English, zh-Hans=Simplified Chinese, zh-Hant=Traditional Chinese). Match that language script in captions (or concise English if silent).';

      const activityHints = Array.isArray(body.activityHints)
        ? (body.activityHints as Array<{ startTime?: unknown; endTime?: unknown; score?: unknown }>)
            .slice(0, 30)
            .map(
              (w) =>
                `[${clampNum(w.startTime, 0, duration, 0).toFixed(1)}s-${clampNum(
                  w.endTime,
                  0,
                  duration,
                  duration
                ).toFixed(1)}s score=${clampNum(w.score, 0, 1, 0.5).toFixed(2)}]`
            )
            .join(', ')
        : '';

      const taskDirective =
        mode === 'auto_cut'
          ? `Act as an AI highlight editor. Detect the best, highest-energy, most visually engaging or dialogue-rich moments and output 1 to 4 non-overlapping keepRanges inside 0..${duration.toFixed(
              2
            )}s (total kept length around 35%-75% of source duration). Exclude static dead air or boring pauses. ${
              activityHints ? `Local activity/audio signal scores: ${activityHints}` : ''
            }`
          : mode === 'smart_filters'
          ? 'Focus on analyzing lighting, colors, and mood to pick the top 3 matching filterIds in filterRecommendations plus recommendedFilterId and balanced brightness/contrast/saturation.'
          : mode === 'custom_prompt'
          ? `Follow the creator's exact request: "${userPrompt || 'Make this video look cinematic with smooth slow motion'}". Populate all relevant fields (filter, slowMoRanges, keepRanges, captions, aspectRatio).`
          : 'Act as a CapCut AI video director: pick the best filter from availableFilters, subtle color tuning, 1 dramatic slowMoRange (speed 0.25 or 0.5 with smoothSlowMo: true) around the key visual moment (within 0..duration), 1-3 short text hooks/captions, and best aspectRatio.';

      const instructionText = [
        `You are MEESAM TECH AI Studio, an expert multilingual CapCut-style video editor supporting strictly FIVE languages: Sindhi (sd), Urdu (ur), Hindi (hi), English (en), and Chinese Simplified/Traditional (zh-Hans, zh-Hant).`,
        `Source video metadata: duration=${duration.toFixed(2)}s, dimensions=${width}x${height}.`,
        `Task mode: ${mode}. ${taskDirective}`,
        `Available filter IDs (MUST choose only from these exact IDs): ${filterCatalogText}.`,
        `Rules:`,
        `- Every slowMoRange must satisfy 0 <= startTime < endTime <= ${duration.toFixed(2)}, with duration >= 0.4s and speed in [0.1, 0.2, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0].`,
        `- Every keepRange must satisfy 0 <= startTime < endTime <= ${duration.toFixed(2)} with duration >= 0.4s and score in 0..1.`,
        `- Every caption must satisfy 0 <= startTime < endTime <= ${duration.toFixed(2)}, concise text <= 70 chars, style in [clean, outline, boxed, subtitle-bar, pop], position in [top, center, bottom], size in [sm, md, lg], color as hex (#ffffff, #facc15, #60a5fa, etc.), lang in [sd, ur, hi, en, zh-Hans, zh-Hant].`,
        `- Keep summary concise and helpful.`,
      ].join('\n');

      parts.push({ text: instructionText });

      const response = await generateWithRetry(ai, {
        model: 'gemini-3.1-flash-lite',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: aiEditResponseSchema,
        },
      });

      const rawText = (response.text ?? '{}').trim();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        res.status(502).json({ error: 'AI returned an unreadable response. Please try again.' });
        return;
      }

      const safeDetectedLang =
        typeof parsed.detectedLanguage === 'string' &&
        ALLOWED_TARGET_LANGUAGES.has(parsed.detectedLanguage)
          ? parsed.detectedLanguage
          : reqLang !== 'auto'
          ? reqLang
          : undefined;

      const safeFilterId =
        typeof parsed.recommendedFilterId === 'string' &&
        validFilterIds.has(parsed.recommendedFilterId)
          ? parsed.recommendedFilterId
          : undefined;

      const safeRatio =
        typeof parsed.aspectRatio === 'string' && ALLOWED_RATIOS.has(parsed.aspectRatio)
          ? parsed.aspectRatio
          : undefined;

      const safeFit =
        typeof parsed.frameFit === 'string' && ALLOWED_FITS.has(parsed.frameFit)
          ? parsed.frameFit
          : undefined;

      const rawSlowMo = Array.isArray(parsed.slowMoRanges) ? parsed.slowMoRanges : [];
      const slowMoRanges = rawSlowMo
        .slice(0, 3)
        .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
        .map((r) => {
          const startTime = clampNum(r.startTime, 0, Math.max(0, duration - 0.3), 0);
          const endTime = clampNum(r.endTime, startTime + 0.3, duration, duration);
          const speed = clampNum(r.speed, 0.1, 4.0, 0.5);
          return {
            startTime: Number(startTime.toFixed(2)),
            endTime: Number(endTime.toFixed(2)),
            speed: Number(speed.toFixed(2)),
            smoothSlowMo: Boolean(r.smoothSlowMo ?? speed < 1),
            reason: typeof r.reason === 'string' ? r.reason.slice(0, 80) : undefined,
          };
        })
        .filter((r) => r.endTime - r.startTime >= 0.3);

      const rawCaptions = Array.isArray(parsed.captions) ? parsed.captions : [];
      const captions = rawCaptions
        .slice(0, 24)
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map((c) => {
          const text = typeof c.text === 'string' ? c.text.trim().slice(0, 120) : '';
          const startTime = clampNum(c.startTime, 0, Math.max(0, duration - 0.3), 0);
          const endTime = clampNum(c.endTime, startTime + 0.3, duration, duration);
          const rawColor = typeof c.color === 'string' ? c.color.trim() : reqCaptionColor;
          const color =
            mode === 'auto_captions'
              ? reqCaptionColor
              : /^#[0-9a-fA-F]{6}$/.test(rawColor)
              ? rawColor
              : reqCaptionColor;
          const cLang =
            typeof c.lang === 'string' && ALLOWED_TARGET_LANGUAGES.has(c.lang)
              ? c.lang
              : safeDetectedLang;
          return {
            text,
            startTime: Number(startTime.toFixed(2)),
            endTime: Number(endTime.toFixed(2)),
            position:
              typeof c.position === 'string' && ALLOWED_POSITIONS.has(c.position)
                ? c.position
                : 'bottom',
            style:
              typeof c.style === 'string' && ALLOWED_STYLES.has(c.style)
                ? c.style
                : reqCaptionStyle,
            color,
            size: typeof c.size === 'string' && ALLOWED_SIZES.has(c.size) ? c.size : 'md',
            lang: cLang,
          };
        })
        .filter((c) => c.text.length > 0 && c.endTime - c.startTime >= 0.25);

      const rawRecs = Array.isArray(parsed.filterRecommendations)
        ? parsed.filterRecommendations
        : [];
      const filterRecommendations = rawRecs
        .slice(0, 4)
        .filter(
          (rec): rec is Record<string, unknown> =>
            Boolean(
              rec &&
                typeof rec === 'object' &&
                typeof (rec as { filterId?: unknown }).filterId === 'string' &&
                validFilterIds.has((rec as { filterId: string }).filterId)
            )
        )
        .map((rec) => ({
          filterId: String(rec.filterId),
          reason: typeof rec.reason === 'string' ? rec.reason.slice(0, 80) : '',
        }));

      const rawKeepRanges = Array.isArray(parsed.keepRanges) ? parsed.keepRanges : [];
      const keepRanges = rawKeepRanges
        .slice(0, 8)
        .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
        .map((r) => {
          const startTime = clampNum(r.startTime, 0, Math.max(0, duration - 0.35), 0);
          const endTime = clampNum(r.endTime, startTime + 0.35, duration, duration);
          return {
            startTime: Number(startTime.toFixed(2)),
            endTime: Number(endTime.toFixed(2)),
            reason: typeof r.reason === 'string' ? r.reason.slice(0, 80) : undefined,
            score: r.score !== undefined ? Number(clampNum(r.score, 0, 1, 0.8).toFixed(2)) : undefined,
          };
        })
        .filter((r) => r.endTime - r.startTime >= 0.35)
        .sort((a, b) => a.startTime - b.startTime);

      res.json({
        summary:
          typeof parsed.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim().slice(0, 240)
            : 'AI edit plan ready.',
        transcript: verbatimTranscript || undefined,
        detectedLanguage: safeDetectedLang,
        recommendedFilterId: safeFilterId,
        filterIntensity:
          parsed.filterIntensity !== undefined
            ? Math.round(clampNum(parsed.filterIntensity, 30, 100, 100))
            : undefined,
        brightness:
          parsed.brightness !== undefined
            ? Math.round(clampNum(parsed.brightness, 50, 150, 100))
            : undefined,
        contrast:
          parsed.contrast !== undefined
            ? Math.round(clampNum(parsed.contrast, 50, 150, 100))
            : undefined,
        saturation:
          parsed.saturation !== undefined
            ? Math.round(clampNum(parsed.saturation, 0, 200, 100))
            : undefined,
        aspectRatio: safeRatio,
        frameFit: safeFit,
        slowMoRanges,
        keepRanges,
        captions,
        filterRecommendations,
      });
    } catch (err) {
      handleAiError(res, err, 'Unable to complete AI analysis right now. Please try again.');
    }
  });

  // Real Speech-to-Text endpoint (from microphone or extracted video audio) via gemini-3.5-transcribe
  app.post('/api/speech-to-text', async (req: Request, res: Response) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const audio = body.audio;
      if (
        !audio ||
        typeof audio !== 'object' ||
        typeof audio.mimeType !== 'string' ||
        !ALLOWED_AUDIO_MIMES.has(audio.mimeType) ||
        typeof audio.data !== 'string' ||
        audio.data.length === 0 ||
        audio.data.length > 5_500_000
      ) {
        res.status(400).json({ error: 'Valid audio input is required for Speech-to-Text.' });
        return;
      }
      if (audio.mimeType === 'audio/wav' && isSilentWavBase64(audio.data)) {
        res.status(422).json({ error: 'No clear speech was detected in this audio.' });
        return;
      }

      const reqLang =
        typeof body.language === 'string' && ALLOWED_LANGUAGES.has(body.language)
          ? body.language
          : 'auto';

      const prompt =
        reqLang === 'auto'
          ? 'Transcribe the spoken audio accurately in whichever of these 5 languages is spoken: Sindhi (سنڌي), Urdu (اردو), Hindi (हिन्दी), English, or Chinese (中文). Return only the exact transcript text.'
          : `Transcribe the spoken audio accurately in ${
              LANGUAGE_DIRECTIVES[reqLang] ?? reqLang
            }. Return only the exact transcript text in standard native script.`;

      const resp = await generateWithRetry(ai, {
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            { inlineData: { mimeType: audio.mimeType, data: audio.data } },
            { text: prompt },
          ],
        },
      });

      const transcript = (resp.text ?? '').trim();
      if (!transcript) {
        res.status(422).json({ error: 'No clear speech was detected in this audio.' });
        return;
      }

      res.json({
        text: transcript.slice(0, 2000),
        language: reqLang === 'auto' ? 'auto' : reqLang,
      });
    } catch (err) {
      handleAiError(res, err, 'Speech-to-Text failed right now. Please try again.');
    }
  });

  // Real Subtitle & Video Text Translation endpoint via gemini-4-hydrogen (strictly 5 languages)
  app.post('/api/translate', async (req: Request, res: Response) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const targetLanguage =
        typeof body.targetLanguage === 'string' &&
        ALLOWED_TARGET_LANGUAGES.has(body.targetLanguage)
          ? body.targetLanguage
          : '';

      if (!targetLanguage) {
        res.status(400).json({
          error:
            'Unsupported target language. Allowed: Sindhi, Urdu, Hindi, English, Chinese (Simplified/Traditional).',
        });
        return;
      }

      const rawTexts = Array.isArray(body.texts) ? body.texts : [];
      const texts = rawTexts
        .slice(0, 25)
        .map((t: unknown) => (typeof t === 'string' ? t.trim().slice(0, 300) : ''))
        .filter((t: string) => t.length > 0);

      if (texts.length === 0) {
        res.status(400).json({ error: 'No text provided to translate.' });
        return;
      }

      const numbered = texts.map((t: string, idx: number) => `${idx + 1}. ${t}`).join('\n');
      const targetDesc = LANGUAGE_DIRECTIVES[targetLanguage];

      const resp = await generateWithRetry(ai, {
        model: 'gemini-3.1-flash-lite',
        contents: [
          `Translate each numbered subtitle/video-title line naturally and concisely into ${targetDesc}.`,
          `Requirements:`,
          `- Preserve meaning, tone, and concise screen-friendly length.`,
          `- Return EXACTLY ${texts.length} translated strings in the exact same order inside "translations".`,
          `- For Sindhi (sd), use authentic Sindhi Arabic Unicode letters (سنڌي).`,
          `- For Urdu (ur), use proper Urdu script (اردو).`,
          `- For Hindi (hi), use standard Devanagari script (हिन्दी).`,
          `- For zh-Hans, use Simplified Chinese characters; for zh-Hant, use Traditional Chinese characters.`,
          `Lines:\n${numbered}`,
        ].join('\n'),
        config: {
          responseMimeType: 'application/json',
          responseSchema: translationResponseSchema,
        },
      });

      const raw = (resp.text ?? '{}').trim();
      let parsed: { translations?: unknown } = {};
      try {
        parsed = JSON.parse(raw) as { translations?: unknown };
      } catch {
        res.status(502).json({ error: 'Translation response was invalid. Please try again.' });
        return;
      }

      const out = Array.isArray(parsed.translations)
        ? parsed.translations.map((item) => String(item ?? '').trim().slice(0, 300))
        : [];

      if (out.length === 0) {
        res.status(502).json({ error: 'Translation returned empty results. Please try again.' });
        return;
      }

      res.json({ translations: out, targetLanguage });
    } catch (err) {
      handleAiError(res, err, 'Unable to translate subtitles right now.');
    }
  });

  // Real Text-to-Speech & AI Voice Generation via Gemini 3.8 TTS models
  app.post('/api/tts', async (req: Request, res: Response) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1200) : '';
      if (!text) {
        res.status(400).json({ error: 'Enter text to generate AI voice speech.' });
        return;
      }

      const language =
        typeof body.language === 'string' && ALLOWED_TARGET_LANGUAGES.has(body.language)
          ? body.language
          : 'en';
      const voiceName =
        typeof body.voiceName === 'string' && ALLOWED_TTS_VOICES.has(body.voiceName)
          ? body.voiceName
          : 'Kore';
      const voiceMode = body.voiceMode === 'voice_design' ? 'voice_design' : 'tts';
      const voiceGender =
        body.voiceGender === 'male'
          ? 'male'
          : body.voiceGender === 'female'
          ? 'female'
          : voiceName === 'Fenrir' || voiceName === 'Charon' || voiceName === 'Puck'
          ? 'male'
          : 'female';
      const stylePrompt =
        typeof body.stylePrompt === 'string' ? body.stylePrompt.trim().slice(0, 180) : '';

      const langLabel = LANGUAGE_DIRECTIVES[language] ?? 'English';
      const modelId =
        voiceMode === 'voice_design' ? 'gemini-3.8-flash-tts' : 'gemini-3.8-flash-lite-tts';

      const accentPersona =
        language === 'ur'
          ? `Speak fluently in natural Pakistani Urdu (${
              voiceGender === 'male' ? 'Pakistani male speaker' : 'Pakistani female speaker'
            }, authentic Karachi/Lahore pronunciation)`
          : language === 'sd'
          ? `Speak fluently in authentic Sindhi (${
              voiceGender === 'male' ? 'clear male speaker' : 'clear female speaker'
            }, natural Sindhi pronunciation)`
          : language === 'hi'
          ? `Speak fluently in natural Hindi (${
              voiceGender === 'male' ? 'clear male speaker' : 'clear female speaker'
            })`
          : `Speak fluently and naturally in ${langLabel} (${
              voiceGender === 'male' ? 'male speaker' : 'female speaker'
            })`;

      const combinedStyle = stylePrompt
        ? `${accentPersona}. Tone & delivery: ${stylePrompt}`
        : `${accentPersona} with warm, clear video narration pacing.`;

      const resp = await generateWithRetry(
        ai,
        {
          model: modelId,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text,
                  speechMetadata: {
                    style: combinedStyle,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        },
        25000
      );

      const audioPart = resp.candidates?.[0]?.content?.parts?.find(
        (p) => Boolean(p.inlineData?.data)
      );
      const base64Audio = audioPart?.inlineData?.data;
      const mimeType = audioPart?.inlineData?.mimeType || 'audio/wav';

      if (!base64Audio) {
        res.status(502).json({ error: 'AI Voice model did not return audio. Try shorter text.' });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType,
        model: modelId,
        language,
        voiceName,
      });
    } catch (err) {
      handleAiError(res, err, 'AI Voice generation failed right now. Please try again.');
    }
  });

  app.get(
    ['/download/meesam-tech-android-project.zip', '/api/download-project-zip'],
    (_req: Request, res: Response) => {
      try {
        const zipPath = path.resolve(__dirname, 'exports', 'meesam-tech-android-project.zip');
        const exportScript = path.resolve(__dirname, 'scripts', 'export-project-zip.py');
        if (!fs.existsSync(zipPath) && fs.existsSync(exportScript)) {
          execFileSync('python3', [exportScript], { cwd: __dirname, timeout: 60000 });
        }
        if (!fs.existsSync(zipPath)) {
          res.status(404).json({ error: 'Project ZIP archive is not available yet.' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.download(zipPath, 'meesam-tech-android-project.zip');
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to prepare project ZIP archive.',
        });
      }
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      const indexHtml = path.join(distPath, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MEESAM TECH server listening on http://0.0.0.0:${PORT}`);
    const zipPath = path.resolve(__dirname, 'exports', 'meesam-tech-android-project.zip');
    const exportScript = path.resolve(__dirname, 'scripts', 'export-project-zip.py');
    if (!fs.existsSync(zipPath) && fs.existsSync(exportScript)) {
      execFile('python3', [exportScript], { cwd: __dirname, timeout: 60000 }, () => {});
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start MEESAM TECH server:', err);
  process.exit(1);
});
