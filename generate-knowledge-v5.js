// generate-knowledge-v5.js
// NOVALINK Ai – Knowledge Generator V5 (Enterprise Metadata)
// يبني ملف knowledge.v5.json بمستوى Enterprise لاستخدامه مع NovaBrainSystem PRO

import fs from "fs";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* =========================
   الإعدادات الأساسية
   ========================= */

const DOMAIN = "https://novalink-ai.com";
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const OUTPUT_FILE = "./knowledge.v5.json";

// صفحات إضافية نضمن وجودها
const EXTRA_PAGES = [
  { url: DOMAIN + "/", category: "home" },
  { url: DOMAIN + "/services-khdmat-nwfa-lynk", category: "services" }
];

/* =========================
   إعداد Gemini
   ========================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = null;
let geminiModel = null;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({
    model: "gemini-2.0-flash"
  });
} else {
  console.warn(
    "⚠️ لم يتم توفير GEMINI_API_KEY – سيتم توليد الملف بدون تحليلات متقدمة بالذكاء الاصطناعي."
  );
}

/* =========================
   دوال مساعدة عامة
   ========================= */

function normalizeSpace(str = "") {
  return str.replace(/\s+/g, " ").replace(/&nbsp;/g, " ").trim();
}

function cleanText(str = "") {
  return normalizeSpace(str);
}

function titleClean(str = "") {
  return cleanText(str)
    .replace(/\|.*$/g, "")
    .replace(/[\u2013\u2014\-–]+/g, " ")
    .trim();
}

function toLower(str = "") {
  return (str || "").toLowerCase();
}

