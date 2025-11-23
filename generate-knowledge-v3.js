// generate-knowledge-v3.js
// NOVALINK Knowledge Generator – V3 (with Gemini Summaries + Fallback)

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const DOMAIN = "https://novalink-ai.com";
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const OUTPUT_FILE_V3 = "knowledge.v3.json";

const EXTRA_PAGES = [
  { url: `${DOMAIN}/`, category: "home" },
  { url: `${DOMAIN}/services-khdmat-nwfa-lynk`, category: "services" }
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.0-flash";

function canonical(url = "") {
  if (!url) return url;
  return url.endsWith("/") ? url : url + "/";
}

function clean(str = "") {
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMenu(str) {
  const menuWords = [
    "الرئيسية",
    "المدونات",
    "خدماتنا",
    "من نحن",
    "إشترك الآن",
    "جميع الحقوق محفوظة",
    "Privacy Policy",
    "Terms of Service"
  ];
  return menuWords.some((w) => str.includes(w));
}

function classify(url) {
  if (url.includes("/blog")) return "blog";
  if (url.includes("/-")) return "blog";
  if (url.includes("policy") || url.includes("khswsyh")) return "legal";
  if (url.includes("terms") || url.includes("shrwt")) return "legal";
  if (url.includes("services")) return "services";
  if (url.includes("about")) return "about";
  if (url.includes("rhlh")) return "story";
  if (url === DOMAIN + "/" || url === DOMAIN) return "home";
  return "general";
}

const STOP = new Set([
  "من","على","في","عن","إلى","الى","هو","هي","هذا","هذه","ذلك",
  "ما","لم","لن","قد","لا","هناك","كما","أو","او","ثم","أي","أيضًا","ايضا"
]);

function buildKeywords(text = "", category = "") {
  const words = clean(text).split(" ");
  const set = new Set();

  for (let w of words) {
    const k = w.replace(/[^ء-يA-Za-z0-9]/g, "").toLowerCase();
    if (!k) continue;
    if (k.length < 3) continue;
    if (STOP.has(k)) continue;
    set.add(k);
  }

  if (category) set.add(category);
  return Array.from(set);
}

async function extractBaseItem(url, forcedCat = null) {
  try {
    const res = await axios.get(url, { timeout: 20000 });
    const html = res.data;
    const $ = cheerio.load(html);

    const title =
      clean($('meta[property="og:title"]').attr("content")) ||
      clean($("title").first().text()) ||
      clean($("h1").first().text());

    if (!title || title.length < 5) {
      console.warn("⚠️ تجاهل صفحة بدون عنوان واضح:", url);
      return null;
    }

    let desc =
      clean($('meta[name="description"]').attr("content")) ||
      clean($('meta[property="og:description"]').attr("content")) ||
      "";

    let excerpt = "";
    $("p, h2, h3, li, .elementor-widget-container").each((i, el) => {
      if (excerpt) return;
      const t = clean($(el).text());
      if (t.length < 60) return;
      if (isMenu(t)) return;
      excerpt = t;
    });

    if (!excerpt) {
      const body = clean($("main").text() || $("body").text());
      excerpt = body.substring(0, 220);
    }

    const category = forcedCat || classify(url);
    const kw = buildKeywords(title + " " + desc + " " + excerpt, category);

    return {
      title,
      url: canonical(url),
      description: desc || excerpt,
      excerpt,
      category,
      keywords: kw
    };
  } catch (err) {
    console.error("❌ خطأ في الصفحة:", url, err.message);
    return null;
  }
}

async function loadUrls() {
  const res = await axios.get(SITEMAP_URL, { timeout: 20000 });
  const xml = res.data;
  const urls = Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g)).map((m) =>
    canonical(m[1])
  );

  EXTRA_PAGES.forEach((e) => urls.push(canonical(e.url)));

  return Array.from(new Set(urls));
}

function weight(cat) {
  switch (cat) {
    case "home": return 0;
    case "about":
    case "story":
    case "services": return 1;
    case "blog": return 2;
    case "general": return 3;
    case "legal": return 4;
    default: return 5;
  }
}

// ===== Gemini Summarizer =====

async function summarizeWithGemini(item) {
  if (!GEMINI_API_KEY) {
    console.warn("⚠️ لا يوجد GEMINI_API_KEY في بيئة GitHub Actions – سيتم استخدام excerpt فقط.");
    return null;
  }

  try {
    const baseText = `${item.title}\n\n${item.description}\n\n${item.excerpt}`.slice(0, 6000);

    const prompt =
      "قم بتلخيص النص التالي في فقرة عربية واضحة من 3 إلى 5 جمل،" +
      " بدون تعداد نقطي، وبدون تنسيق، وبأسلوب يناسب مدونة نوفا لينك التي تشرح أدوات وفوائد الذكاء الاصطناعي للأعمال.\n\n" +
      baseText;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ]
    };

    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000
    });

    const candidates = res.data.candidates || [];
    const first = candidates[0];
    if (!first || !first.content || !first.content.parts) return null;

    const part = first.content.parts.find((p) => p.text);
    const summaryRaw = part?.text || "";
    const summary = summaryRaw.replace(/\s+/g, " ").trim();

    if (!summary || summary.length < 40) return null;

    return summary;
  } catch (err) {
    console.error("❌ خطأ أثناء تلخيص Gemini:", item.url, err.message);
    return null;
  }
}

async function buildV3() {
  console.log("🚀 Building NOVALINK knowledge.v3.json with Gemini summaries ...");

  const urls = await loadUrls();
  const out = [];

  for (const url of urls) {
    const extra = EXTRA_PAGES.find((e) => canonical(e.url) === url);
    const baseItem = await extractBaseItem(url, extra?.category || null);
    if (!baseItem) continue;

    // Fallback: لو فشل Gemini → نستخدم excerpt
    let summary = await summarizeWithGemini(baseItem);
    if (!summary) summary = baseItem.excerpt;

    out.push({
      ...baseItem,
      summary
    });
  }

  out.sort(
    (a, b) =>
      weight(a.category) - weight(b.category) ||
      a.title.localeCompare(b.title, "ar")
  );

  fs.writeFileSync(OUTPUT_FILE_V3, JSON.stringify(out, null, 2), "utf8");

  console.log("✔ Saved:", OUTPUT_FILE_V3, "عدد العناصر:", out.length);
}

buildV3().catch((err) => {
  console.error("❌ فشل توليد V3:", err);
  process.exit(1);
});
