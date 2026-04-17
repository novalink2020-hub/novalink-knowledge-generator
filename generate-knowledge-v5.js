/**************************************************************
 * NovaLink Knowledge Generator V5.2
 * توليد knowledge.v5.json لمشروع NOVABOT / NOVALINK
 * - يعتمد على Sitemap + Scraper + (اختياري) Gemini
 * - مخصص لمحتوى الأعمال + الصفحات التعريفية + الخدمات فقط
 * - تنظيف الكلمات المفتاحية + تقليل التكرار + تمييز التدوينات
 **************************************************************/

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

/* =================== إعدادات عامة =================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// يمكن ضبطها من متغيرات البيئة في Render / محليًا
const SITEMAP_URL =
  process.env.SITEMAP_URL || "https://novalink-ai.com/sitemap.xml";

const OUTPUT_PATH =
  process.env.OUTPUT_PATH || path.join(__dirname, "knowledge.v5.json");

const GOOGLE_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.NOVALINK_GEMINI_KEY ||
  "";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

/**
 * حد التكرار العالي للكلمات المفتاحية (يُستخدم الآن فقط للكلمات العامة لو احتجناه لاحقاً)
 */
const COMMON_KEYWORD_THRESHOLD = 3;

/* ============ أدوات مساعدة للنص والكلمات ============ */

const ARABIC_DIACRITICS_RE = /[\u064B-\u0652\u0640]/g; // تشكيل + تطويل
const PUNCT_RE = /[.,!?؟،"“”()\-_:;«»[\]{}\\/]/g;
const MULTISPACE_RE = /\s+/g;

// أنماط نصوص مزعجة متكررة (قائمة التنقل في الهيدر إلخ)
const NAV_TRASH_PATTERNS = [
  /الرئيسيةالمدوناتخدماتنامن نحنإشترك الآن/g
];

const CONTENT_CANDIDATE_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  ".blog-post",
  ".post-content",
  ".post-body",
  ".article-content",
  ".entry-content",
  ".blog-content",
  ".rich-text",
  ".magazine-section",
  ".magazine-text",
  ".article-shell",
  "main article",
  "main .content-block",
  "main .narrow"
];

const NOISE_SELECTORS = [
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "noscript",
  "aside",
  "form",
  "iframe",
  "svg",
  ".site-header",
  ".site-footer",
  ".menu",
  ".breadcrumbs",
  ".footer",
  ".header",
  ".nav",
  ".sidebar",
  ".newsletter",
  ".subscribe",
  ".subscription",
  ".share-buttons",
  ".social-share",
  ".related-posts",
  ".related-articles",
  ".recommended-posts",
  ".comments",
  ".comment-form",
  ".author-box",
  ".cookie-banner",
  ".popup",
  ".modal",
  ".lightbox",
  ".references-section",
  ".show-more-wrapper",
  ".accordion",
  ".scroll-indicator",
  "[aria-hidden='true']",
  "[hidden]",
  "[data-novalink-seo='editor-only']"
];

const LINE_NOISE_PATTERNS = [
  /سياسة الخصوصية/i,
  /شروط الاستخدام/i,
  /privacy policy/i,
  /terms of service/i,
  /اشترك الآن/i,
  /اشترك في النشرة/i,
  /جميع الحقوق محفوظة/i,
  /contact@/i,
  /تابعنا/i,
  /روابط مهمة/i,
  /اقرأ المزيد/i,
  /عرض المزيد/i
];

function stripArabicDiacritics(str = "") {
  return str.replace(ARABIC_DIACRITICS_RE, "");
}

function normalizeKeywordRaw(str = "") {
  return stripArabicDiacritics(
    str
      .toLowerCase()
      .replace(PUNCT_RE, " ")
      .replace(MULTISPACE_RE, " ")
      .trim()
  );
}

function cleanExtractedText(str = "") {
  let text = `${str}`
    .replace(/\u00a0/g, " ")
    .replace(MULTISPACE_RE, " ")
    .trim();

  for (const re of NAV_TRASH_PATTERNS) {
    text = text.replace(re, " ");
  }

  const cleanedLines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      return !LINE_NOISE_PATTERNS.some((pattern) => pattern.test(line));
    });

  return cleanedLines.join(" ").replace(MULTISPACE_RE, " ").trim();
}

function getBestContentBlock($) {
  let bestText = "";
  let bestLength = 0;

  for (const selector of CONTENT_CANDIDATE_SELECTORS) {
    $(selector).each((_, el) => {
      const cloned = $(el).clone();

      NOISE_SELECTORS.forEach((noiseSelector) => {
        cloned.find(noiseSelector).remove();
      });

      const text = cleanExtractedText(cloned.text());
      const len = text.length;

      if (len > bestLength) {
        bestLength = len;
        bestText = text;
      }
    });
  }

  return bestText;
}

function isTooSimilarToTitle(candidate = "", title = "") {
  const a = normalizeKeywordRaw(candidate);
  const b = normalizeKeywordRaw(title);

  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aWords = new Set(a.split(" ").filter(Boolean));
  const bWords = new Set(b.split(" ").filter(Boolean));

  if (aWords.size === 0 || bWords.size === 0) return false;

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  const overlapRatioA = overlap / aWords.size;
  const overlapRatioB = overlap / bWords.size;

  return overlapRatioA >= 0.7 || overlapRatioB >= 0.7;
}

