// --- Dependencies ---
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("./connection.js");
const { News, Subscriber } = require("./schema.js");
const jwt = require("jsonwebtoken");
const dns = require("dns");
const rateLimit = require("express-rate-limit");

dotenv.config();

// --- App Setup ---
const app = express();
const url = "https://geca.ac.in/";
const PORT = process.env.PORT || 4231;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- Middleware Order Matters ---
app.use(express.json()); // For JSON POST data (like spam.js)
app.use(bodyParser.urlencoded({ extended: true })); // For HTML form data
app.use(express.static("public"));

dns.setServers(["8.8.8.8"]);
function checkEmailDomain(email) {
  return new Promise((resolve, reject) => {
    const domain = email.split("@")[1];
    if (!domain) return reject("Invalid email format");
    dns.resolveMx(domain, (err, addresses) => {
      if (err || addresses.length === 0) {
        return reject("Domain cannot receive emails");
      }
      resolve("Domain is valid");
    });
  });
}

// --- Mail Transporter ---
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- DB Connection ---
(async () => {
  try {
    await connectDB();
  } catch (error) {
    console.error("Database connection failed:", error.message);
  }
})();

// --- View Engine ---
app.set("view engine", "ejs");

// --- Redirect Helper ---
function redirectWithMessage(res, message) {
  res.redirect("/?message=" + encodeURIComponent(message));
}

// --- Routes ---

app.get("/", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.render("index", {
      news,
      message: req.query.message,
      siteKey: process.env.RECAPTCHA_SITE_KEY,
    });
  } catch (e) {
    res.status(500).send("Failed to load news");
  }
});

app.get("/api/news", async (req, res) => {
  try {
    const news = await News.find().lean();
    res.send(news);
  } catch (e) {
    res.status(500).json({ message: "Failed to load news" });
  }
});

app.get("/api/sends", async (req, res) => {
  try {
    const sends = await Subscriber.find().lean();
    res.send(sends);
  } catch (e) {
    res.status(500).json({ message: "Failed to load subscribers" });
  }
});

app.get("/unsubscribe", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Missing token.");
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your_jwt_secret"
    );
    await Subscriber.deleteOne({ email: decoded.email });
    redirectWithMessage(res, "You are unsubscribed successfully!");
  } catch {
    redirectWithMessage(res, "Invalid or expired token.");
  }
});

app.get("/verify-email", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Missing token.");
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "your_jwt_secret"
    );
    const email = decoded.email;
    const user = await Subscriber.findOne({ email });
    if (user) return redirectWithMessage(res, "You are already subscribed!");

    await new Subscriber({ email }).save();

    const unsubscribeToken = jwt.sign(
      { email },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "15m" }
    );
    const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "🎉 Welcome to GECA News Updates!",
      text: `Hi there,\nYou're now subscribed to GECA News Updates.\nTo unsubscribe: ${unsubscribeLink}\n\nRegards,\nGECA News Team`,
    };
    await transporter.sendMail(mailOptions);
    redirectWithMessage(res, "Subscription successful!");
  } catch {
    redirectWithMessage(res, "Invalid or expired token.");
  }
});

app.post("/subscribe", async (req, res) => {
  const email = req.body.email;
  const captchaToken = req.body["g-recaptcha-response"];

  if (!captchaToken)
    return redirectWithMessage(res, "Please complete the CAPTCHA.");
  if (!email) return redirectWithMessage(res, "Email is required");

  try {
    const existing = await Subscriber.findOne({ email });
    if (existing)
      return redirectWithMessage(res, "You are already subscribed!");

    const verifyURL = "https://www.google.com/recaptcha/api/siteverify";
    const params = new URLSearchParams({
      secret: process.env.RECAPTCHA_SECRET_KEY,
      response: captchaToken,
    });
    const { data } = await axios.post(verifyURL, params);
    if (!data.success)
      return redirectWithMessage(res, "reCAPTCHA verification failed.");

    await checkEmailDomain(email);

    const token = jwt.sign(
      { email },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "15m" }
    );
    const verificationLink = `${BASE_URL}/verify-email?token=${token}`;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Verify your subscription to GECA News Updates 📧",
      text: `Click to verify: ${verificationLink}\n\nValid for 15 minutes.`,
    };
    await transporter.sendMail(mailOptions);

    redirectWithMessage(
      res,
      "Verification link sent! Check your inbox or spam."
    );
  } catch (err) {
    console.error("Subscription error:", err.message);
    redirectWithMessage(res, "Subscription failed. Try again later.");
  }
});

// --- Scraper + Emailer ---
async function checkForNewNews() {
  console.log("Checking for new news...");
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const newsItems = [];
    $("ul.scrollNews li a").each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href").trim();
      const fullLink = new URL(href, url).href;
      newsItems.push({ title, link: fullLink });
    });

    const existingLinks = new Set(
      (await News.find({}, "link").lean()).map((n) => n.link)
    );
    const newNews = newsItems.filter((n) => !existingLinks.has(n.link));
    if (!newNews.length) return;

    await News.deleteMany({});
    await News.insertMany(newsItems);

    const subs = await Subscriber.find({}, "email").lean();
    for (const { email } of subs) {
      const unsubscribeToken = jwt.sign(
        { email },
        process.env.JWT_SECRET || "your_jwt_secret",
        { expiresIn: "15m" }
      );
      const unsubscribeLink = `${BASE_URL}/unsubscribe?token=${unsubscribeToken}`;
      const body =
        newNews.map((n, i) => `${i + 1}. ${n.title}\n${n.link}`).join("\n\n") +
        `\n\nTo unsubscribe: ${unsubscribeLink}`;

      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "GECA News Update 📰",
          text: body,
        });
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err.message);
      }
    }
  } catch (err) {
    console.error("News scraping failed:", err.message);
  }
}

// --- Cron Job (Every 3 min) ---
cron.schedule("*/3 * * * *", checkForNewNews);

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL}`);
});