function slugify(str = "") {
  return toLower(str)
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function nowISO() {
  return new Date().toISOString();
}

async function safeFetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

/* =========================
   تحليل الفئة / النية
   ========================= */

function extractCategory(url) {
  const u = new URL(url);
  const path = u.pathname;

  if (path === "/" || path === "") return "home";
  if (path.includes("services")) return "services";
  if (path.includes("about")) return "about";
  if (path.includes("rhlh-frdyh")) return "story";
  if (path.includes("blog")) return "blog";
  if (path.includes("policy") || path.includes("privacy")) return "legal";
  if (path.includes("terms") || path.includes("shrwt")) return "legal";

  return "general";
}

// subcategory + intent_hint heuristics
function classifyPage(title, url, fullText) {
  const t = toLower(title);
  const u = toLower(url);
  const body = toLower(fullText);

  let category = extractCategory(url);
  let subcategory = "generic";
  let intent_hint = "explore";

  // Home
  if (category === "home") {
    subcategory = "landing";
    intent_hint = "novalink_info";
  }

  // Services
  if (category === "services") {
    subcategory = "ai_services";
    intent_hint = "consulting_purchase";
  }

  // About / Story
  if (category === "about" || category === "story") {
    subcategory = category === "about" ? "about_us" : "founder_story";
    intent_hint = "novalink_info";
  }

  // Blog: نحاول تحديد نوع المحتوى
  if (category === "blog" || category === "general") {
    if (
      t.includes("copy.ai") ||
      t.includes("copyai") ||
      body.includes("كوبي") ||
      body.includes("كتابة المحتوى") ||
      body.includes("المحتوى العربي")
    ) {
      subcategory = "ai_copywriting";
      intent_hint = "ai_business";
    } else if (
      body.includes("تعليق صوتي") ||
      body.includes("voice") ||
      body.includes("murf.ai") ||
      body.includes("elevenlabs") ||
      body.includes("daryjat")
    ) {
      subcategory = "ai_voiceover";
      intent_hint = "ai_business";
    } else if (
      body.includes("وظيفة") ||
      body.includes("المستقبل") ||
      body.includes("المهن") ||
      body.includes("سوق العمل")
    ) {
      subcategory = "ai_jobs_future";
      intent_hint = "ai_business";
    } else if (
      body.includes("تطوّر الذكاء الاصطناعي") ||
      body.includes("الموظف الجديد الذي لا ينام")
    ) {
      subcategory = "ai_evolution";
      intent_hint = "ai_business";
    } else if (body.includes("نشرة") || body.includes("اشترك") || u.includes("ashtrk")) {
      subcategory = "newsletter_landing";
      intent_hint = "subscribe_interest";
      category = "general";
    } else {
      subcategory = "ai_business_general";
      intent_hint = "ai_business";
    }
  }

  // Legal
  if (category === "legal") {
    subcategory = "legal_policy";
    intent_hint = "novalink_info";
  }

  return { category, subcategory, intent_hint };
}

/* =========================
   الكلمات المفتاحية
   ========================= */

function basicKeywordsFromText(text = "") {
  return text
    .split(/\s+/)
    .map((w) => cleanText(w).toLowerCase())
    .filter((w) => w.length >= 3 && !/^[0-9]+$/.test(w));
}

function extractKeywords(title, desc, category, subcategory) {
  const base = basicKeywordsFromText(title + " " + desc).slice(0, 40);

  const enrichedBase = [
    ...base,
    category,
    subcategory,
    "novalink",
    "novalink ai",
    "نوفا لينك",
    "الذكاء الاصطناعي",
    "الذكاء الاصطناعي للأعمال",
    "ai",
    "ai tools",
    "ai business"
  ];

  // إزالة التكرار
  const unique = Array.from(new Set(enrichedBase));

  return unique;
}

function extendKeywords(keywords, title, fullText) {
  const extra = [];

  const t = toLower(title + " " + fullText);

  // Voiceover
  if (
    t.includes("تعليق صوتي") ||
    t.includes("voice over") ||
    t.includes("voiceover") ||
    t.includes("murf") ||
    t.includes("elevenlabs") ||
    t.includes("daryjat")
  ) {
    extra.push(
      "تعليق صوتي",
      "voice over",
      "ai voiceover",
      "murf.ai",
      "elevenlabs",
      "daryjat"
    );
  }

  // Copywriting
  if (t.includes("copy.ai") || t.includes("copyai") || t.includes("كتابة المحتوى")) {
    extra.push(
      "copy.ai",
      "copy ai",
      "كتابة المحتوى",
      "ai copywriting",
      "المحتوى العربي",
      "ai content"
    );
  }

  // Jobs & future
  if (t.includes("وظيف") || t.includes("المستقبل") || t.includes("المهن")) {
    extra.push("وظائف الذكاء الاصطناعي", "المهن المستقبلية", "سوق العمل", "ai jobs");
  }

  // Newsletter / subscribe
  if (t.includes("اشترك") || t.includes("نشرة") || t.includes("newsletter")) {
    extra.push("نشرة بريدية", "newsletter", "اشترك الآن", "اشتراك نوفا لينك");
  }

  // خدمات / بوت
  if (t.includes("خدماتنا") || t.includes("بوت دردشة") || t.includes("خدمة")) {
    extra.push("خدمات نوفا لينك", "استشارة", "بوت دردشة", "ai chatbot");
  }

  const all = [...keywords, ...extra];
  return Array.from(new Set(all));
}

/* =========================
   استدعاء Gemini لتحليل متقدم
   ========================= */

async function analyzeWithGemini(title, url, fullText, fallbackSummary) {
  if (!geminiModel) {
    // Fallback بدون استخدام Gemini
    const longSummary = fallbackSummary || fullText.slice(0, 220);
    const shortSummary = (longSummary || "").split(/[.!؟]/)[0].trim();
    return {
      summary_short: shortSummary,
      summary_long: longSummary,
      facts: [],
      topic_keywords: [],
      intent_hint: null
    };
  }

  try {
    const maxLen = 7000;
    const snippet = fullText.length > maxLen ? fullText.slice(0, maxLen) : fullText;

    const prompt = `
أنت مساعد ذكاء اصطناعي يساعد منصة عربية اسمها "نوفا لينك" في بناء قاعدة معرفة متقدمة عن الذكاء الاصطناعي للأعمال.

أريد منك أن تحلل الصفحة التالية وتعيد **حصريًا** JSON بالهيكل التالي (وباللغة العربية في الحقول النصية):

{
  "summary_short": "جملة واحدة تلخص الفائدة الأساسية للقارئ (رائد أعمال أو موظف أو صاحب مشروع).",
  "summary_long": "ملخص من 2 إلى 4 جمل يشرح مضمون الصفحة وفائدتها العملية.",
  "facts": [
    "نقطة أساسية مختصرة (لا تتجاوز 20 كلمة).",
    "نقطة أساسية ثانية...",
    "يمكنك إضافة 3 إلى 5 نقاط كحد أقصى."
  ],
  "topic_keywords": [
    "كلمات أو عبارات قصيرة تمثل الموضوعات الأساسية (ذكاء اصطناعي للأعمال، تعليق صوتي، كتابة محتوى... إلخ)."
  ],
  "intent_hint": "ai_business أو novalink_info أو consulting_purchase أو subscribe_interest أو explore (اختر الأنسب)."
}

قواعد مهمة:
- أعد JSON فقط بدون أي نص خارجي.
- لا تستخدم تعليقات أو أسطر خارج JSON.
- اجعل جميع الحقول النصية بالعربية الفصحى المبسطة.
- لا تضف أو تحذف أي حقل من الحقول المطلوبة.

عنوان الصفحة:
${title}

الرابط:
${url}

محتوى الصفحة (مقتطف):
${snippet}
    `.trim();

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const raw = (response.text() || "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("⚠️ تعذر تحليل JSON من Gemini – سيتم استخدام fallback بسيط.");
      const longSummary = fallbackSummary || fullText.slice(0, 220);
      const shortSummary = (longSummary || "").split(/[.!؟]/)[0].trim();
      return {
        summary_short: shortSummary,
        summary_long: longSummary,
        facts: [],
        topic_keywords: [],
        intent_hint: null
      };
    }

    // تطهير الحقول الأساسية
    const summary_long =
      cleanText(parsed.summary_long || parsed.summary_short || fallbackSummary || "");
    const summary_short =
      cleanText(parsed.summary_short || summary_long.split(/[.!؟]/)[0] || "");

    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.map((f) => cleanText(f)).filter((f) => f.length > 0)
      : [];

    const topic_keywords = Array.isArray(parsed.topic_keywords)
      ? parsed.topic_keywords.map((k) => cleanText(k)).filter((k) => k.length > 0)
      : [];

    const intent_hint = parsed.intent_hint || null;

    return {
      summary_short,
      summary_long,
      facts,
      topic_keywords,
      intent_hint
    };
  } catch (e) {
    console.warn("⚠️ فشل استدعاء Gemini للتحليل المتقدم:", e.message);
    const longSummary = fallbackSummary || fullText.slice(0, 220);
    const shortSummary = (longSummary || "").split(/[.!؟]/)[0].trim();
    return {
      summary_short: shortSummary,
      summary_long: longSummary,
      facts: [],
      topic_keywords: [],
      intent_hint: null
    };
  }
}

/* =========================
   قراءة الـ Sitemap
   ========================= */

async function loadSitemap() {
  const xml = await safeFetchText(SITEMAP_URL);
  const matches = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g));
  return matches.map((m) => m[1]);
}