function extractFirstMeaningfulSnippet(text = "", maxLength = 260, title = "", description = "") {
  const cleaned = cleanExtractedText(text);
  if (!cleaned) return "";

  const sentenceParts = cleaned
    .split(/(?<=[.!؟?])\s+|[。]\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.length >= 45);

  const accepted = [];

  for (const part of sentenceParts) {
    if (isTooSimilarToTitle(part, title)) continue;
    if (description && normalizeKeywordRaw(part) === normalizeKeywordRaw(description)) continue;

    accepted.push(part);

    if (accepted.length >= 2) break;
  }

  if (accepted.length > 0) {
    return accepted.join(" ").slice(0, maxLength).trim();
  }

  const fallbackParts = sentenceParts.filter(
    (part) => !description || normalizeKeywordRaw(part) !== normalizeKeywordRaw(description)
  );

  if (fallbackParts.length > 0) {
    return fallbackParts.slice(0, 2).join(" ").slice(0, maxLength).trim();
  }

  return cleaned.slice(0, maxLength).trim();
}

function cleanTitle(str = "") {
  return str
    .replace(/\s+/g, " ")
    .replace(/\|.*$/g, "")
    .trim();
}

function nowISO() {
  return new Date().toISOString();
}

/* ============ قائمة الكلمات العامة المراد حذفها ============ */

const STOP_KEYWORDS = new Set(
  [
    // عام عربي
    "الذكاء الاصطناعي",
    "الذكاء الاصطناعي للاعمال",
    "ذكاء اصطناعي",
    "ذكاء صناعي",
    "ذكاء صنعي",
    "الاعمال",
    "الأعمال",
    "الاعمال الرقمية",
    "التحول الرقمي",
    "محتوى",
    "مقال",
    "تدوينة",
    "تدوينات",
    "مدونة",
    "موقع",
    "منصة",
    "خدمات",
    "خدمة",

    // هوية العلامة
    "novalink",
    "novalink ai",
    "نوفا لينك",
    "nova link",
    "nova-link",

    // اشتراك ونشرة
    "نشرة بريدية",
    "newsletter",
    "اشترك الآن",
    "اشترك الان",
    "اشتراك نوفا لينك",
    "email",
    "بريد الكتروني",
    "بريد إلكتروني",

    // تسويق عام جداً
    "ai",
    "ai tools",
    "ai business",
    "ai jobs",
    "ai content",

    // بوت وخدمات عامة
    "استشارة",
    "خدمات نوفا لينك",
    "بوت دردشة",
    "chatbot",
    "ai chatbot",

    // أشياء تقنية عامة لكنها غير مميِّزة
    "موقع نوفا لينك",
    "novalink ai platform"
  ].map(normalizeKeywordRaw)
);

/* ============ استدعاء Gemini (اختياري) ============ */

