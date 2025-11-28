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

async function callGeminiForPage({ title, text }) {
  if (!GOOGLE_API_KEY) {
    return null; // لا يوجد مفتاح → نعتمد على التلخيص اليدوي
  }

  const prompt = `
أنت مساعد لتحليل صفحة من موقع نوفا لينك حول الذكاء الاصطناعي للأعمال.

أعد لي JSON فقط بالشكل التالي بدون أي نص خارجه:
{
  "summary": "ملخص فقرة واحدة بالعربية عن محتوى الصفحة (3-4 جمل).",
  "summary_short": "ملخص قصير جداً (سطر واحد).",
  "keywords": ["كلمة مفتاحية 1", "عبارة متخصصة 2", "..."]
}

الشروط:
- لا تستخدم تعبيرات عامة جداً مثل: "الذكاء الاصطناعي" وحدها أو "AI" وحدها.
- ركّز على الكلمات والعبارات التي تميز هذه الصفحة عن بقية الصفحات.
- لا تضع تشكيل على الكلمات العربية.
- لا تذكر "نوفا لينك" أو "NOVALINK Ai" ضمن الكلمات المفتاحية.
- اجعل عدد الكلمات المفتاحية بين 8 و 15 كلمة/عبارة.

العنوان:
${title}

محتوى مختصر للصفحة:
${text.slice(0, 1800)}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 512
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

    const jsonString = textPart.slice(start, end + 1);
    const parsed = JSON.parse(jsonString);

    const summary = (parsed.summary || "").trim();
    const summary_short = (parsed.summary_short || "").trim();
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => `${k}`.trim()).filter(Boolean)
      : [];

    return { summary, summary_short, keywords };
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

  // إزالة العناصر المزعجة قبل استخراج النص
  $("script, style, nav, footer, header, noscript").remove();
  $(".site-header, .site-footer, .menu, .breadcrumbs, .footer, .header, .nav, .sidebar").remove();

  let mainText = "";

  const mainEl = $("main");
  if (mainEl.length) {
    mainText = mainEl.text();
  } else if ($("article").length) {
    mainText = $("article").text();
  } else {
    mainText = $("body").text();
  }

  mainText = mainText.replace(/\u00a0/g, " ");

  // إزالة النصوص المكررة المزعجة (مثل شريط القائمة)
  for (const re of NAV_TRASH_PATTERNS) {
    mainText = mainText.replace(re, " ");
  }

  mainText = mainText.replace(MULTISPACE_RE, " ").trim();

  const excerpt = mainText.slice(0, 260);

  const descriptionRaw =
    metaDesc || (excerpt.length ? excerpt : mainText.slice(0, 260));

  const description = descriptionRaw.slice(0, 400).trim();

  return {
    title,
    description,
    excerpt,
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

  // استدعاء Gemini لاشتقاق ملخص وكلمات مفتاحية (إن أمكن)
  let llmSummary = null;
  if (GOOGLE_API_KEY) {
    llmSummary = await callGeminiForPage({
      title,
      text: rawText || description || excerpt
    });
  }

  const summary =
    llmSummary?.summary?.trim() ||
    description ||
    excerpt ||
    rawText.slice(0, 260);

  const summary_short =
    llmSummary?.summary_short?.trim() ||
    summary.slice(0, 140);

  const summary_long = summary;

  // كلمات مفتاحية أولية من Gemini إن وُجدت، وإلا من العنوان + الوصف
  let initialKeywords = [];
  if (llmSummary?.keywords?.length) {
    initialKeywords = llmSummary.keywords;
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
      // نحتفظ فقط بالكلمات التي تظهر في تدوينة واحدة (unique)
      normList = normList.filter((kw) => (globalCounts.get(kw) || 0) === 1);

      if (normList.length === 0) {
        console.warn("⚠️ Dropping blog item with no unique keywords:", item.url);
        continue; // حذف التدوينة بالكامل
      }
    }

    item.keywords = normList;
    item.keywords_extended = [...normList];
    item.topic_keywords = normList.slice(0, 8);

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
