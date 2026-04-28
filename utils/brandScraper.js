const axios = require("axios");
const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function normalizeUrl(url) {
  try {
    if (!url) return null;
    const value = String(url).trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
      return new URL(value).toString();
    }

    return new URL(`https://${value}`).toString();
  } catch {
    return null;
  }
}

function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function toAbsoluteUrl(base, href) {
  try {
    if (!href) return null;

    const value = String(href).trim();
    if (!value) return null;

    if (
      value.startsWith("#") ||
      value.startsWith("mailto:") ||
      value.startsWith("tel:") ||
      value.startsWith("javascript:")
    ) {
      return null;
    }

    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function sameDomain(urlA, urlB) {
  try {
    const a = new URL(urlA).hostname.replace(/^www\./, "");
    const b = new URL(urlB).hostname.replace(/^www\./, "");
    return a === b;
  } catch {
    return false;
  }
}

function normalizePath(url) {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

async function fetchHtml(url) {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    return typeof response.data === "string" ? response.data : null;
  } catch {
    return null;
  }
}

function cleanText(text) {
  if (!text) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

function stripNonTextElements($root) {
  $root.find(
    "script, style, noscript, svg, iframe, img, picture, source, video, canvas, form, button, input"
  ).remove();
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  stripNonTextElements($.root());
  return cleanText($("body").text());
}

function extractMainContentFromHtml(html) {
  const $ = cheerio.load(html);

  const selectors = [
    "main article",
    "article",
    "main",
    "[role='main']",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".blog-post",
    ".blog-content",
    ".content",
    ".prose",
  ];

  for (const selector of selectors) {
    const node = $(selector).first();
    if (!node.length) continue;

    const clone = cheerio.load(`<div id="x"></div>`);
    clone("#x").append(node.clone());
    stripNonTextElements(clone("#x"));
    clone("#x").find("header, footer, nav, aside").remove();

    const text = cleanText(clone("#x").text());
    if (text && text.length > 200) {
      return text;
    }
  }

  return extractTextFromHtml(html);
}

function extractEmails(text) {
  const matches =
    String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((x) => x.toLowerCase()))];
}

function extractPhones(text) {
  const matches = String(text || "").match(/(\+?\d[\d\s().-]{7,}\d)/g) || [];
  return [...new Set(matches.map((x) => cleanText(x)))];
}

function extractSocialLinks(html, websiteUrl) {
  const $ = cheerio.load(html);
  const base = getBaseUrl(websiteUrl);

  const result = {
    instagram_url: null,
    youtube_url: null,
    linkedin_url: null,
    facebook_url: null,
    twitter_url: null,
  };

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = toAbsoluteUrl(base, href);
    if (!abs) return;

    const lower = abs.toLowerCase();

    if (!result.instagram_url && lower.includes("instagram.com")) {
      result.instagram_url = abs;
    }
    if (
      !result.youtube_url &&
      (lower.includes("youtube.com") || lower.includes("youtu.be"))
    ) {
      result.youtube_url = abs;
    }
    if (!result.linkedin_url && lower.includes("linkedin.com")) {
      result.linkedin_url = abs;
    }
    if (!result.facebook_url && lower.includes("facebook.com")) {
      result.facebook_url = abs;
    }
    if (
      !result.twitter_url &&
      (lower.includes("twitter.com") || lower.includes("x.com"))
    ) {
      result.twitter_url = abs;
    }
  });

  return result;
}

function pickEmail(emails, type) {
  if (!emails || !emails.length) return null;

  const priorities = {
    sales: ["sales@", "business@", "partnership", "bd@", "hello@"],
    support: ["support@", "help@", "care@", "service@", "customer@"],
    general: ["info@", "hello@", "contact@", "admin@"],
  };

  const rules = priorities[type] || [];
  for (const email of emails) {
    if (rules.some((rule) => email.includes(rule))) return email;
  }

  return type === "general" ? emails[0] : null;
}