async function callGeminiForPage({
  title,
  description,
  excerpt,
  rawText,
  category,
  subcategory,
  intent_hint
}) {
  if (!GOOGLE_API_KEY) {
    return null;
  }

  const prompt = `
أنت مهندس فهرسة Retrieval لمساعد محادثة ذكي داخل live chat.
مهمتك ليست كتابة محتوى، ولا تلخيص المقال، ولا كتابة SEO، ولا إعادة صياغة الوصف.
مهمتك الوحيدة هي توليد فهرس استدلالي يساعد البوت على ربط سؤال المستخدم بالتدوينة أو الصفحة الصحيحة.

اعتمد فقط على البيانات التالية القادمة من الصفحة:
- title
- description
- excerpt
- rawText
- category
- subcategory
- intent_hint

أعد JSON فقط، بدون أي شرح خارجي، وبهذا الشكل حرفيًا:
{
  "entities": ["..."],
  "aliases": ["..."],
  "misspellings": ["..."],
  "faq_queries_human": ["..."],
  "answer_scope": "..."
}

القواعد الإلزامية:
- لا تؤلف معلومات غير موجودة في المعطيات.
- لا تكتب أي مقدمة أو ملاحظات أو markdown.
- جميع النصوص يجب أن تكون بدون تشكيل.
- لا تستخدم علامات استفهام.
- لا تستخدم فاصلة منقوطة أو زخرفة أو ايموجي.
- تجنب الجمل الطويلة.
- تجنب إعادة نفس الفكرة في اكثر من حقل.
- إذا كان العنصر عاما جدا وغير مميز استبعِده.
- ركز على ما يساعد المطابقة داخل دردشة حية، لا على الكتابة التحريرية.

قواعد entities:
- اكتب من 3 إلى 6 عناصر فقط.
- اجعلها شديدة التحديد.
- تشمل اسم الاداة او المنصة او المفهوم المركزي او use case واضح.
- امنع الكلمات العامة مثل: الذكاء الاصطناعي، الأعمال، الشركات، البيانات، المحتوى، الخدمات
  إلا إذا كانت جزءا من اسم مركب مميز فعلا.
- لا تكرر نفس العنصر بصيغة عربية وانجليزية داخل entities.

قواعد aliases:
- اكتب من 4 إلى 8 عناصر فقط.
- اجعلها بدائل بحثية حقيقية: عربي، انجليزي، هجينة، اختصار، اسم شائع.
- لا تحول aliases إلى جمل وصفية.
- لا تكتب عبارات تسويقية.
- لا تكرر entity نفسها حرفيا إلا عند الحاجة بسبب اختلاف لغة أو اختصار مهم.

قواعد misspellings:
- اكتب من 2 إلى 5 عناصر فقط.
- اكتب فقط أخطاء واقعية جدا يمكن أن يكتبها المستخدم.
- لا تكرر نفس الكلمة.
- لا تضع الكلمة الصحيحة داخل misspellings.
- لا تضع أخطاء مصطنعة أو غريبة.

قواعد faq_queries_human:
- اكتب من 6 إلى 10 عناصر فقط.
- اجعلها مثل رسائل المستخدم في الشات، لا مثل عناوين مقالات.
- اكتبها بدون تشكيل وبدون علامات استفهام.
- اجعل معظمها بالعربية الطبيعية.
- يمكن إضافة 1 إلى 3 صيغ انجليزية أو هجينة فقط عند الحاجة.
- نوّع الصياغة بين:
  - سؤال مباشر
  - صيغة مختصرة
  - نية استخدام
  - مشكلة عملية
- لا تكرر اسم الاداة في كل سطر إذا أمكن.
- لا تكتب قوائم كلمات متنكرة في شكل سؤال.
- لا تكتب عبارات عامة تصلح لعشرات المقالات.

قواعد answer_scope:
- سطر واحد فقط.
- يشرح بدقة ما الذي تغطيه الصفحة.
- لا تكرر title أو description حرفيا.
- لا تستخدم صياغة تسويقية.
- اذكر الحدود عند الحاجة بشكل مختصر.

قبل إخراج النتيجة:
- احذف التكرار الدلالي بين الحقول.
- اجعل الناتج مضغوطا ومفيدا للاسترجاع.
- فكر كمهندس matching وليس ككاتب محتوى.

بيانات الصفحة:
title: ${title || ""}
description: ${description || ""}
excerpt: ${excerpt || ""}
category: ${category || ""}
subcategory: ${subcategory || ""}
intent_hint: ${intent_hint || ""}

rawText:
${(rawText || "").slice(0, 6000)}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 700
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error("❌ Gemini HTTP error:", res.status, await res.text());
      return null;
    }

    const json = await res.json();
    const textPart = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const start = textPart.indexOf("{");
    const end = textPart.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      console.error("❌ Gemini response not JSON-like:", textPart);
      return null;
    }

    const parsed = JSON.parse(textPart.slice(start, end + 1));

    return {
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((v) => `${v}`.trim()).filter(Boolean)
        : [],
      aliases: Array.isArray(parsed.aliases)
        ? parsed.aliases.map((v) => `${v}`.trim()).filter(Boolean)
        : [],
      misspellings: Array.isArray(parsed.misspellings)
        ? parsed.misspellings.map((v) => `${v}`.trim()).filter(Boolean)
        : [],
      faq_queries_human: Array.isArray(parsed.faq_queries_human)
        ? parsed.faq_queries_human.map((v) => `${v}`.trim()).filter(Boolean)
        : [],
      answer_scope: `${parsed.answer_scope || ""}`.trim()
    };
  } catch (err) {
    console.error("❌ Gemini parse/error:", err);
    return null;
  }
}

const RETRIEVAL_GENERIC_TERMS = new Set(
  [
    "novalink ai",
    "novalink",
    "نوفا لينك",
    "نوفالينك",
    "الذكاء الاصطناعي",
    "الذكاء الاصطناعي في الاعمال",
    "الذكاء الاصطناعي في الشركات",
    "الاعمال",
    "الأعمال",
    "الشركات",
    "الشركة",
    "المحتوى",
    "الخدمات",
    "خدمات",
    "البيانات",
    "المستندات",
    "الاجتماعات",
    "البريد",
    "منصة عربية",
    "منصة الذكاء الاصطناعي",
    "منصة ai عربية"
  ].map(normalizeKeywordRaw)
);

function containsArabic(str = "") {
  return /[\u0600-\u06FF]/.test(str);
}

function normalizeRetrievalText(str = "") {
  return stripArabicDiacritics(
    `${str}`
      .replace(/\u00a0/g, " ")
      .replace(/[؟?]+/g, "")
      .replace(/[،؛;!]+/g, " ")
      .replace(/[“”"«»]/g, "")
      .replace(/[(){}\[\]]/g, " ")
      .replace(/[^\p{L}\p{N}\s./+-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normalizeRetrievalKey(str = "") {
  return normalizeKeywordRaw(
    `${str}`
      .replace(/[؟?]+/g, "")
      .replace(/[،؛;!]+/g, " ")
      .trim()
  );
}

function dedupeRetrievalList(list = [], { max = 10, preferArabic = true } = {}) {
  const bucket = new Map();

  for (const raw of Array.isArray(list) ? list : []) {
    const cleaned = normalizeRetrievalText(raw);
    const key = normalizeRetrievalKey(cleaned);

    if (!cleaned || !key) continue;

    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, cleaned);
      continue;
    }

    if (preferArabic) {
      const prevArabic = containsArabic(prev);
      const nextArabic = containsArabic(cleaned);

      if (!prevArabic && nextArabic) {
        bucket.set(key, cleaned);
        continue;
      }
    }

    if (cleaned.length < prev.length) {
      bucket.set(key, cleaned);
    }
  }

  return Array.from(bucket.values()).slice(0, max);
}

function filterGenericRetrievalTerms(list = [], { max = 10 } = {}) {
  return dedupeRetrievalList(list, { max: max * 2 }).filter((item) => {
    const key = normalizeRetrievalKey(item);
    if (!key) return false;
    if (RETRIEVAL_GENERIC_TERMS.has(key)) return false;

    const words = key.split(" ").filter(Boolean);
    if (words.length === 1 && words[0].length <= 3) return false;

    return true;
  }).slice(0, max);
}

function cleanMisspellingsList(list = [], protectedTerms = []) {
  const protectedNormalized = dedupeRetrievalList(protectedTerms, { max: 50 });
  const protectedKeys = new Set(
    protectedNormalized.map((item) => normalizeRetrievalKey(item))
  );

  const protectedArabicWords = new Set();

  for (const item of protectedNormalized) {
    const normalized = normalizeRetrievalKey(item);
    const words = normalized.split(" ").filter(Boolean);

    for (const word of words) {
      if (containsArabic(word) && word.length >= 3) {
        protectedArabicWords.add(word);
      }
    }
  }

  const result = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const cleaned = normalizeRetrievalText(raw);
    const key = normalizeRetrievalKey(cleaned);

    if (!cleaned || !key) continue;
    if (seen.has(key)) continue;
    if (protectedKeys.has(key)) continue;
    if (RETRIEVAL_GENERIC_TERMS.has(key)) continue;

    const words = key.split(" ").filter(Boolean);
    if (words.length === 0 || words.length > 3) continue;
    if (key.length < 3) continue;

    const isArabic = containsArabic(cleaned);
    const isLatin = /[a-z]/i.test(cleaned);

    if (isLatin && !isArabic) {
      continue;
    }

    if (words.length === 1) {
      const word = words[0];

      if (protectedArabicWords.has(word)) continue;
      if (word.length < 4) continue;

      const repeatedChars = /(.)\1{2,}/.test(word);
      if (repeatedChars) continue;
    }

    if (
      key.includes("الذكاء الاصطناعي") ||
      key.includes("الاعمال") ||
      key.includes("الأعمال") ||
      key.includes("الشركات")
    ) {
      continue;
    }

    seen.add(key);
    result.push(cleaned);

    if (result.length >= 5) break;
  }

  return result;
}

function cleanFaqQueriesHuman(list = [], primaryTerms = []) {
  const protectedKeys = new Set(
    dedupeRetrievalList(primaryTerms, { max: 50 }).map((item) =>
      normalizeRetrievalKey(item)
    )
  );

  const result = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const cleaned = normalizeRetrievalText(raw);
    const key = normalizeRetrievalKey(cleaned);

    if (!cleaned || !key) continue;
    if (seen.has(key)) continue;
    if (protectedKeys.has(key)) continue;

    const words = cleaned.split(" ").filter(Boolean);
    if (words.length < 3 || words.length > 12) continue;

    seen.add(key);
    result.push(cleaned);

    if (result.length >= 10) break;
  }

  return result;
}

function buildRetrievalKeywords({
  entities = [],
  aliases = [],
  faq_queries_human = [],
  title_clean = "",
  category = "",
  subcategory = ""
}) {
  const shortKeywords = [];
  const intentPhrases = [];

  const coreEntities = filterGenericRetrievalTerms(entities, { max: 6 });
  const coreAliases = filterGenericRetrievalTerms(aliases, { max: 8 });
  const cleanFaq = cleanFaqQueriesHuman(faq_queries_human, [...coreEntities, ...coreAliases]);

  for (const item of [...coreEntities, ...coreAliases]) {
    const cleaned = normalizeRetrievalText(item);
    const words = cleaned.split(" ").filter(Boolean);

    if (words.length >= 1 && words.length <= 4) {
      shortKeywords.push(cleaned);
    }
  }

  for (const q of cleanFaq) {
    const cleaned = normalizeRetrievalText(q);
    const words = cleaned.split(" ").filter(Boolean);

    if (words.length >= 3 && words.length <= 7) {
      intentPhrases.push(cleaned);
    }
  }

  if (category === "home") {
    shortKeywords.unshift("نوفا لينك", "منصة ذكاء اصطناعي للاعمال");
  }

  if (subcategory === "about_us") {
    shortKeywords.unshift("من نحن", "عن نوفا لينك");
  }

  if (subcategory === "founder_story") {
    shortKeywords.unshift("قصة نوفا لينك", "بداية نوفا لينك");
  }

  if (title_clean) {
    const titleNormalized = normalizeRetrievalText(title_clean);
    const titleWords = titleNormalized.split(" ").filter(Boolean);

    if (titleWords.length >= 2 && titleWords.length <= 5) {
      shortKeywords.push(titleNormalized);
    }
  }

  const arabicShort = dedupeRetrievalList(
    shortKeywords.filter((item) => containsArabic(item)),
    { max: 8 }
  );

  const nonArabicShort = dedupeRetrievalList(
    shortKeywords.filter((item) => !containsArabic(item)),
    { max: 4, preferArabic: false }
  );

  const shortFinal = dedupeRetrievalList(
    [...arabicShort, ...nonArabicShort],
    { max: 6 }
  );

  const intentFinal = dedupeRetrievalList(
    intentPhrases.filter((item) => containsArabic(item)),
    { max: 2 }
  );

  return dedupeRetrievalList(
    [...shortFinal, ...intentFinal],
    { max: 8 }
  );
}

function finalizeRetrievalFields({
  title_clean = "",
  category = "",
  subcategory = "",
  entities = [],
  aliases = [],
  misspellings = [],
  faq_queries_human = [],
  answer_scope = ""
}) {
  const cleanEntities = filterGenericRetrievalTerms(entities, { max: 6 });

  const rawAliases = filterGenericRetrievalTerms(aliases, { max: 12 });
  const arabicAliases = dedupeRetrievalList(
    rawAliases.filter((item) => containsArabic(item)),
    { max: 6 }
  );
  const nonArabicAliases = dedupeRetrievalList(
    rawAliases.filter((item) => !containsArabic(item)),
    { max: 2, preferArabic: false }
  );
  const cleanAliases = dedupeRetrievalList(
    [...arabicAliases, ...nonArabicAliases],
    { max: 8 }
  );

  const protectedTerms = [
    title_clean,
    ...cleanEntities,
    ...cleanAliases
  ];

  const cleanMisspellings = cleanMisspellingsList(misspellings, protectedTerms);

  const rawFaq = cleanFaqQueriesHuman(faq_queries_human, protectedTerms);
  const arabicFaq = dedupeRetrievalList(
    rawFaq.filter((item) => containsArabic(item)),
    { max: 8 }
  );
  const nonArabicFaq = dedupeRetrievalList(
    rawFaq.filter((item) => !containsArabic(item)),
    { max: 1, preferArabic: false }
  );
  let cleanFaq = dedupeRetrievalList(
    [...arabicFaq, ...nonArabicFaq],
    { max: 9 }
  );

  // المقالات العامة جدًا يجب أن تظل مفيدة، لكن دون surface area واسعة
  // تمنحها القدرة على سرقة أسئلة من المقالات المتخصصة
  if (subcategory === "broad_ai_overview") {
    cleanFaq = cleanFaq.filter((item) => {
      const key = normalizeRetrievalKey(item);

      // نمنع الصياغات التي تصلح لعشرات المقالات الأخرى
      if (
        key.includes("في عملي") ||
        key.includes("في شغلي") ||
        key.includes("لشركتي") ||
        key.includes("في الشركات") ||
        key.includes("كيف ابدا") ||
        key.includes("كيف ابدأ") ||
        key.includes("امثلة") ||
        key.includes("أمثلة") ||
        key.includes("what ai tools") ||
        key.includes("help my business")
      ) {
        return false;
      }

      return true;
    });

    cleanFaq = dedupeRetrievalList(cleanFaq, { max: 4 });
  }

  const retrievalKeywords = buildRetrievalKeywords({
    entities: cleanEntities,
    aliases: cleanAliases,
    faq_queries_human: cleanFaq,
    title_clean,
    category,
    subcategory
  });

  return {
    entities: cleanEntities,
    aliases: cleanAliases,
    misspellings: cleanMisspellings,
    faq_queries_human: cleanFaq,
    answer_scope: normalizeRetrievalText(answer_scope),
    retrieval_keywords: retrievalKeywords
  };
}

/* ============ جلب الـ Sitemap واستخراج الروابط ============ */

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

async function getSitemapUrls() {
  console.log("🌐 Fetching sitemap:", SITEMAP_URL);
  const xml = await fetchText(SITEMAP_URL);
  const $ = cheerio.load(xml, { xmlMode: true });

  const urls = [];
  $("url > loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) urls.push(loc);
  });

  console.log(`🗺️ Sitemap URLs found: ${urls.length}`);
  return urls;
}

/* ============ تصنيف نوع الصفحة من الرابط والعنوان ============ */

function classifyPage(url, title) {
  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || "").toLowerCase();

  // home
  if (
    lowerUrl === "https://novalink-ai.com" ||
    lowerUrl === "https://novalink-ai.com/"
  ) {
    return {
      category: "home",
      subcategory: "landing",
      intent_hint: "novalink_info"
    };
  }

  // about us
  if (lowerUrl.includes("about-us")) {
    return {
      category: "about",
      subcategory: "about_us",
      intent_hint: "novalink_info"
    };
  }

  // founder story
  if (lowerUrl.includes("rhlh-frdyh")) {
    return {
      category: "story",
      subcategory: "founder_story",
      intent_hint: "novalink_info"
    };
  }

  // services
  if (lowerUrl.includes("services-khdmat")) {
    return {
      category: "services",
      subcategory: "ai_services",
      intent_hint: "consulting_purchase"
    };
  }

  // مقالات متعلقة بالتعليق الصوتي
  if (
    lowerTitle.includes("murf") ||
    lowerTitle.includes("elevenlabs") ||
    lowerTitle.includes("daryjat") ||
    lowerTitle.includes("تعليق صوتي") ||
    lowerTitle.includes("التعليق الصوتي")
  ) {
    return {
      category: "blog",
      subcategory: "ai_voiceover",
      intent_hint: "ai_business"
    };
  }

  // وظائف / مهن
  if (
    lowerTitle.includes("وظيفتك") ||
    lowerTitle.includes("مهن") ||
    lowerTitle.includes("وظائف") ||
    lowerTitle.includes("سوق العمل")
  ) {
    return {
      category: "blog",
      subcategory: "ai_jobs_future",
      intent_hint: "ai_business"
    };
  }

  // Copy.ai / كتابة محتوى
  if (
    lowerTitle.includes("copy.ai") ||
    lowerTitle.includes("copyai") ||
    lowerTitle.includes("كوبي")
  ) {
    return {
      category: "blog",
      subcategory: "ai_copywriting",
      intent_hint: "ai_business"
    };
  }

  // المقالات العامة جدًا عن "الذكاء الاصطناعي للأعمال" يجب فصلها
  // عن المقالات الأخرى حتى نستطيع تضييق surface area الخاصة بها لاحقًا
  if (
    lowerUrl.includes("blog-post") ||
    lowerTitle.includes("ثورة في عالم الأعمال") ||
    lowerTitle.includes("ادوات الذكاء الاصطناعي") ||
    lowerTitle.includes("أدوات الذكاء الاصطناعي") ||
    lowerTitle.includes("ai tools") ||
    lowerTitle.includes("tools for business") ||
    lowerTitle.includes("تطبيقات الذكاء الاصطناعي") ||
    lowerTitle.includes("الذكاء الاصطناعي في عالم الأعمال")
  ) {
    return {
      category: "blog",
      subcategory: "broad_ai_overview",
      intent_hint: "ai_business"
    };
  }

  // أي شيء آخر نعدّه تدوينة / محتوى معرفي عام لكن ليس broad overview
  return {
    category: "blog",
    subcategory: "ai_business_article",
    intent_hint: "ai_business"
  };
}

function getRetrievalProfile({ category = "", subcategory = "" }) {
  if (subcategory === "broad_ai_overview") {
    return {
      profile: "broad_ai_overview",
      faqMax: 3,
      topicMax: 3,
      extendedMax: 3,
      embeddingFaqMax: 1,
      embeddingTopicMax: 3,
      strictFaq: true,
      strictTopic: true
    };
  }

  if (subcategory === "ai_copywriting" || subcategory === "ai_voiceover") {
    return {
      profile: "tool_specific",
      faqMax: 8,
      topicMax: 8,
      extendedMax: 8,
      embeddingFaqMax: 2,
      embeddingTopicMax: 6,
      strictFaq: false,
      strictTopic: false
    };
  }

  if (subcategory === "ai_jobs_future") {
    return {
      profile: "jobs_future",
      faqMax: 7,
      topicMax: 8,
      extendedMax: 8,
      embeddingFaqMax: 2,
      embeddingTopicMax: 6,
      strictFaq: false,
      strictTopic: false
    };
  }

  if (subcategory === "founder_story") {
    return {
      profile: "founder_story",
      faqMax: 7,
      topicMax: 8,
      extendedMax: 7,
      embeddingFaqMax: 2,
      embeddingTopicMax: 5,
      strictFaq: false,
      strictTopic: false
    };
  }

  if (category === "services") {
    return {
      profile: "services_page",
      faqMax: 8,
      topicMax: 7,
      extendedMax: 8,
      embeddingFaqMax: 2,
      embeddingTopicMax: 5,
      strictFaq: false,
      strictTopic: false
    };
  }

  if (category === "about") {
    return {
      profile: "about_page",
      faqMax: 7,
      topicMax: 7,
      extendedMax: 7,
      embeddingFaqMax: 2,
      embeddingTopicMax: 5,
      strictFaq: false,
      strictTopic: false
    };
  }

  if (category === "home") {
    return {
      profile: "home_page",
      faqMax: 8,
      topicMax: 7,
      extendedMax: 7,
      embeddingFaqMax: 2,
      embeddingTopicMax: 5,
      strictFaq: false,
      strictTopic: false
    };
  }

  return {
    profile: "general_ai_article",
    faqMax: 6,
    topicMax: 6,
    extendedMax: 6,
    embeddingFaqMax: 2,
    embeddingTopicMax: 5,
    strictFaq: false,
    strictTopic: false
  };
}

/* ============ تحديد الصفحات المسموحة في ملف المعرفة ============ */

function shouldIncludeUrl(url) {
  const lowerUrl = url.toLowerCase();

  // home root
  if (
    lowerUrl === "https://novalink-ai.com" ||
    lowerUrl === "https://novalink-ai.com/"
  ) {
    return true;
  }

  // about, story, services
  if (
    lowerUrl.includes("about-us-althkaa-alastnaay") ||
    lowerUrl.includes("rhlh-frdyh-fy-aalm-althkaa-alastnaay-hktha-bdat-nwfa-lynk") ||
    lowerUrl.includes("services-khdmat-nwfa-lynk")
  ) {
    return true;
  }

  // صفحات يجب استبعادها من ملف المعرفة
  if (
    lowerUrl.includes("syash-alkhswsyh") || // سياسة الخصوصية
    lowerUrl.includes("shrwt-alastkhdam") || // شروط الاستخدام
    lowerUrl.includes("ashtrk-alan") || // اشترك الآن
    lowerUrl.includes("blog-adwat-althkaa-alastnaay-llaamal") || // صفحة "مدونة"
    lowerUrl.endsWith("/tag/") ||
    lowerUrl.includes("/tag/")
  ) {
    return false;
  }

  // أي صفحة مقالة حقيقية تحت نفس الدومين
  if (lowerUrl.startsWith("https://novalink-ai.com/")) {
    return true;
  }

  return false;
}

/* ============ استخراج محتوى الصفحة ============ */

function extractPageContent(html, url) {
  const $ = cheerio.load(html);

  // العنوان من الميتا أو <title>
  let title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text() ||
    "";
  title = title.trim();

  // الوصف من الميتا إن وجد
  let metaDesc =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  metaDesc = metaDesc.trim();

// إزالة العناصر المزعجة العامة أولاً
NOISE_SELECTORS.forEach((selector) => {
  $(selector).remove();
});

let mainText = getBestContentBlock($);

// fallback إذا لم نجد كتلة واضحة
if (!mainText || mainText.length < 250) {
  const mainEl = $("main").clone();

  if (mainEl.length) {
    NOISE_SELECTORS.forEach((selector) => {
      mainEl.find(selector).remove();
    });

    mainText = cleanExtractedText(mainEl.text());
  }
}

// fallback إضافي إلى article
if (!mainText || mainText.length < 180) {
  const articleEl = $("article").clone();

  if (articleEl.length) {
    NOISE_SELECTORS.forEach((selector) => {
      articleEl.find(selector).remove();
    });

    mainText = cleanExtractedText(articleEl.text());
  }
}

// آخر fallback إلى body
if (!mainText || mainText.length < 120) {
  const bodyEl = $("body").clone();

  NOISE_SELECTORS.forEach((selector) => {
    bodyEl.find(selector).remove();
  });

  mainText = cleanExtractedText(bodyEl.text());
}

const descriptionRaw =
  metaDesc ||
  extractFirstMeaningfulSnippet(mainText, 400, title, "") ||
  cleanTitle(title);

const description = `${descriptionRaw}`.slice(0, 400).trim();

const excerptRaw =
  extractFirstMeaningfulSnippet(mainText, 260, title, description) ||
  "";

const excerpt = excerptRaw || "";

return {
  title,
  description: description || cleanTitle(title),
  excerpt:
    excerpt ||
    extractFirstMeaningfulSnippet(mainText, 220, title, description) ||
    description ||
    cleanTitle(title),
  rawText: mainText
};
}

/* ============ توليد عنصر المعرفة لصفحة واحدة ============ */

async function buildKnowledgeItem(url) {
  console.log(`📝 Processing: ${url}`);

  const html = await fetchText(url);
  const { title, description, excerpt, rawText } = extractPageContent(html, url);

  const title_clean = cleanTitle(title);
  const { category, subcategory, intent_hint } = classifyPage(url, title);

  // استدعاء Gemini لاشتقاق Retrieval Layer (إن أمكن)
  let llmRetrieval = null;
  if (GOOGLE_API_KEY) {
    llmRetrieval = await callGeminiForPage({
      title,
      description,
      excerpt,
      rawText,
      category,
      subcategory,
      intent_hint
    });
  }

  const summary =
    description ||
    excerpt ||
    extractFirstMeaningfulSnippet(rawText, 260) ||
    title_clean;

  const summary_short =
    extractFirstMeaningfulSnippet(summary, 140) ||
    title_clean;

  const summary_long = summary;

  const finalizedRetrieval = finalizeRetrievalFields({
    title_clean,
    category,
    subcategory,
    entities: Array.isArray(llmRetrieval?.entities) ? llmRetrieval.entities : [],
    aliases: Array.isArray(llmRetrieval?.aliases) ? llmRetrieval.aliases : [],
    misspellings: Array.isArray(llmRetrieval?.misspellings) ? llmRetrieval.misspellings : [],
    faq_queries_human: Array.isArray(llmRetrieval?.faq_queries_human)
      ? llmRetrieval.faq_queries_human
      : [],
    answer_scope: typeof llmRetrieval?.answer_scope === "string"
      ? llmRetrieval.answer_scope
      : ""
  });

  let retrievalBase = Array.isArray(finalizedRetrieval.retrieval_keywords)
    ? finalizedRetrieval.retrieval_keywords
    : [];

  if (!retrievalBase.length) {
    const base = `${title_clean} ${description}`.split(/[،,.]/);
    retrievalBase = base
      .map((p) => normalizeRetrievalText(p))
      .filter((p) => p.split(" ").length <= 6 && p.length > 2);
  }

  const shortKeywordsRaw = dedupeRetrievalList(
    retrievalBase.filter((item) => {
      const cleaned = normalizeRetrievalText(item);
      const words = cleaned.split(" ").filter(Boolean);
      return words.length >= 1 && words.length <= 4;
    }),
    { max: 10 }
  );

  const arabicShortKeywords = dedupeRetrievalList(
    shortKeywordsRaw.filter((item) => containsArabic(item)),
    { max: 6 }
  );

  const nonArabicShortKeywords = dedupeRetrievalList(
    shortKeywordsRaw.filter((item) => !containsArabic(item)),
    { max: 4, preferArabic: false }
  );

  const intentTopicKeywords = dedupeRetrievalList(
    finalizedRetrieval.faq_queries_human.filter((item) => {
      const cleaned = normalizeRetrievalText(item);
      const words = cleaned.split(" ").filter(Boolean);
      return words.length >= 4 && words.length <= 8;
    }),
    { max: 3 }
  );

  const keywords = dedupeRetrievalList(
    [
      ...arabicShortKeywords,
      ...nonArabicShortKeywords.filter((item) => {
        const normalized = normalizeRetrievalKey(item);
        return !arabicShortKeywords.some(
          (arabicItem) => normalizeRetrievalKey(arabicItem) === normalized
        );
      }).slice(0, 1)
    ],
    { max: 6 }
  );

  const keywords_extended = dedupeRetrievalList(
    [...arabicShortKeywords, ...nonArabicShortKeywords, ...finalizedRetrieval.aliases],
    { max: 8 }
  );

  let topic_keywords = dedupeRetrievalList(
    [...keywords, ...intentTopicKeywords],
    { max: 8 }
  );

  // المقالات العامة جدًا يجب أن تحتفظ بإشارات موضوعية عامة
  // لكن دون intent phrases واسعة تجعلها تنافس المقالات المتخصصة
  if (subcategory === "broad_ai_overview") {
    topic_keywords = dedupeRetrievalList(
      topic_keywords.filter((item) => {
        const key = normalizeRetrievalKey(item);

        if (
          key.includes("في عملي") ||
          key.includes("في شغلي") ||
          key.includes("لتطوير عملي") ||
          key.includes("في مجال عملي") ||
          key.includes("لشركتي") ||
          key.includes("في الشركات") ||
          key.includes("كيف يساعد") ||
          key.includes("كيف يمكنني") ||
          key.includes("اريد استخدام") ||
          key.includes("أريد استخدام")
        ) {
          return false;
        }

        return true;
      }),
      { max: 4 }
    );
  }

  const embeddingParts = dedupeRetrievalList(
    [
      title_clean,
      summary_short,
      finalizedRetrieval.entities.join(" "),
      keywords_extended.join(" "),
      topic_keywords.slice(0, 6).join(" "),
      finalizedRetrieval.faq_queries_human.slice(0, 2).join(" ")
    ].filter(Boolean),
    { max: 6 }
  );

  const embedding_text = [
    ...embeddingParts,
    url
  ]
    .filter(Boolean)
    .join(" | ");

  const domain = "https://novalink-ai.com";

  const item = {
    title,
    title_clean,
    url,
    domain,
    category,
    subcategory,
    intent_hint,
    description,
    excerpt,
    summary,
    summary_short,
    summary_long,
    facts: [],
    keywords,
    keywords_extended,
    topic_keywords,
    embedding_text,
    entities: finalizedRetrieval.entities,
    aliases: finalizedRetrieval.aliases,
    misspellings: finalizedRetrieval.misspellings,
    faq_queries_human: finalizedRetrieval.faq_queries_human,
    answer_scope: finalizedRetrieval.answer_scope,
    weight_title: 1,
    weight_summary: 0.9,
    weight_keywords: 0.8,
    weight_semantic: 1,
    weight_final: 1,
    updated_at: nowISO(),
    source: "sitemap+scraper+gemini-v5.2"
  };

  return item;
}

/* ============ تنظيف وتوحيد الكلمات المفتاحية لجميع العناصر ============ */
/**
 * المنهج هنا:
 * - نطبّع الكلمات ونحذف الضجيج و STOP_KEYWORDS.
 * - نحسب عدد ظهور كل كلمة عبر جميع العناصر.
 * - للتدوينات (category = "blog"): نحتفظ فقط بالكلمات التي تظهر في تدوينة واحدة فقط (unique).
 * - لو تدوينة أصبحت بلا أي كلمة مميزة → نحذفها بالكامل من ملف المعرفة.
 * - للصفحات التعريفية (home / about / story / services): نسمح ببعض التكرار المعقول.
 */

function extractFallbackKeywords(item) {
  const candidates = [
    item.title_clean || "",
    item.description || "",
    item.summary_short || ""
  ];

  const fallback = [];
  const seen = new Set();

  for (const text of candidates) {
    const parts = `${text}`
      .split(/[|:؛،,.!\-–—()]/)
      .map((part) => normalizeKeywordRaw(part))
      .filter(Boolean);

    for (const part of parts) {
      const wordCount = part.split(" ").filter(Boolean).length;

      if (wordCount < 2 || wordCount > 8) continue;
      if (STOP_KEYWORDS.has(part)) continue;
      if (seen.has(part)) continue;

      seen.add(part);
      fallback.push(part);

      if (fallback.length >= 8) {
        return fallback;
      }
    }
  }

  return fallback;
}

function postProcessKeywords(items) {
  const finalItems = [];

  for (const item of items) {
    const cleanKeywords = dedupeRetrievalList(
      (Array.isArray(item.keywords) ? item.keywords : []).filter((kw) => {
        const norm = normalizeKeywordRaw(kw);
        return norm && !STOP_KEYWORDS.has(norm);
      }),
      { max: 6 }
    );

    const cleanKeywordsExtended = dedupeRetrievalList(
      (Array.isArray(item.keywords_extended) ? item.keywords_extended : []).filter((kw) => {
        const norm = normalizeKeywordRaw(kw);
        return norm && !STOP_KEYWORDS.has(norm);
      }),
      { max: 8 }
    );

    const cleanTopicKeywords = dedupeRetrievalList(
      (Array.isArray(item.topic_keywords) ? item.topic_keywords : []).filter((kw) => {
        const norm = normalizeKeywordRaw(kw);
        return norm && !STOP_KEYWORDS.has(norm);
      }),
      { max: 8 }
    );

    item.keywords = cleanKeywords;
    item.keywords_extended =
      cleanKeywordsExtended.length > 0 ? cleanKeywordsExtended : [...cleanKeywords];
    item.topic_keywords =
      cleanTopicKeywords.length > 0 ? cleanTopicKeywords : [...cleanKeywords];

    item.embedding_text = typeof item.embedding_text === "string"
      ? item.embedding_text.trim()
      : "";

    finalItems.push(item);
  }

  console.log(
    `✅ postProcessKeywords: kept ${finalItems.length} / ${items.length} items after conservative cleanup`
  );

  return finalItems;
}

/* ============ نقطة التشغيل الرئيسية ============ */

async function main() {
  console.log("🚀 NovaLink Knowledge Generator V5.2 – Start");
  console.log("SITEMAP_URL:", SITEMAP_URL);
  console.log("OUTPUT_PATH:", OUTPUT_PATH);

  const urls = await getSitemapUrls();

  // نختار فقط الروابط المسموحة
  const filteredUrls = urls.filter(shouldIncludeUrl);
  console.log(
    `✅ Included URLs for knowledge: ${filteredUrls.length} / ${urls.length}`
  );

  const items = [];
  for (const url of filteredUrls) {
    try {
      const item = await buildKnowledgeItem(url);
      items.push(item);
    } catch (err) {
      console.error("❌ Failed to process URL:", url, err);
    }
  }

  // تنظيف وتوحيد الكلمات المفتاحية + حذف التدوينات غير المميزة
  const finalItems = postProcessKeywords(items);

  // كتابة الملف
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify(finalItems, null, 2),
    "utf-8"
  );

  console.log(
    `🎉 knowledge.v5.json generated successfully with ${finalItems.length} items`
  );
}

// تشغيل فقط إذا تم استدعاء الملف مباشرة عبر node
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("🔥 Fatal error in generator:", err);
    process.exit(1);
  });
}
