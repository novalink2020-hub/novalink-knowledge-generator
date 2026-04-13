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
  process.env.GOOGLE_API_KEY || process.env.NOVALINK_GEMINI_KEY || "";

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
أنت مهندس Retrieval Layer لمشروع NovaLink.
مهمتك ليست كتابة محتوى، ولا تلخيص المقال بأسلوب تحريري، ولا تحسين SEO.

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
- الهدف هو تحسين الاسترجاع وربط سؤال المستخدم بهذه الصفحة لاحقًا.
- لا تؤلف معلومات غير موجودة ضمن المعطيات.
- استخرج entities حقيقية مرتبطة بالموضوع أو الأداة أو المفهوم أو الجهة أو بيئة العمل المذكورة.
- aliases يجب أن تشمل الصيغ العربية والإنجليزية والبدائل الشائعة عند الحاجة.
- misspellings يجب أن تكون قليلة ومدروسة وواقعية فقط، وليست عشوائية.
- faq_queries_human يجب أن تكون طبيعية جدًا، شبيهة بما يكتبه المستخدم في البحث أو الدردشة.
- answer_scope يجب أن يصف باختصار: ما الذي تجيب عنه هذه الصفحة تحديدًا، وما حدودها.
- لا تذكر NovaLink ككيان استرجاعي إلا إذا كان جزءًا فعليًا من موضوع الصفحة.
- لا تكرر نفس العنصر بصيغ متعددة بلا داع.
- اجعل الناتج عمليًا ومضغوطًا.
- جميع القوائم يجب أن تكون صالحة للاسترجاع، لا للزينة.

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

  // أي شيء آخر نعدّه تدوينة / محتوى معرفي عام
  return {
    category: "blog",
    subcategory: "ai_business_article",
    intent_hint: "ai_business"
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

  // كلمات مفتاحية أولية من Retrieval Layer إن وُجدت، وإلا fallback من العنوان/الوصف
  let initialKeywords = [];
  if (llmRetrieval?.entities?.length) {
    initialKeywords = llmRetrieval.entities;
  } else if (llmRetrieval?.aliases?.length) {
    initialKeywords = llmRetrieval.aliases;
  } else {
    const base = `${title_clean} ${description}`.split(/[،,.]/);
    initialKeywords = base
      .map((p) => p.trim())
      .filter((p) => p.split(" ").length <= 6 && p.length > 2);
  }

  // topic_keywords مبدئياً نسخة من initialKeywords (سيتم تنظيفها لاحقاً)
  const topic_keywords = [...initialKeywords];

  // embedding_text: نجمع أكثر شيء يفيد في الـ semantic
  const embedding_text = [
    title_clean,
    summary_short,
    description,
    topic_keywords.slice(0, 10).join(" "),
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
    keywords: initialKeywords,
    keywords_extended: initialKeywords,
    topic_keywords,
    embedding_text,
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
  // 1) تطبيع الكلمات لكل عنصر + بناء عدّاد عالمي
  const normalizedKeywordsPerItem = [];
  const globalCounts = new Map();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rawList = Array.isArray(item.keywords) ? item.keywords : [];

    const normSet = new Set();

    for (const kwRaw of rawList) {
      const norm = normalizeKeywordRaw(kwRaw);
      if (!norm) continue;
      if (STOP_KEYWORDS.has(norm)) continue;
      normSet.add(norm);
    }

    const normList = Array.from(normSet);
    normalizedKeywordsPerItem[i] = normList;

    for (const kw of normList) {
      globalCounts.set(kw, (globalCounts.get(kw) || 0) + 1);
    }
  }

  const finalItems = [];

  // 2) تطبيق منطق "التميّز" خاصة للتدوينات
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let normList = normalizedKeywordsPerItem[i] || [];

if (item.category === "blog") {
  // نحتفظ أولاً بالكلمات الفريدة فعلاً
  const uniqueKeywords = normList.filter(
    (kw) => (globalCounts.get(kw) || 0) === 1
  );

  if (uniqueKeywords.length > 0) {
    normList = uniqueKeywords;
  } else {
    // fallback: لا نحذف التدوينة، بل نولد كلمات داعمة من العنوان/الوصف/الملخص القصير
    const fallbackKeywords = extractFallbackKeywords(item);

    if (fallbackKeywords.length > 0) {
      normList = fallbackKeywords;
      console.warn(
        "⚠️ Blog item kept with fallback keywords instead of unique-only:",
        item.url
      );
    } else {
      // آخر خط دفاع: احتفظ بالتدوينة بعنوانها المنظف بدل حذفها
      const safeTitle = normalizeKeywordRaw(item.title_clean || "");

      normList = safeTitle && !STOP_KEYWORDS.has(safeTitle)
        ? [safeTitle]
        : [];

      console.warn(
        "⚠️ Blog item kept with minimal title fallback:",
        item.url
      );
    }
  }
}

item.keywords = normList;
item.keywords_extended = [...normList];
item.topic_keywords = normList.slice(0, 8);

// إعادة بناء embedding_text بعد التنظيف النهائي للكلمات
item.embedding_text = [
  item.title_clean,
  item.summary_short,
  item.description,
  item.topic_keywords.join(" "),
  item.url
]
  .filter(Boolean)
  .join(" | ");

    finalItems.push(item);
  }

  console.log(
    `✅ postProcessKeywords: kept ${finalItems.length} / ${items.length} items after uniqueness filtering`
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