function extractAddressHeuristic(text) {
  const parts = String(text || "")
    .split(/\. |\n| \| /)
    .map(cleanText)
    .filter(Boolean);

  const candidate = parts.find((line) =>
    /street|road|avenue|building|tower|suite|floor|city|state|country|postal|zip|india|usa|uk|china|singapore|uae|dubai|london|new york|california|maharashtra|karnataka/i.test(
      line
    )
  );

  return candidate || null;
}

function scoreLink(url, text, keywords = []) {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerText = String(text || "").toLowerCase();
  const path = normalizePath(url);

  let score = 0;

  for (const keyword of keywords) {
    if (path === `/${keyword}`) score += 8;
    if (lowerUrl.includes(`/${keyword}`)) score += 5;
    if (lowerUrl.includes(keyword)) score += 2;
    if (lowerText.includes(keyword)) score += 4;
  }

  if (path.split("/").length <= 4) score += 1;
  if (path === "/") score -= 5;

  return score;
}

function pickBestLink(candidates, keywords) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const ranked = candidates
    .map((item) => ({
      ...item,
      score: scoreLink(item.href, item.text, keywords),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.score > 0 ? ranked[0].href : null;
}

function discoverImportantLinks(html, websiteUrl) {
  const $ = cheerio.load(html);
  const base = getBaseUrl(websiteUrl);

  const pageSet = new Set([websiteUrl]);
  const candidates = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = toAbsoluteUrl(base, href);
    if (!abs) return;
    if (!sameDomain(abs, websiteUrl)) return;

    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const text = cleanText($(el).text());
    pageSet.add(abs);
    candidates.push({ href: abs, text });
  });

  return {
    about_page_url: pickBestLink(candidates, [
      "about",
      "about-us",
      "company",
      "our-story",
      "who-we-are",
    ]),
    contact_page_url: pickBestLink(candidates, [
      "contact",
      "contact-us",
      "support",
      "help",
      "reach-us",
    ]),
    blog_url: pickBestLink(candidates, [
      "blog",
      "blogs",
      "journal",
      "stories",
      "insights",
    ]),
    newsroom_url: pickBestLink(candidates, [
      "news",
      "newsroom",
      "media",
      "updates",
    ]),
    press_page_url: pickBestLink(candidates, [
      "press",
      "media-kit",
      "press-room",
    ]),
    resources_page_url: pickBestLink(candidates, [
      "resources",
      "learn",
      "guides",
      "articles",
    ]),
    case_studies_url: pickBestLink(candidates, [
      "case-study",
      "case-studies",
      "success-story",
      "success-stories",
    ]),
    webinars_url: pickBestLink(candidates, [
      "webinar",
      "webinars",
      "events",
    ]),
    faq_page_url: pickBestLink(candidates, ["faq", "faqs", "questions"]),
    help_center_url: pickBestLink(candidates, [
      "help-center",
      "support-center",
      "knowledge-base",
      "help",
    ]),
    discovered_pages: [...pageSet],
  };
}

function extractRecentContentTitles(html, pageUrl) {
  const $ = cheerio.load(html);
  const titles = [];
  const seen = new Set();

  const pushTitle = (value) => {
    const text = cleanText(value);
    if (!text) return;
    if (text.length < 8 || text.length > 180) return;

    const key = text.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    titles.push(text);
  };

  $(
    "article h1, article h2, article h3, h1, h2, h3, .post-title, .entry-title, .article-title, .blog-title"
  ).each((_, el) => pushTitle($(el).text()));

  $("a[href]").each((_, el) => {
    const href = toAbsoluteUrl(pageUrl, $(el).attr("href"));
    const text = $(el).text();
    if (!href || !sameDomain(href, pageUrl)) return;

    const lower = href.toLowerCase();
    if (
      lower.includes("/blog") ||
      lower.includes("/news") ||
      lower.includes("/article") ||
      lower.includes("/insight") ||
      lower.includes("/story") ||
      lower.includes("/press")
    ) {
      pushTitle(text);
    }
  });

  return titles.slice(0, 10);
}