/* =========================
   استخراج بيانات صفحة واحدة
   ========================= */

async function scrapePage(url, forcedCategory = null) {
  try {
    const html = await safeFetchText(url);
    const $ = cheerio.load(html);

    // العنوان
    const rawTitle =
      $('meta[property="og:title"]').attr("content") ||
      $("title").text() ||
      $("h1").first().text();
    const title = cleanText(rawTitle);

    if (!title || title.length < 5) {
      console.warn("⚠️ تجاهل صفحة بدون عنوان مناسب:", url);
      return null;
    }

    // الوصف
    let desc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    desc = cleanText(desc);

    // المحتوى الأساسي للملخص / التحليل
    let mainText =
      $("main").text() ||
      $("article").text() ||
      $('section[role="main"]').text() ||
      $("body").text();
    const fullText = cleanText(mainText || "");

    // مقتطف (excerpt)
    let excerpt = "";
    $("main p, main h2, main h3, article p, article li").each((_, el) => {
      if (!excerpt) {
        const t = cleanText($(el).text());
        if (t.length >= 60) excerpt = t;
      }
    });

    if (!excerpt && fullText) {
      excerpt = fullText.substring(0, 260);
    }

    const { category, subcategory, intent_hint: intentFromHeuristic } = classifyPage(
      title,
      url,
      fullText
    );

    const finalCategory = forcedCategory || category;

    const baseKeywords = extractKeywords(title, desc || excerpt || fullText, finalCategory, subcategory);
    const extendedKeywords = extendKeywords(baseKeywords, title, fullText);

    // تحليلات Gemini المتقدمة
    const aiAnalysis = await analyzeWithGemini(
      title,
      url,
      fullText,
      excerpt || desc || fullText.slice(0, 260)
    );

    // intent_hint النهائي: نأخذ من Gemini إن وجد، وإلا من heuristic
    const intent_hint = aiAnalysis.intent_hint || intentFromHeuristic || "explore";

    const summary_long =
      aiAnalysis.summary_long ||
      aiAnalysis.summary_short ||
      desc ||
      excerpt ||
      fullText.slice(0, 260);

    const summary_short =
      aiAnalysis.summary_short ||
      summary_long.split(/[.!؟]/)[0].trim() ||
      desc ||
      excerpt;

    const topic_keywords = Array.from(
      new Set([...(aiAnalysis.topic_keywords || []), ...extendedKeywords.slice(0, 20)])
    );

    // embedding_text: نص مركّز لاستخدامه في NovaBrain
    const embedding_text = cleanText(
      [
        title,
        summary_long,
        desc,
        excerpt,
        topic_keywords.slice(0, 10).join(" ")
      ]
        .filter(Boolean)
        .join(" | ")
    ).slice(0, 1200);

    // أوزان مبدئية – يمكن تعديلها لاحقًا في NovaBrain
    const weight_title = 1.0;
    const weight_summary = 0.9;
    const weight_keywords = 0.8;
    const weight_semantic = 1.0;
    const weight_final = 1.0;

    const item = {
      // معلومات أساسية
      title,
      title_clean: titleClean(title),
      url,
      domain: DOMAIN,
      // تصنيفات
      category: finalCategory,
      subcategory,
      intent_hint,
      // وصف ومقتطفات
      description: desc || summary_long || excerpt,
      excerpt,
      summary: summary_long, // توافقًا مع الإصدارات السابقة
      summary_short,
      summary_long,
      facts: aiAnalysis.facts || [],
      // كلمات مفتاحية
      keywords: baseKeywords,
      keywords_extended: extendedKeywords,
      topic_keywords,
      // نص مخصص للـ Embeddings
      embedding_text,
      // أوزان مبدئية
      weight_title,
      weight_summary,
      weight_keywords,
      weight_semantic,
      weight_final,
      // ميتاداتا
      updated_at: nowISO(),
      source: "sitemap+scraper+gemini-v5"
      // ملاحظة: لم نخزّن embedding_vector هنا، NovaBrain سيولدها ديناميكيًا في الذاكرة
    };

    return item;
  } catch (e) {
    console.error("❌ خطأ أثناء قراءة الصفحة:", url, e.message);
    return null;
  }
}

/* =========================
   بناء المعرفة كاملة
   ========================= */

async function build() {
  console.log("🚀 بدء توليد knowledge.v5.json ...");

  const urls = await loadSitemap();

  // إضافة الصفحات الإضافية
  EXTRA_PAGES.forEach((p) => {
    if (!urls.includes(p.url)) urls.push(p.url);
  });

  const items = [];

  for (const url of urls) {
    console.log("🔍 معالجة:", url);
    const forcedCategory = EXTRA_PAGES.find((p) => p.url === url)?.category || null;
    const item = await scrapePage(url, forcedCategory);
    if (item) items.push(item);
  }

  // ترتيب بالعربية/الإنجليزية
  items.sort((a, b) => a.title.localeCompare(b.title, "ar"));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), "utf8");

  console.log("✅ تم إنشاء الملف:", OUTPUT_FILE);
  console.log("📦 إجمالي العناصر:", items.length);
}

build().catch((err) => {
  console.error("❌ فشل التوليد:", err);
  process.exit(1);
});
