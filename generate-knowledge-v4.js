// generate-knowledge-v4.js
// NOVALINK Ai – Knowledge Generator V4 (Gemini Summaries)

import fs from "fs";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

// =========================
// الإعدادات الأساسية
// =========================

const DOMAIN = "https://novalink-ai.com";
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const OUTPUT_FILE = "./knowledge.v4.json";

// صفحات إضافية نضمن وجودها
const EXTRA_PAGES = [
  { url: DOMAIN + "/", category: "home" },
  { url: DOMAIN + "/services-khdmat-nwfa-lynk", category: "services" }
];

// =========================
// إعداد Gemini
// =========================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = null;
let geminiModel = null;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({
    model: "gemini-2.0-flash"
  });
} else {
  console.warn("⚠️ لم يتم توفير GEMINI_API_KEY – سيتم توليد الملف بدون summaries بالذكاء الاصطناعي.");
}

// =========================
// دوال مساعدة
// =========================

function cleanText(str = "") {
  return str.replace(/\s+/g, " ").replace(/&nbsp;/g, " ").trim();
}

function extractCategory(url) {
  const u = new URL(url);
  const path = u.pathname;

  if (path === "/" || path === "") return "home";
  if (path.includes("services")) return "services";
  if (path.includes("about")) return "about";
  if (path.includes("rhlh-frdyh")) return "story";
  if (path.includes("blog")) return "blog";
  if (path.includes("policy") || path.includes("privacy")) return "legal";
  if (path.includes("terms")) return "legal";

  return "general";
}

function extractKeywords(title, desc, category) {
  const base = (title + " " + desc)
    .split(" ")
    .map(w => cleanText(w).toLowerCase())
    .filter(w => w.length >= 3)
    .slice(0, 40);

  const enriched = [
    ...base,
    category,
    "novalink",
    "الذكاء الاصطناعي",
    "ai"
  ];

  return Array.from(new Set(enriched));
}

async function loadSitemap() {
  const xml = await fetch(SITEMAP_URL).then(r => r.text());
  return Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g)).map(m => m[1]);
}

// توليد ملخّص باستخدام Gemini
async function summarizeWithGemini(title, url, fullText, fallback) {
  if (!geminiModel) {
    return fallback || "";
  }

  try {
    const maxLen = 8000;
    const snippet = fullText.length > maxLen ? fullText.slice(0, maxLen) : fullText;

    const prompt = `
أنت مساعد ذكاء اصطناعي يساعد في توليد ملخّصات للمحتوى داخل منصة عربية متخصصة في أدوات الذكاء الاصطناعي للأعمال اسمها "نوفا لينك".

المطلوب:
- أن تكتب ملخصًا قصيرًا وواضحًا باللغة العربية الفصحى.
- يتكون من 2 إلى 3 جمل فقط.
- يركّز على الفائدة العملية للقارئ (رائد أعمال، موظف، صاحب مشروع).
- بدون تنسيقات خاصة، بدون إيموجي، بدون تعداد نقطي.

عنوان الصفحة:
${title}

عنوان الرابط:
${url}

محتوى الصفحة:
${snippet}
    `.trim();

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = cleanText(response.text() || "");

    if (!text || text.length < 20) {
      return fallback || "";
    }

    return text;
  } catch (e) {
    console.warn("⚠️ فشل توليد summary بواسطة Gemini للصفحة:", url, e.message);
    return fallback || "";
  }
}

// =========================
// استخراج بيانات صفحة واحدة
// =========================

async function scrapePage(url, forcedCategory = null) {
  try {
    const html = await fetch(url).then(r => r.text());
    const $ = cheerio.load(html);

    const rawTitle =
      $('meta[property="og:title"]').attr("content") ||
      $("title").text() ||
      $("h1").first().text();
    const title = cleanText(rawTitle);

    if (!title || title.length < 5) {
      console.warn("⚠️ تجاهل صفحة بدون عنوان مناسب:", url);
      return null;
    }

    let desc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    desc = cleanText(desc);

    // Full text للملخّص
    const fullText =
      cleanText($("main").text() || "") ||
      cleanText($("body").text() || "");

    // Excerpt من أول فقرة حقيقية
    let excerpt = "";
    $("p, h2, h3, li").each((_, el) => {
      if (!excerpt) {
        const t = cleanText($(el).text());
        if (t.length >= 50) excerpt = t;
      }
    });

    if (!excerpt && fullText) {
      excerpt = fullText.substring(0, 220);
    }

    const category = forcedCategory || extractCategory(url);
    const keywords = extractKeywords(title, desc || excerpt, category);

    // ملخّص بالذكاء الاصطناعي (أو fallback للاقتباس)
    const summary = await summarizeWithGemini(
      title,
      url,
      fullText,
      excerpt || desc
    );

    return {
      title,
      url,
      description: desc || summary || excerpt,
      excerpt,
      summary,
      category,
      keywords
    };
  } catch (e) {
    console.error("❌ خطأ أثناء قراءة الصفحة:", url, e.message);
    return null;
  }
}

// =========================
// بناء المعرفة كاملة
// =========================

async function build() {
  console.log("🚀 بدء توليد knowledge.v4.json ...");

  const urls = await loadSitemap();

  EXTRA_PAGES.forEach(p => {
    if (!urls.includes(p.url)) urls.push(p.url);
  });

  const items = [];

  for (const url of urls) {
    const forcedCategory = EXTRA_PAGES.find(p => p.url === url)?.category || null;
    const item = await scrapePage(url, forcedCategory);
    if (item) items.push(item);
  }

  items.sort((a, b) => a.title.localeCompare(b.title, "ar"));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), "utf8");

  console.log("✅ تم إنشاء الملف:", OUTPUT_FILE);
  console.log("📦 إجمالي العناصر:", items.length);
}

build().catch(err => {
  console.error("❌ فشل التوليد:", err);
  process.exit(1);
});