async function scrapeBrandWebsite(websiteUrl) {
  const normalized = normalizeUrl(websiteUrl);
  if (!normalized) return null;

  const homeHtml = await fetchHtml(normalized);
  if (!homeHtml) return null;

  const important = discoverImportantLinks(homeHtml, normalized);
  const socials = extractSocialLinks(homeHtml, normalized);
  const base = getBaseUrl(normalized);

  const forcedContentUrls = [
    toAbsoluteUrl(base, "/blog"),
    toAbsoluteUrl(base, "/blogs"),
    toAbsoluteUrl(base, "/news"),
    toAbsoluteUrl(base, "/press"),
    toAbsoluteUrl(base, "/resources"),
    toAbsoluteUrl(base, "/insights"),
  ].filter(Boolean);

  const workingForcedContentUrls = [];
  for (const contentUrl of forcedContentUrls) {
    const html = await fetchHtml(contentUrl);
    if (html) {
      workingForcedContentUrls.push(contentUrl);
    }
  }

  const blogUrl =
    important.blog_url ||
    workingForcedContentUrls.find((url) => /\/blogs?(\/|$)/i.test(url)) ||
    null;

  const urlsToFetch = [
    normalized,
    important.about_page_url,
    important.contact_page_url,
    blogUrl,
    important.newsroom_url,
    important.press_page_url,
    important.resources_page_url,
    important.case_studies_url,
    important.webinars_url,
    important.faq_page_url,
    important.help_center_url,
    ...workingForcedContentUrls,
  ].filter(Boolean);

  const uniqueUrls = [...new Set(urlsToFetch)].slice(0, 10);

  let combinedText = "";
  let blogPageText = "";
  const titleBucket = [];

  for (const pageUrl of uniqueUrls) {
    const html = pageUrl === normalized ? homeHtml : await fetchHtml(pageUrl);
    if (!html) continue;

    const pageText = extractTextFromHtml(html);
    const titles = extractRecentContentTitles(html, pageUrl);

    if (pageText) {
      combinedText += `\n\n[PAGE: ${pageUrl}]\n${pageText}`;
    }

    if (blogUrl && pageUrl === blogUrl) {
      blogPageText = extractMainContentFromHtml(html);
    }

    if (titles.length) {
      titleBucket.push(...titles);
    }
  }

  combinedText = cleanText(combinedText);

  const emails = extractEmails(combinedText);
  const phones = extractPhones(combinedText);
  const recentTitles = [...new Set(titleBucket)].slice(0, 10);

  return {
    website_url: normalized,
    about_page_url: important.about_page_url,
    contact_page_url: important.contact_page_url,

    blog_url: blogUrl,
    newsroom_url:
      important.newsroom_url ||
      workingForcedContentUrls.find((url) =>
        /\/news(\/|$)|\/newsroom(\/|$)/i.test(url)
      ) ||
      null,
    press_page_url:
      important.press_page_url ||
      workingForcedContentUrls.find((url) => /\/press(\/|$)/i.test(url)) ||
      null,
    resources_page_url:
      important.resources_page_url ||
      workingForcedContentUrls.find((url) =>
        /\/resources(\/|$)|\/insights(\/|$)/i.test(url)
      ) ||
      null,
    case_studies_url: important.case_studies_url || null,
    webinars_url: important.webinars_url || null,
    faq_page_url: important.faq_page_url || null,
    help_center_url: important.help_center_url || null,

    recent_blog_titles: recentTitles.join(" | ") || null,
    blog_page_text: blogPageText ? blogPageText.slice(0, 20000) : null,

    general_email: pickEmail(emails, "general"),
    sales_email: pickEmail(emails, "sales"),
    support_email: pickEmail(emails, "support"),
    public_phone: phones[0] || null,
    public_address: extractAddressHeuristic(combinedText),

    website_pages_scraped: uniqueUrls,
    last_scraped_at: new Date(),
    raw_website_text: combinedText.slice(0, 25000),

    ...socials,
  };
}

module.exports = {
  scrapeBrandWebsite,
};