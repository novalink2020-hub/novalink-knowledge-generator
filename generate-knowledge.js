// generate-knowledge.js
// NOVALINK – Knowledge JSON V2 Generator

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// ================= الإعدادات الأساسية =================

const DOMAIN = "https://novalink-ai.com";
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;

// صفحات إضافية نضمن وجودها حتى لو السايت ماب مش مثالية
const EXTRA_PAGES = [
  { url: `${DOMAIN}/`, category: "home" },
  { url: `${DOMAIN}/services-khdmat-nwfa-lynk`, category: "services" }
];

const OUTPUT_FILE = "knowledge.v2.json";

// =============== دوال مساعدة للنصوص ===============

function cleanText(str = "") {
  return str.replace(/\s+/g, " ").replace(/(&nbsp;)/g, " ").trim();
}

function extractCategory(url) {
  const u = new URL(url);
  const path = u.pathname;

  if (path === "/" || path === "") return "home";
  if (path.includes("services")) return "services";
  if (path.includes("about")) return "about";
  if (path.includes("rhlh-frdyh")) return "story";
  if (path.includes("/blog") || path.match(/\/\d{4}\/\d{2}\//)) return "blog";
  if (path.includes("policy") || path.includes("privacy")) return "legal";
  if (path.includes("terms")) return "legal";

  return "general";
}

function extractKeywordsFromText(text = "") {
  return cleanText(text)
    .split(" ")
    .filter((w) => w.length >= 3)
    .slice(0, 12);
}

function mergeKeywords(...lists) {
  const set = new Set();
  lists.flat().forEach((k) => {
    const val = cleanText(k).toLowerCase();
    if (val && val.length >= 3) set.add(val);
  });
  return Array.from(set);
}

// =============== استخراج البيانات من صفحة واحدة ===============

async function scrapePage(url, forcedCategory = null) {
  try {
    const res = await axios.get(url, { timeout: 20000 });
    const html = res.data;
    const $ = cheerio.load(html);

    // ----- title -----
    const rawTitle =
      $('meta[property="og:title"]').attr("content") ||
      $("title").first().text() ||
      $("h1").first().text();

    const title = cleanText(rawTitle);

    // تجاهل أي صفحة بدون عنوان حقيقي
    if (!title || title.length < 5) {
      console.warn("⚠️ تجاهل صفحة بدون عنوان واضح:", url);
      return null;
    }

    // ----- description -----
    let desc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";

    desc = cleanText(desc);

    // ----- excerpt من أول فقرة حقيقية -----
    let excerpt = "";
    $("p, .elementor-widget-text-editor, .post-content, .entry-content").each(
      (_, el) => {
        if (excerpt) return;
        const txt = cleanText($(el).text() || "");
        if (txt.length >= 60) {
          excerpt = txt;
        }
      }
    );

    if (!excerpt) {
      const mainText =
        cleanText($("main").text() || "") ||
        cleanText($("#content").text() || "") ||
        cleanText($("body").text() || "");
      excerpt = mainText.substring(0, 220);
    }

    // ----- category -----
    const category = forcedCategory || extractCategory(url);

    // ----- keywords -----
    let metaKeywords =
      $('meta[name="keywords"]').attr("content") || "";
    const metaList = metaKeywords
      ? metaKeywords.split(",").map((k) => cleanText(k))
      : [];

    const autoFromTitle = extractKeywordsFromText(title);
    const autoFromDesc = extractKeywordsFromText(desc || excerpt);
    const categoryTags = [category];

    const keywords = mergeKeywords(
      metaList,
      autoFromTitle,
      autoFromDesc,
      categoryTags
    );

    return {
      title,
      url,
      description: desc || excerpt, // لو الـ meta فاضية نستخدم الـ excerpt
      excerpt,
      category,
      keywords
    };
  } catch (e) {
    console.error("❌ خطأ أثناء قراءة الصفحة:", url, e.message);
    return null;
  }
}

// =============== قراءة السايت ماب ===============

async function loadSitemapUrls() {
  const res = await axios.get(SITEMAP_URL, { timeout: 20000 });
  const xml = res.data;

  const urls = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g)).map((m) => m[1]);

  // إزالة التكرار
  return Array.from(new Set(urls));
}

// =============== تجميع البيانات كاملة ===============

function categoryWeight(cat) {
  switch (cat) {
    case "home":
      return 0;
    case "about":
    case "story":
    case "services":
      return 1;
    case "blog":
      return 2;
    case "general":
      return 3;
    case "legal":
      return 4;
    default:
      return 5;
  }
}

async function buildKnowledge() {
  console.log("🚀 بدء توليد knowledge.v2.json ...");

  const urls = await loadSitemapUrls();

  // نضمن إضافة EXTRA_PAGES حتى لو مش موجودة في السايت ماب
  EXTRA_PAGES.forEach((p) => {
    if (!urls.includes(p.url)) urls.push(p.url);
  });

  console.log("🔍 عدد الصفحات (سايت ماب + إضافية):", urls.length);

  const items = [];

  for (const url of urls) {
    const custom = EXTRA_PAGES.find((p) => p.url === url);
    const forcedCategory = custom?.category || null;

    const item = await scrapePage(url, forcedCategory);
    if (item) items.push(item);
  }

  // ترتيب العناصر
  items.sort((a, b) => {
    const wa = categoryWeight(a.category);
    const wb = categoryWeight(b.category);
    if (wa !== wb) return wa - wb;
    return a.title.localeCompare(b.title, "ar");
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), "utf8");

  console.log("✅ تم إنشاء الملف:", OUTPUT_FILE);
  console.log("📦 إجمالي العناصر:", items.length);
}

// تشغيل مباشر
buildKnowledge().catch((err) => {
  console.error("❌ فشل التوليد:", err);
  process.exit(1);
});
