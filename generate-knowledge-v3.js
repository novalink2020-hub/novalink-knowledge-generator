// generate-knowledge-v3.js
// NOVALINK Ai – Knowledge Generator V3 (Stable)
// Node.js 20 – Modern fetch + Clean HTML Extractor

import fs from "fs";
import * as cheerio from "cheerio";

// =========================
// الإعدادات الأساسية
// =========================

const DOMAIN = "https://novalink-ai.com";
const SITEMAP_URL = `${DOMAIN}/sitemap.xml`;
const OUTPUT_FILE = "./knowledge.v3.json";

// صفحات إضافية لضمان وجودها
const EXTRA_PAGES = [
  { url: DOMAIN + "/", category: "home" },
  { url: DOMAIN + "/services-khdmat-nwfa-lynk", category: "services" },
];

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
    .filter((w) => w.length >= 3)
    .slice(0, 20);

  return Array.from(new Set([...base, category]));
}

// =========================
// قراءة السايت ماب
// =========================

async function loadSitemap() {
  const xml = await fetch(SITEMAP_URL).then((r) => r.text());
  return Array.from(xml.matchAll(/<loc>(.*?)<\/loc>/g)).map((m) => m[1]);
}

// =========================
// استخراج صفحة واحدة
// =========================

async function scrape(url, forcedCategory = null) {
  try {
    const html = await fetch(url).then((r) => r.text());
    const $ = cheerio.load(html);

    const title =
      cleanText($('meta[property="og:title"]').attr("content")) ||
      cleanText($("title").text()) ||
      cleanText($("h1").first().text());

    if (!title || title.length < 5) return null;

    let desc =
      cleanText($('meta[name="description"]').attr("content")) ||
      cleanText($('meta[property="og:description"]').attr("content")) ||
      "";

    let excerpt = "";
    $("p, h2, h3, li").each((_, el) => {
      if (!excerpt) {
        const t = cleanText($(el).text());
        if (t.length >= 50) excerpt = t;
      }
    });

    if (!excerpt) excerpt = desc.substring(0, 200);

    const category = forcedCategory || extractCategory(url);
    const keywords = extractKeywords(title, desc, category);

    return {
      title,
      url,
      description: desc || excerpt,
      excerpt,
      category,
      keywords,
    };
  } catch {
    return null;
  }
}

// =========================
// بناء المعرفة
// =========================

async function build() {
  console.log("🚀 Generating knowledge.v3.json...");

  const urls = await loadSitemap();

  EXTRA_PAGES.forEach((p) => {
    if (!urls.includes(p.url)) urls.push(p.url);
  });

  const items = [];

  for (const url of urls) {
    const forced = EXTRA_PAGES.find((p) => p.url === url)?.category || null;
    const obj = await scrape(url, forced);
    if (obj) items.push(obj);
  }

  items.sort((a, b) => a.title.localeCompare(b.title, "ar"));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), "utf8");

  console.log("✔ Done! File created:", OUTPUT_FILE);
}

build();
